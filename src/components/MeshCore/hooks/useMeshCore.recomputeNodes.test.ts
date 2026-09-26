/**
 * @vitest-environment jsdom
 *
 * useMeshCore — node list must survive live pushes (#5349).
 *
 * The snapshot's `nodes` is the server's `getAllNodes()`: durable
 * meshcore_nodes rows merged with the live contacts. `contacts` is only the
 * companion's contact table. `recomputeNodes()` used to REBUILD `nodes` from
 * the local node + contacts on every `meshcore:contact:updated` /
 * `meshcore:local-node:updated` push, so every DB-only node vanished until a
 * page reload ("13 nodes, then 6, then 7"), and a contact push with no type
 * turned a known repeater into advType 0.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => (globalThis as any).fetch,
}));

vi.mock('../../../contexts/MapContext', () => ({
  useMapContext: () => ({ setMeshCoreNodes: vi.fn() }),
}));

vi.mock('../../ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

function createFakeSocket() {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  return {
    connected: true,
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      handlers.get(event)?.delete(handler);
    },
    emit: vi.fn(),
    io: { on: vi.fn(), off: vi.fn() },
    trigger: (event: string, ...args: any[]) => {
      for (const h of handlers.get(event) ?? []) h(...args);
    },
  };
}

const fakeSocket = createFakeSocket();
vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ state: { socket: fakeSocket } }),
}));

import { useMeshCore } from './useMeshCore';

const SOURCE_ID = 'src-1';
const LOCAL_PK = 'a'.repeat(64);
const key = (i: number) => `57${i.toString(16).padStart(2, '0')}` + 'b'.repeat(60);

// 12 remote nodes in the DB; only the first 5 are in the companion's table.
const DB_NODES = Array.from({ length: 12 }, (_, i) => ({
  publicKey: key(i),
  name: `Node ${i}`,
  advType: 2, // repeater
  lastHeard: 1_000 + i,
  batteryMv: 3_900 + i,
  isFavorite: i === 7,
}));
const DEVICE_CONTACTS = DB_NODES.slice(0, 5).map((n) => ({
  publicKey: n.publicKey,
  advName: n.name,
  advType: 2,
  lastSeen: 5_000,
}));

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
      contacts: DEVICE_CONTACTS,
      nodes: [{ publicKey: LOCAL_PK, name: 'Me', advType: 1 }, ...DB_NODES],
      messages: [],
      seqCursor: 0,
    },
  };
}

describe('useMeshCore — recomputeNodes keeps DB-only nodes (#5349)', () => {
  beforeEach(() => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      json: async () => snapshotResponse(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loaded() {
    const hook = renderHook(() =>
      useMeshCore({ baseUrl: '', sourceId: SOURCE_ID, enabled: true }),
    );
    await waitFor(() => expect(hook.result.current.hasLoadedOnce).toBe(true));
    expect(hook.result.current.nodes).toHaveLength(13);
    return hook;
  }

  it('keeps all 13 nodes after a contact push', async () => {
    const { result } = await loaded();

    act(() => {
      fakeSocket.trigger('meshcore:contact:updated', {
        sourceId: SOURCE_ID,
        contact: { publicKey: key(1), advName: 'Node 1', advType: 2, lastSeen: 9_000 },
      });
    });

    expect(result.current.nodes).toHaveLength(13);
    // A DB-only node (not in the device table) is still there, with its
    // DB-only fields intact.
    const dbOnly = result.current.nodes.find((n) => n.publicKey === key(7));
    expect(dbOnly).toMatchObject({ name: 'Node 7', advType: 2, batteryMv: 3_907, isFavorite: true });
    // The pushed contact's live fields win, DB-only fields survive.
    const pushed = result.current.nodes.find((n) => n.publicKey === key(1));
    expect(pushed).toMatchObject({ lastHeard: 9_000, batteryMv: 3_901 });
  });

  it('keeps all 13 nodes after a local-node push', async () => {
    const { result } = await loaded();

    act(() => {
      fakeSocket.trigger('meshcore:local-node:updated', {
        sourceId: SOURCE_ID,
        node: { publicKey: LOCAL_PK, name: 'Me renamed', advType: 1 },
      });
    });

    expect(result.current.nodes).toHaveLength(13);
    expect(result.current.nodes.find((n) => n.publicKey === LOCAL_PK)?.name).toBe('Me renamed');
  });

  it('adds a brand-new contact without dropping anything', async () => {
    const { result } = await loaded();
    const NEW = 'cc'.repeat(32);

    act(() => {
      fakeSocket.trigger('meshcore:contact:updated', {
        sourceId: SOURCE_ID,
        contact: { publicKey: NEW, advName: 'Fresh', advType: 1, lastSeen: 9_000 },
      });
    });

    expect(result.current.nodes).toHaveLength(14);
    expect(result.current.nodes.find((n) => n.publicKey === NEW)?.name).toBe('Fresh');
  });

  it('does not turn a known repeater into advType 0 when a push carries no type', async () => {
    const { result } = await loaded();

    act(() => {
      // A pubkey-only advert (firmware push 0x80) reaches the UI with no advType.
      fakeSocket.trigger('meshcore:contact:updated', {
        sourceId: SOURCE_ID,
        contact: { publicKey: key(9), lastSeen: 9_000 },
      });
    });

    const node = result.current.nodes.find((n) => n.publicKey === key(9));
    expect(node?.advType).toBe(2);
    expect(node?.name).toBe('Node 9');
  });
});
