/**
 * Regression tests for the MeshCore node list collapsing to a single node.
 *
 * Symptom: with two MeshCore sources, one showed ~95 nodes and the other only
 * 1, even though the DB held all of both sources' `meshcore_nodes` rows.
 *
 * Two independent bugs combined to produce it:
 *   1. `refreshContacts()` cleared the in-memory contact map on ANY successful
 *      `get_contacts` response, including a transient empty one — wiping the
 *      known list until adverts slowly refilled it.
 *   2. `getAllNodes()` served only the in-memory map, so a momentarily-empty
 *      map collapsed the served list to just the local node.
 *
 * The fix makes `getAllNodes()` merge durable per-source `meshcore_nodes` rows
 * with the live in-memory contacts, and stops `refreshContacts()` from wiping
 * on an empty response.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getNodesBySource = vi.fn();
const upsertNode = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      getNodesBySource: (...args: unknown[]) => getNodesBySource(...args),
      upsertNode: (...args: unknown[]) => upsertNode(...args),
    },
    sources: {
      getSource: vi.fn().mockResolvedValue({ name: 'Source A' }),
    },
  },
}));

vi.mock('./services/notificationService.js', () => ({
  notificationService: {
    notifyNewMeshCoreNode: vi.fn().mockResolvedValue(undefined),
  },
}));

// Any emit accessed by the contact handlers resolves to a no-op spy.
vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: new Proxy({}, { get: () => vi.fn() }),
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

interface BridgeEvent {
  event_type: string;
  data: Record<string, unknown>;
}

function dispatchBridgeEvent(m: MeshCoreManager, evt: BridgeEvent): void {
  // @ts-expect-error - exercising the private contact-event path directly
  m.handleBridgeEvent(evt);
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);
const KEY_LOCAL = 'd'.repeat(64);

describe('MeshCoreManager.getAllNodes (node-list-collapses-to-1 regression)', () => {
  beforeEach(() => {
    getNodesBySource.mockReset();
    getNodesBySource.mockResolvedValue([]);
    upsertNode.mockClear();
  });

  it('serves persisted per-source nodes even when the in-memory contact map is empty', async () => {
    getNodesBySource.mockResolvedValue([
      { publicKey: KEY_B, name: 'Node B', advType: MeshCoreDeviceType.REPEATER, rssi: -80, snr: 5, latitude: 1, longitude: 2, isLocalNode: false, lastHeard: 1_700_000 },
      { publicKey: KEY_C, name: 'Node C', advType: MeshCoreDeviceType.COMPANION, isLocalNode: false },
    ]);

    const m = new MeshCoreManager('src-a');
    const nodes = await m.getAllNodes();

    expect(getNodesBySource).toHaveBeenCalledWith('src-a');
    expect(nodes.map((n) => n.publicKey).sort()).toEqual([KEY_B, KEY_C].sort());
    expect(nodes.find((n) => n.publicKey === KEY_B)).toMatchObject({
      name: 'Node B',
      rssi: -80,
      snr: 5,
    });
  });

  it('overlays live in-memory contacts over persisted rows without duplicating, preserving DB-only fields', async () => {
    // Persisted (stale) row carries battery; in-memory advert carries a fresher name.
    getNodesBySource.mockResolvedValue([
      { publicKey: KEY_B, name: 'Stale Name', advType: MeshCoreDeviceType.REPEATER, rssi: -95, batteryMv: 4010, isLocalNode: false },
    ]);

    const m = new MeshCoreManager('src-a');
    dispatchBridgeEvent(m, {
      event_type: 'contact_advertised',
      data: { public_key: KEY_B, adv_name: 'Fresh Name', adv_type: MeshCoreDeviceType.REPEATER },
    });
    await flushMicrotasks();

    const nodes = await m.getAllNodes();
    const matches = nodes.filter((n) => n.publicKey === KEY_B);

    expect(matches).toHaveLength(1); // deduped across DB + memory
    expect(matches[0].name).toBe('Fresh Name'); // in-memory wins
    expect(matches[0].batteryMv).toBe(4010); // DB-only field preserved through the merge
  });

  it('lists the live local node first, merges its persisted batteryMv, and does not duplicate its row (#3884)', async () => {
    getNodesBySource.mockResolvedValue([
      { publicKey: KEY_LOCAL, name: 'Me (stale)', advType: MeshCoreDeviceType.COMPANION, isLocalNode: true, batteryMv: 3900 },
      { publicKey: KEY_B, name: 'Node B', advType: MeshCoreDeviceType.REPEATER, isLocalNode: false },
    ]);

    const m = new MeshCoreManager('src-a');
    // @ts-expect-error - seed the live local node directly, as `get_self_info`
    // would (no battery field — that only ever lands via the telemetry poller).
    m.localNode = { publicKey: KEY_LOCAL, name: 'Me (live)', advType: MeshCoreDeviceType.COMPANION };

    const nodes = await m.getAllNodes();

    expect(nodes[0]).toMatchObject({ publicKey: KEY_LOCAL, name: 'Me (live)', batteryMv: 3900 });
    expect(nodes.filter((n) => n.publicKey === KEY_LOCAL)).toHaveLength(1);
  });

  it('falls back to in-memory contacts when the DB read throws', async () => {
    getNodesBySource.mockRejectedValue(new Error('db down'));

    const m = new MeshCoreManager('src-a');
    dispatchBridgeEvent(m, {
      event_type: 'contact_advertised',
      data: { public_key: KEY_B, adv_name: 'B', adv_type: MeshCoreDeviceType.REPEATER },
    });
    await flushMicrotasks();

    const nodes = await m.getAllNodes();
    expect(nodes.map((n) => n.publicKey)).toContain(KEY_B);
  });
});

describe('MeshCoreManager.refreshContacts (empty-response must not wipe)', () => {
  beforeEach(() => {
    getNodesBySource.mockReset();
    getNodesBySource.mockResolvedValue([]);
    upsertNode.mockClear();
  });

  it('does not clear known contacts when get_contacts returns a successful but empty list', async () => {
    const m = new MeshCoreManager('src-a');
    // @ts-expect-error - companion gate is required for refreshContacts to run
    m.deviceType = MeshCoreDeviceType.COMPANION;

    dispatchBridgeEvent(m, {
      event_type: 'contact_advertised',
      data: { public_key: KEY_B, adv_name: 'B', adv_type: MeshCoreDeviceType.REPEATER },
    });
    await flushMicrotasks();
    expect(m.getContacts()).toHaveLength(1);

    // @ts-expect-error - stub the private bridge call with an empty response
    m.sendBridgeCommand = vi.fn().mockResolvedValue({ success: true, data: [] });
    await m.refreshContacts();

    expect(m.getContacts()).toHaveLength(1);
    expect(m.getContact(KEY_B)?.advName).toBe('B');
  });

  it('still replaces the contact list when the device returns contacts', async () => {
    const m = new MeshCoreManager('src-a');
    // @ts-expect-error - companion gate
    m.deviceType = MeshCoreDeviceType.COMPANION;

    // @ts-expect-error - stub the private bridge call with a real contact
    m.sendBridgeCommand = vi.fn().mockResolvedValue({
      success: true,
      data: [{ public_key: KEY_C, adv_name: 'C', adv_type: MeshCoreDeviceType.COMPANION }],
    });
    await m.refreshContacts();

    expect(m.getContacts().map((c) => c.publicKey)).toEqual([KEY_C]);
  });
});
