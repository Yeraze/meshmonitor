/**
 * Tests for the per-node detail a discovery sweep now reports (#4516).
 *
 * `discoverNodes()` used to return only counts — "7 returned, 2 new" — which
 * told a user nothing about *which* nodes are in range, even though every
 * response carried the responder's type and a signal reading in both
 * directions. These tests pin the collected detail, the de-duplication of
 * repeat responses, and the fact that names are resolved when the burst is
 * reported rather than when each response arrives (a discovery response
 * carries no name at all).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const upsertNode = vi.fn().mockResolvedValue(undefined);
const getNodeByPublicKeyAndSource = vi.fn().mockResolvedValue(null);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: (...args: unknown[]) => upsertNode(...args),
      getNodeByPublicKeyAndSource: (...args: unknown[]) => getNodeByPublicKeyAndSource(...args),
    },
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreContactUpdated: vi.fn(),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreSelfInfoUpdated: vi.fn(),
  },
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

function dispatchDiscovered(m: MeshCoreManager, data: Record<string, unknown>): void {
  // @ts-expect-error - exercising private method
  m.handleBridgeEvent({ event_type: 'node_discovered', data });
}

function makeCompanionManager(): MeshCoreManager {
  const m = new MeshCoreManager('src-a');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).sendBridgeCommand = async () => ({ id: '1', success: true, data: {} });
  return m;
}

/**
 * Runs a sweep, dispatching responses inside the collection window.
 * `fetchNames` is left false so the ANON_REQ OWNER pass (which needs a live
 * device) stays out of the way — name resolution is covered via the contact
 * store instead.
 */
async function sweep(
  m: MeshCoreManager,
  responses: Array<Record<string, unknown>>,
) {
  const pending = m.discoverNodes(0x0c, 8000, false);
  // Let discoverNodes get past its bridge command and into the wait window.
  await Promise.resolve();
  await Promise.resolve();
  for (const r of responses) dispatchDiscovered(m, r);
  await vi.advanceTimersByTimeAsync(8100);
  return pending;
}

describe('MeshCoreManager — discovery results (#4516)', () => {
  beforeEach(() => {
    upsertNode.mockClear();
    getNodeByPublicKeyAndSource.mockClear();
    getNodeByPublicKeyAndSource.mockResolvedValue(null);
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('reports each responder with both SNR directions and a new-ness flag', async () => {
    const m = makeCompanionManager();
    const result = await sweep(m, [
      { public_key: KEY_A, adv_type: 2, snr: 6.25, snr_to_node: 4, rssi: -42 },
    ]);

    expect(result.returned).toBe(1);
    expect(result.newCount).toBe(1);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      publicKey: KEY_A,
      advType: 2,
      snr: 6.25,      // what we measured on their response
      snrToNode: 4,   // what they measured on our request
      rssi: -42,
      isNew: true,
    });
  });

  it('de-duplicates repeat responses from one node', async () => {
    // A node can answer more than once within the window; it is still one node.
    const m = makeCompanionManager();
    const result = await sweep(m, [
      { public_key: KEY_A, adv_type: 2, snr: 6, snr_to_node: 4 },
      { public_key: KEY_A, adv_type: 2, snr: 5, snr_to_node: 3 },
      { public_key: KEY_B, adv_type: 2, snr: 1, snr_to_node: 2 },
    ]);

    expect(result.returned).toBe(2);
    expect(result.nodes.map(n => n.publicKey)).toEqual([KEY_A, KEY_B]);
  });

  it('marks an already-known contact as not new', async () => {
    const m = makeCompanionManager();
    (m as any).contacts.set(KEY_A, { publicKey: KEY_A, advName: 'Yeraze Repeater', advType: 2 });

    const result = await sweep(m, [{ public_key: KEY_A, adv_type: 2, snr: 6, snr_to_node: 4 }]);

    expect(result.newCount).toBe(0);
    expect(result.nodes[0].isNew).toBe(false);
    // Name comes from the contact store — the response itself carries none.
    expect(result.nodes[0].name).toBe('Yeraze Repeater');
  });

  it('reports a null name rather than inventing one for a nameless responder', async () => {
    // A never-seen repeater that has not advertised has no name anywhere. The
    // UI needs to distinguish that from a real name, so it must not be ''.
    const m = makeCompanionManager();
    const result = await sweep(m, [{ public_key: KEY_B, adv_type: 2, snr: 6, snr_to_node: 4 }]);

    expect(result.nodes[0].name).toBeNull();
  });

  it('tolerates a response with no signal fields', async () => {
    // Older firmware, or a truncated frame the backend declined to parse:
    // absent readings must come through as null, not NaN or 0.
    const m = makeCompanionManager();
    const result = await sweep(m, [{ public_key: KEY_A, adv_type: 2 }]);

    expect(result.nodes[0].snr).toBeNull();
    expect(result.nodes[0].snrToNode).toBeNull();
    expect(result.nodes[0].rssi).toBeNull();
  });

  it('returns an empty list when nothing answers', async () => {
    const m = makeCompanionManager();
    const result = await sweep(m, []);

    expect(result.returned).toBe(0);
    expect(result.nodes).toEqual([]);
  });
});
