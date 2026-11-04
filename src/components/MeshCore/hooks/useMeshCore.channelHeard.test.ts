/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { fetchMock, mapNodes, handlers, socket } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => void>();
  return {
    fetchMock: vi.fn(), mapNodes: vi.fn(), handlers,
    socket: {
      connected: true,
      on: (event: string, fn: (...args: any[]) => void) => { handlers.set(event, fn); },
      off: (event: string) => { handlers.delete(event); },
      emit: vi.fn(), io: { on: vi.fn(), off: vi.fn() },
    },
  };
});
vi.mock('../../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => fetchMock }));
vi.mock('../../../contexts/MapContext', () => ({ useMapContext: () => ({ setMeshCoreNodes: mapNodes }) }));
vi.mock('../../../contexts/WebSocketContext', () => ({ useWebSocketContext: () => ({ state: { socket } }) }));
vi.mock('../../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
import { useMeshCore } from './useMeshCore';

const message = { id: 'sent-1', fromPublicKey: 'a'.repeat(64), toPublicKey: 'channel-1', text: 'test', timestamp: Date.now(), senderTimestamp: 123 };
const heardBy = [{ hash: 'ab', name: 'Repeater', snr: 3 }];
const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
const snapshot = (messages: unknown[]) => ({ status: { connected: true }, contacts: [], nodes: [], messages });
const emitHeard = (sourceId = 'src-a') => handlers.get('meshcore:channel-heard')!({ sourceId, id: message.id, heardBy });

beforeEach(() => { fetchMock.mockReset(); handlers.clear(); });

describe('channel relay confirmation races', () => {
  it('keeps a live confirmation when an older HTTP message response finishes later', async () => {
    let resolveMessages!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/snapshot')) return json(snapshot([message]));
      if (url.includes('/messages?')) return new Promise<Response>(resolve => { resolveMessages = resolve; });
      return json({});
    });
    const { result } = renderHook(() => useMeshCore({ baseUrl: '', sourceId: 'src-a' }));
    await waitFor(() => expect(result.current.hasLoadedOnce).toBe(true));
    let sending!: Promise<boolean>;
    act(() => { sending = result.current.actions.sendMessage('test', undefined, 1); });
    await waitFor(() => expect(resolveMessages).toBeTypeOf('function'));
    act(() => emitHeard());
    expect(result.current.messages[0].heardBy).toEqual(heardBy);
    await act(async () => { resolveMessages(json([message])); await sending; });
    expect(result.current.messages[0].heardBy).toEqual(heardBy);
  });

  it('retains a confirmation that arrives before the message is loaded', async () => {
    fetchMock.mockResolvedValue(json(snapshot([])));
    const { result } = renderHook(() => useMeshCore({ baseUrl: '', sourceId: 'src-a' }));
    await waitFor(() => expect(result.current.hasLoadedOnce).toBe(true));
    act(() => emitHeard());
    act(() => handlers.get('meshcore:message')!(message));
    expect(result.current.messages[0].heardBy).toEqual(heardBy);
  });

  it('ignores relay confirmations for another source', async () => {
    fetchMock.mockImplementation(async () => json(snapshot([message])));
    const { result } = renderHook(() => useMeshCore({ baseUrl: '', sourceId: 'src-a' }));
    await waitFor(() => expect(result.current.hasLoadedOnce).toBe(true));
    act(() => emitHeard('src-b'));
    expect(result.current.messages[0].heardBy).toBeUndefined();
  });
});
