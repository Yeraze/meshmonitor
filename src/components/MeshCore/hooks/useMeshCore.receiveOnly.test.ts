/**
 * @vitest-environment jsdom
 *
 * useMeshCore — `reportTxDisabled` 409 toast wiring (#4547 Phase 2 WP1, §3.3).
 *
 * Every MeshCore TX-primitive action funnels through this hook, so one
 * helper (`reportTxDisabled`) covers every consumer and every second render
 * path. When a server call fails with the Phase 1 409 (`TX_DISABLED`), the
 * helper raises a single warning toast and the action still resolves to its
 * normal failure value (never throws). A non-409 failure must NOT raise the
 * toast — it takes the existing inline-error path unchanged.
 *
 * Modeled on useMeshCore.isLocal.test.ts for the mock shape (csrfFetch,
 * MapContext, WebSocketContext).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const showToast = vi.fn();

vi.mock('../../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => (globalThis as any).fetch,
}));

vi.mock('../../../contexts/MapContext', () => ({
  useMapContext: () => ({ setMeshCoreNodes: vi.fn() }),
}));

vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ state: { socket: { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn(), io: { on: vi.fn(), off: vi.fn() } } } }),
}));

vi.mock('../../ToastContainer', () => ({
  useToast: () => ({ showToast }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

import { useMeshCore } from './useMeshCore';

const LOCAL_PK = 'a'.repeat(64);
const CONTACT_PK = 'b'.repeat(64);
const SOURCE_ID = 'src-1';

function snapshotResponse() {
  return {
    success: true,
    data: {
      status: { connected: true, deviceType: 1, deviceTypeName: 'Companion', config: null, localNode: { publicKey: LOCAL_PK, name: 'Me', advType: 1 } },
      contacts: [],
      nodes: [],
      messages: [],
      seqCursor: 0,
    },
  };
}

const TX_DISABLED_BODY = { success: false, code: 'TX_DISABLED', error: 'Transmit is disabled on this source' };
const GENERIC_FAILURE_BODY = { success: false, code: 'SOME_OTHER_ERROR', error: 'boom' };

/** One entry per action §3.3 requires `reportTxDisabled` wired into. */
const PATCHED_ACTIONS: Array<{
  name: string;
  invoke: (actions: ReturnType<typeof useMeshCore>['actions']) => Promise<unknown>;
}> = [
  { name: 'resetContactPath', invoke: a => a.resetContactPath(CONTACT_PK) },
  { name: 'discoverContactPath', invoke: a => a.discoverContactPath(CONTACT_PK) },
  { name: 'discoverNodes', invoke: a => a.discoverNodes('nearby') },
  { name: 'discoverRegions', invoke: a => a.discoverRegions() },
  { name: 'loginRemote', invoke: a => a.loginRemote(CONTACT_PK, 'pw') },
  { name: 'sendCliCommand', invoke: a => a.sendCliCommand(CONTACT_PK, 'ver') },
  { name: 'sendLocalCliCommand', invoke: a => a.sendLocalCliCommand('ver') },
  { name: 'loginRemoteWithSaved', invoke: a => a.loginRemoteWithSaved(CONTACT_PK) },
  { name: 'getRemoteStatus', invoke: a => a.getRemoteStatus(CONTACT_PK) },
  { name: 'shareContact', invoke: a => a.shareContact(CONTACT_PK) },
  { name: 'traceContactPath', invoke: a => a.traceContactPath(CONTACT_PK) },
  { name: 'pingContactZeroHop', invoke: a => a.pingContactZeroHop(CONTACT_PK) },
  { name: 'getNeighbours', invoke: a => a.getNeighbours(CONTACT_PK) },
  { name: 'sendAdvert', invoke: a => a.sendAdvert() },
  { name: 'sendMessage', invoke: a => a.sendMessage('hello', CONTACT_PK) },
  { name: 'sendRoomPost', invoke: a => a.sendRoomPost(CONTACT_PK, 'hello') },
  { name: 'loginRoom', invoke: a => a.loginRoom(CONTACT_PK, 'pw') },
  { name: 'loginRoomWithSaved', invoke: a => a.loginRoomWithSaved(CONTACT_PK) },
];

async function renderConnectedHook() {
  const { result } = renderHook(() => useMeshCore({ baseUrl: '', sourceId: SOURCE_ID, enabled: true }));
  await waitFor(() => expect(result.current.hasLoadedOnce).toBe(true));
  return result;
}

describe('useMeshCore — reportTxDisabled 409 toast (#4547 Phase 2 WP1)', () => {
  beforeEach(() => {
    showToast.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('409 TX_DISABLED response', () => {
    beforeEach(() => {
      (globalThis as any).fetch = vi.fn().mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/snapshot')) {
          return { ok: true, status: 200, json: async () => snapshotResponse() };
        }
        return { ok: false, status: 409, json: async () => TX_DISABLED_BODY };
      });
    });

    it.each(PATCHED_ACTIONS)('$name resolves without throwing and raises exactly one blocked-toast warning', async ({ invoke }) => {
      const result = await renderConnectedHook();
      showToast.mockClear();

      // Resolving (rather than rejecting) is itself part of the assertion —
      // every action catches its own fetch/parse errors, so a TX_DISABLED
      // 409 must surface as a normal failure value, never a thrown error.
      await invoke(result.current.actions);

      expect(showToast).toHaveBeenCalledTimes(1);
      expect(showToast).toHaveBeenCalledWith(
        'Receive-only mode is on for this MeshCore source — nothing was sent.',
        'warning',
      );
    });
  });

  describe('non-409 failure', () => {
    beforeEach(() => {
      (globalThis as any).fetch = vi.fn().mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/snapshot')) {
          return { ok: true, status: 200, json: async () => snapshotResponse() };
        }
        return { ok: false, status: 500, json: async () => GENERIC_FAILURE_BODY };
      });
    });

    it.each(PATCHED_ACTIONS)('$name does not raise the receive-only toast on a non-409 failure', async ({ invoke }) => {
      const result = await renderConnectedHook();
      showToast.mockClear();

      await invoke(result.current.actions);

      expect(showToast).not.toHaveBeenCalled();
    });
  });
});
