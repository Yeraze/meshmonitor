/**
 * @vitest-environment jsdom
 *
 * useMeshCore.traceContactPath — timeout outcome (#5588).
 *
 * The server answers a trace that ran out its wait with
 * 504 MESHCORE_TRACE_TIMEOUT and the time waited. The hook hands that to the
 * caller as `{ timedOut, waitMs }` and makes one request, never a second.
 *
 * Mock shape follows useMeshCore.receiveOnly.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => (globalThis as any).fetch,
}));

vi.mock('../../../contexts/MapContext', () => ({
  useMapContext: () => ({ setMeshCoreNodes: vi.fn() }),
}));

vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ state: { socket: { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn(), io: { on: vi.fn(), off: vi.fn() } } } }),
}));

// Stable reference: a fresh fn per render would re-run the hook's effects forever.
const showToast = vi.fn();
vi.mock('../../ToastContainer', () => ({
  useToast: () => ({ showToast }),
}));

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

import { useMeshCore } from './useMeshCore';

const LOCAL_PK = 'a'.repeat(64);
const CONTACT_PK = 'b'.repeat(64);

const snapshot = {
  success: true,
  data: {
    status: { connected: true, deviceType: 1, deviceTypeName: 'Companion', config: null, localNode: { publicKey: LOCAL_PK, name: 'Me', advType: 1 } },
    contacts: [],
    nodes: [],
    messages: [],
    seqCursor: 0,
  },
};

function mockTraceResponse(status: number, body: Record<string, unknown>) {
  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('/snapshot')) {
      return { ok: true, status: 200, json: async () => snapshot };
    }
    return { ok: status < 400, status, json: async () => body };
  });
  (globalThis as any).fetch = fetchMock;
  const traceCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/trace-path'));
  return { traceCalls };
}

async function renderConnectedHook() {
  const { result } = renderHook(() => useMeshCore({ baseUrl: '', sourceId: 'src-1', enabled: true }));
  await waitFor(() => expect(result.current.hasLoadedOnce).toBe(true));
  return result;
}

describe('useMeshCore — traceContactPath timeout (#5588)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the timeout with the time waited and does not retry', async () => {
    const { traceCalls } = mockTraceResponse(504, {
      success: false, code: 'MESHCORE_TRACE_TIMEOUT', error: 'No reply to the trace within 11 s.',
      reason: 'timeout', waitMs: 11_000, suggestedTimeoutMs: 2_500,
    });
    const result = await renderConnectedHook();

    const outcome = await result.current.actions.traceContactPath(CONTACT_PK);

    expect(outcome).toEqual({ timedOut: true, waitMs: 11_000 });
    expect(traceCalls()).toHaveLength(1);
    // A timeout is shown beside the button, not as the page-level error.
    expect(result.current.error).toBeNull();
  });

  it('reports a null wait when the server sends none', async () => {
    mockTraceResponse(504, { success: false, code: 'MESHCORE_TRACE_TIMEOUT', error: 'No reply.' });
    const result = await renderConnectedHook();

    const outcome = await result.current.actions.traceContactPath(CONTACT_PK);
    expect(outcome).toEqual({ timedOut: true, waitMs: null });
  });

  it('keeps returning null for any other failure', async () => {
    const { traceCalls } = mockTraceResponse(409, { success: false, code: 'MESHCORE_TRACE_FAILED', error: 'Trace path failed' });
    const result = await renderConnectedHook();

    const outcome = await result.current.actions.traceContactPath(CONTACT_PK);
    expect(outcome).toBeNull();
    expect(traceCalls()).toHaveLength(1);
  });

  it('returns the hops on success', async () => {
    mockTraceResponse(200, { success: true, hops: [{ index: 0, snr: 5 }], lastSnr: 3, path: ['5e'] });
    const result = await renderConnectedHook();

    const outcome = await result.current.actions.traceContactPath(CONTACT_PK);
    expect(outcome).toEqual({ hops: [{ index: 0, snr: 5 }], lastSnr: 3, path: ['5e'] });
  });
});
