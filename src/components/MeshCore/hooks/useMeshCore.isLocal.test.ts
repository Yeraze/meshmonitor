/**
 * @vitest-environment jsdom
 *
 * useMeshCore — client-side `isLocal` re-stamp (#4438 §4.4, T-C3).
 *
 * The server already sets `isLocal` on the synthetic local-node contact
 * row. But `useMeshCore` merges snapshot contacts and live push-event
 * contacts into one `contactsRef` map keyed by `publicKey`
 * (loadSnapshot / onContactUpdated / refreshContacts). A
 * `meshcore:contact:updated` push for the local node's OWN public key
 * OVERWRITES that row — and the manager never sets `isLocal` on push
 * events for real device contacts (P4 in the epic follow-up spec) — so
 * without a client-side re-stamp, the local node's flag is silently
 * dropped the moment a push event for its own key arrives.
 *
 * This test simulates exactly that: load a snapshot containing the
 * (correctly flagged) local row, then deliver a contact:updated push for
 * the SAME public key with no `isLocal` field at all — the shape a real
 * device-contact push always has — and asserts the merged contact still
 * reports `isLocal === true`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => (globalThis as any).fetch,
}));

vi.mock('../../../contexts/MapContext', () => ({
  useMapContext: () => ({ setMeshCoreNodes: vi.fn() }),
}));

// useMeshCore now calls useToast() (#4547 Phase 2 WP1, reportTxDisabled) —
// mock it so this hook-only render doesn't need a real ToastProvider ancestor.
vi.mock('../../ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

/** Minimal fake Socket.io client: records handlers by event name and lets
 *  the test fire them directly, exactly like a real push event arriving. */
function createFakeSocket() {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const on = (event: string, handler: (...args: any[]) => void) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(handler);
  };
  const off = (event: string, handler: (...args: any[]) => void) => {
    handlers.get(event)?.delete(handler);
  };
  const trigger = (event: string, ...args: any[]) => {
    for (const h of handlers.get(event) ?? []) h(...args);
  };
  return {
    connected: true,
    on,
    off,
    emit: vi.fn(),
    io: { on: vi.fn(), off: vi.fn() },
    trigger,
  };
}

const fakeSocket = createFakeSocket();
vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ state: { socket: fakeSocket } }),
}));

import { useMeshCore } from './useMeshCore';

const LOCAL_PK = 'a'.repeat(64);
const SOURCE_ID = 'src-1';

function snapshotResponse() {
  return {
    success: true,
    data: {
      status: {
        connected: true,
        deviceType: 1,
        deviceTypeName: 'Companion',
        config: null,
        localNode: { publicKey: LOCAL_PK, name: 'Me', advType: 1 },
      },
      contacts: [
        {
          publicKey: LOCAL_PK,
          advName: 'Me (local)',
          name: 'Me',
          latitude: 10,
          longitude: 20,
          advType: 1,
          lastSeen: 1000,
          isLocal: true,
        },
      ],
      nodes: [],
      messages: [],
      seqCursor: 0,
    },
  };
}

describe('useMeshCore — isLocal re-stamp on push-event overwrite (#4438 T-C3)', () => {
  beforeEach(() => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      json: async () => snapshotResponse(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps isLocal true after a contact:updated push for the same public key omits it', async () => {
    const { result } = renderHook(() =>
      useMeshCore({ baseUrl: '', sourceId: SOURCE_ID, enabled: true }),
    );

    await waitFor(() => expect(result.current.hasLoadedOnce).toBe(true));
    expect(result.current.contacts.find(c => c.publicKey === LOCAL_PK)?.isLocal).toBe(true);

    // A real device-contact push for the local node's own key — the manager
    // never sets `isLocal` on these (P4), so this shape has no such field.
    act(() => {
      fakeSocket.trigger('meshcore:contact:updated', {
        sourceId: SOURCE_ID,
        contact: {
          publicKey: LOCAL_PK,
          advName: 'Me',
          name: 'Me',
          latitude: 10,
          longitude: 20,
          advType: 1,
          lastSeen: 2000,
        },
      });
    });

    expect(result.current.contacts.find(c => c.publicKey === LOCAL_PK)?.isLocal).toBe(true);
  });
});
