/**
 * @vitest-environment jsdom
 *
 * useMeshCore.sendReaction / refreshStatus (#5762). The optimistic chip row goes
 * in at once, then the server row replaces it; a failure removes it and, bar a
 * duplicate, raises a toast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const showToast = vi.fn();
const setMeshCoreNodes = vi.fn();
const socket = { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn(), io: { on: vi.fn(), off: vi.fn() } };
const wsContext = { state: { socket } };
const mapContext = { setMeshCoreNodes };

vi.mock('../../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => (globalThis as any).fetch,
}));
vi.mock('../../../contexts/MapContext', () => ({
  useMapContext: () => mapContext,
}));
vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => wsContext,
}));
vi.mock('../../ToastContainer', () => ({
  useToast: () => ({ showToast }),
}));
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

import { useMeshCore, type MeshCoreMessage } from './useMeshCore';

const LOCAL_PK = 'a'.repeat(64);
const PEER_PK = 'b'.repeat(64);
const TARGET: MeshCoreMessage = {
  id: 'm-1',
  fromPublicKey: PEER_PK,
  fromName: 'Peer',
  toPublicKey: 'channel-0',
  text: 'hello',
  timestamp: 1_000,
  senderTimestamp: 1,
};
const SERVER_ROW: MeshCoreMessage = {
  id: 'srv-reaction',
  fromPublicKey: LOCAL_PK,
  toPublicKey: 'channel-0',
  text: '👍',
  timestamp: 2_000,
  reactionEmoji: '👍',
  reactionTargetId: 'm-1',
};

function snapshot() {
  return {
    success: true,
    data: {
      status: { connected: true, reactionsOutboundEnabled: true, deviceType: 1, deviceTypeName: 'Companion', config: null, localNode: { publicKey: LOCAL_PK, name: 'Me', advType: 1 } },
      contacts: [], nodes: [], messages: [TARGET], seqCursor: 0,
    },
  };
}

function mockFetch(reaction: () => Promise<any>) {
  (globalThis as any).fetch = vi.fn().mockImplementation(async (url: string) => {
    if (url.includes('/snapshot')) return { ok: true, status: 200, json: async () => snapshot() };
    if (url.includes('/reaction')) return reaction();
    if (url.endsWith('/status')) return { ok: true, status: 200, json: async () => ({ success: true, data: snapshot().data.status }) };
    return { ok: false, status: 500, json: async () => ({ success: false, error: 'unused' }) };
  });
}

async function setup() {
  const { result } = renderHook(() => useMeshCore({ baseUrl: '', sourceId: 'src-1', enabled: true }));
  await waitFor(() => expect(result.current.hasLoadedOnce).toBe(true));
  return result;
}

describe('useMeshCore.sendReaction (#5762)', () => {
  beforeEach(() => showToast.mockClear());
  afterEach(() => vi.restoreAllMocks());

  it('shows the optimistic row, then swaps in the server row', async () => {
    let release!: (v: any) => void;
    mockFetch(() => new Promise(r => { release = r; }));
    const result = await setup();

    let p!: Promise<boolean>;
    act(() => { p = result.current.actions.sendReaction(TARGET, '👍'); });
    await waitFor(() => expect(result.current.messages.some(m => m.reactionPending)).toBe(true));
    const pending = result.current.messages.find(m => m.reactionPending)!;
    expect(pending.reactionTargetId).toBe('m-1');
    expect(pending.fromPublicKey).toBe(LOCAL_PK);

    await act(async () => {
      release({ ok: true, status: 200, json: async () => ({ success: true, data: { message: SERVER_ROW } }) });
      await p;
    });
    expect(await p).toBe(true);
    expect(result.current.messages.some(m => m.reactionPending)).toBe(false);
    expect(result.current.messages.filter(m => m.id === 'srv-reaction')).toHaveLength(1);
    const call = (globalThis as any).fetch.mock.calls.find((c: any[]) => String(c[0]).includes('/reaction'));
    expect(call[0]).toContain('/messages/m-1/reaction');
    expect(JSON.parse(call[1].body)).toEqual({ emoji: '👍' });
  });

  it('removes the optimistic row and toasts the code text on failure', async () => {
    mockFetch(async () => ({ ok: false, status: 400, json: async () => ({ success: false, code: 'TARGET_NO_HASH', error: 'x' }) }));
    const result = await setup();
    let ok = true;
    await act(async () => { ok = await result.current.actions.sendReaction(TARGET, '👍'); });
    expect(ok).toBe(false);
    expect(result.current.messages.some(m => m.reactionPending)).toBe(false);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][1]).toBe('error');
  });

  it('raises no toast for DUPLICATE_REACTION', async () => {
    mockFetch(async () => ({ ok: false, status: 409, json: async () => ({ success: false, code: 'DUPLICATE_REACTION', error: 'dup', existingId: 'e' }) }));
    const result = await setup();
    await act(async () => { await result.current.actions.sendReaction(TARGET, '👍'); });
    expect(showToast).not.toHaveBeenCalled();
    expect(result.current.messages.some(m => m.reactionPending)).toBe(false);
  });

  it('uses the receive-only toast for 409 TX_DISABLED', async () => {
    mockFetch(async () => ({ ok: false, status: 409, json: async () => ({ success: false, code: 'TX_DISABLED', error: 'off' }) }));
    const result = await setup();
    await act(async () => { await result.current.actions.sendReaction(TARGET, '👍'); });
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][1]).toBe('warning');
  });

  it('refreshStatus re-reads the status and resolves connected', async () => {
    mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
    const result = await setup();
    let connected = false;
    await act(async () => { connected = await result.current.actions.refreshStatus(); });
    expect(connected).toBe(true);
    expect(result.current.status?.reactionsOutboundEnabled).toBe(true);
  });
});
