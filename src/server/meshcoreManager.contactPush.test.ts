/**
 * #5502 — bulk "Push to radio", the auto-add toggle and the sync status.
 *
 *  - pushContactsToDevice: favourites first (newest lastHeard), then the rest
 *    by lastHeard; FREE slots only, never the eviction path; excludes the local
 *    node, unknown types and ignored / blocked nodes; unknown capacity pushes
 *    favourites only, one at a time.
 *  - setAutoAddContacts / getDeviceContactSyncStatus.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, PUSH_CONTACTS_CHUNK } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { MESHCORE_DEVICE_TABLE_FULL } from './meshcoreDeviceContactErrors.js';

const key = (b: string) => b.repeat(32);
const LOCAL = key('ee');

interface DbNode {
  publicKey: string;
  advType: number | null;
  isFavorite?: boolean;
  isLocalNode?: boolean;
  lastHeard?: number;
  name?: string;
}

interface Harness {
  manager: MeshCoreManager;
  calls: Array<{ cmd: string; params: Record<string, any> }>;
  device: { rows: string[]; maxContacts: number | undefined; refuseAfter?: number; evictOnAdd?: boolean };
}

function makeHarness(dbNodes: DbNode[], opts: { onDevice?: string[]; maxContacts?: number; ignored?: string[] } = {}): Harness {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: LOCAL, manualAddContacts: 1 };

  const device: Harness['device'] = {
    rows: [...(opts.onDevice ?? [])],
    maxContacts: 'maxContacts' in opts ? opts.maxContacts : 100,
  };
  const calls: Harness['calls'] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, any>) => {
    calls.push({ cmd, params });
    switch (cmd) {
      case 'get_contacts':
        return { id: '1', success: true, data: device.rows.map((pk) => ({ public_key: pk, adv_type: 1 })) };
      case 'device_query':
        return { id: '1', success: true, data: { max_contacts: device.maxContacts } };
      case 'add_contacts': {
        const results: Array<{ public_key: string; status: string }> = [];
        const evicted: string[] = [];
        let full = false;
        for (const c of params.contacts as Array<{ public_key: string }>) {
          if (full) { results.push({ public_key: c.public_key, status: 'not_attempted' }); continue; }
          if (device.refuseAfter !== undefined && device.rows.length >= device.refuseAfter) {
            full = true;
            results.push({ public_key: c.public_key, status: 'table_full' });
            continue;
          }
          if (device.evictOnAdd && device.rows.length > 0) evicted.push(device.rows.shift() as string);
          device.rows.push(c.public_key);
          results.push({ public_key: c.public_key, status: 'added' });
        }
        return { id: '1', success: true, data: { results, count: device.rows.length, evicted } };
      }
      case 'set_auto_add_contacts': {
        const next = params.enabled ? 0x06 : 0x07;
        return { id: '1', success: true, data: { manual_add_contacts: next, auto_add: params.enabled } };
      }
      case 'get_self_info':
        return { id: '1', success: true, data: { public_key: LOCAL, name: 'Me' } };
      default:
        return { id: '1', success: true, data: {} };
    }
  };

  vi.spyOn(databaseService.meshcore, 'getNodesBySource').mockResolvedValue(
    dbNodes.map((n) => ({ ...n, sourceId: 'test-source' })) as any,
  );
  vi.spyOn(databaseService.meshcore, 'upsertNode').mockResolvedValue(undefined as any);
  vi.spyOn(databaseService.meshcore, 'setNodeFavorite').mockResolvedValue(undefined as any);
  vi.spyOn(databaseService, 'getMeshCoreIgnoredNodesAsync').mockResolvedValue(
    (opts.ignored ?? []).map((publicKey) => ({ sourceId: 'test-source', publicKey, mode: 'ignore' })) as any,
  );
  return { manager: m, calls, device };
}

const pushedKeys = (h: Harness) =>
  h.calls.filter((c) => c.cmd === 'add_contacts').flatMap((c) => (c.params.contacts as any[]).map((x) => x.public_key));

describe('MeshCoreManager.pushContactsToDevice (#5502)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('pushes favourites first (newest first), then the rest by lastHeard', async () => {
    const h = makeHarness([
      { publicKey: key('01'), advType: 1, lastHeard: 100 },
      { publicKey: key('02'), advType: 2, lastHeard: 500 },
      { publicKey: key('03'), advType: 2, isFavorite: true, lastHeard: 50 },
      { publicKey: key('04'), advType: 3, isFavorite: true, lastHeard: 900 },
    ]);
    const r = await h.manager.pushContactsToDevice();
    expect(pushedKeys(h)).toEqual([key('04'), key('03'), key('02'), key('01')]);
    expect(r.status).toBe('done');
    if (r.status !== 'done') return;
    expect(r.added.map((a) => a.publicKey)).toEqual([key('04'), key('03'), key('02'), key('01')]);
    expect(r.freeSlotsBefore).toBe(100);
    expect(r.freeSlotsAfter).toBe(96);
    expect(r.notAddedNoRoom).toBe(0);
  });

  it('fills only the free slots and never asks the radio to evict', async () => {
    const onDevice = Array.from({ length: 8 }, (_, i) => key((0xa0 + i).toString(16)));
    const h = makeHarness(
      [
        { publicKey: key('01'), advType: 1, lastHeard: 100 },
        { publicKey: key('02'), advType: 1, lastHeard: 200 },
        { publicKey: key('03'), advType: 1, isFavorite: true, lastHeard: 1 },
      ],
      { onDevice, maxContacts: 10 },
    );
    const r = await h.manager.pushContactsToDevice();
    expect(pushedKeys(h)).toEqual([key('03'), key('02')]);
    expect(h.calls.some((c) => c.cmd === 'add_contact')).toBe(false);
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.freeSlotsBefore).toBe(2);
    expect(r.freeSlotsAfter).toBe(0);
    expect(r.notAddedNoRoom).toBe(1);
    expect(r.evicted).toEqual([]);
  });

  it('pushes nothing when the radio is full', async () => {
    const onDevice = Array.from({ length: 10 }, (_, i) => key((0xa0 + i).toString(16)));
    const h = makeHarness([{ publicKey: key('01'), advType: 1, isFavorite: true }], { onDevice, maxContacts: 10 });
    const r = await h.manager.pushContactsToDevice();
    expect(pushedKeys(h)).toEqual([]);
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.notAddedNoRoom).toBe(1);
    expect(r.freeSlotsBefore).toBe(0);
  });

  it('excludes the local node, nodes already on the radio, unknown types and ignored nodes', async () => {
    const h = makeHarness(
      [
        { publicKey: LOCAL, advType: 1 },
        { publicKey: key('05'), advType: 1, isLocalNode: true },
        { publicKey: key('01'), advType: 1 }, // on device
        { publicKey: key('02'), advType: null },
        { publicKey: key('03'), advType: 0 },
        { publicKey: key('04'), advType: 7 },
        { publicKey: key('06'), advType: 2 }, // ignored
        { publicKey: key('07'), advType: 2 },
      ],
      { onDevice: [key('01')], ignored: [key('06')] },
    );
    const r = await h.manager.pushContactsToDevice();
    expect(pushedKeys(h)).toEqual([key('07')]);
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.alreadyOnDevice).toBe(1);
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ publicKey: key('02'), reason: 'unknown_type' }),
        expect.objectContaining({ publicKey: key('03'), reason: 'unknown_type' }),
        expect.objectContaining({ publicKey: key('04'), reason: 'unknown_type' }),
        expect.objectContaining({ publicKey: key('06'), reason: 'ignored' }),
      ]),
    );
    expect(r.skipped).toHaveLength(4);
  });

  it('honours the limit', async () => {
    const h = makeHarness([
      { publicKey: key('01'), advType: 1, lastHeard: 3 },
      { publicKey: key('02'), advType: 1, lastHeard: 2 },
      { publicKey: key('03'), advType: 1, lastHeard: 1 },
    ]);
    const r = await h.manager.pushContactsToDevice({ limit: 2 });
    expect(pushedKeys(h)).toEqual([key('01'), key('02')]);
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.notAddedNoRoom).toBe(1);
  });

  it('with unknown capacity pushes favourites only, one per batch', async () => {
    const h = makeHarness(
      [
        { publicKey: key('01'), advType: 1, isFavorite: true, lastHeard: 1 },
        { publicKey: key('02'), advType: 1, isFavorite: true, lastHeard: 2 },
        { publicKey: key('03'), advType: 1, lastHeard: 3 },
      ],
      { maxContacts: undefined },
    );
    const r = await h.manager.pushContactsToDevice();
    const batches = h.calls.filter((c) => c.cmd === 'add_contacts');
    expect(batches).toHaveLength(2);
    expect(batches.every((b) => b.params.contacts.length === 1)).toBe(true);
    expect(pushedKeys(h)).toEqual([key('02'), key('01')]);
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.capacityKnown).toBe(false);
    expect(r.maxContacts).toBeNull();
    expect(r.freeSlotsBefore).toBeNull();
    expect(r.notAddedNoRoom).toBe(1);
  });

  it('with unknown capacity stops at the first eviction', async () => {
    const h = makeHarness(
      [
        { publicKey: key('01'), advType: 1, isFavorite: true, lastHeard: 2 },
        { publicKey: key('02'), advType: 1, isFavorite: true, lastHeard: 1 },
      ],
      { maxContacts: undefined, onDevice: [key('aa')] },
    );
    h.device.evictOnAdd = true;
    const r = await h.manager.pushContactsToDevice();
    expect(pushedKeys(h)).toEqual([key('01')]);
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.evicted).toEqual([key('aa')]);
    expect(r.notAddedNoRoom).toBe(1);
  });

  it('stops when the radio refuses with table-full', async () => {
    const h = makeHarness(
      [
        { publicKey: key('01'), advType: 1, lastHeard: 3 },
        { publicKey: key('02'), advType: 1, lastHeard: 2 },
        { publicKey: key('03'), advType: 1, lastHeard: 1 },
      ],
      { maxContacts: 10 },
    );
    h.device.refuseAfter = 1;
    const r = await h.manager.pushContactsToDevice();
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.added.map((a) => a.publicKey)).toEqual([key('01')]);
    expect(r.notAddedNoRoom).toBe(2);
  });

  it('splits a large push into batches', async () => {
    const nodes = Array.from({ length: PUSH_CONTACTS_CHUNK + 5 }, (_, i) => ({
      publicKey: (i + 1).toString(16).padStart(2, '0').repeat(32),
      advType: 1,
      lastHeard: 1000 - i,
    }));
    const h = makeHarness(nodes, { maxContacts: 500 });
    const r = await h.manager.pushContactsToDevice();
    const batches = h.calls.filter((c) => c.cmd === 'add_contacts');
    expect(batches.map((b) => b.params.contacts.length)).toEqual([PUSH_CONTACTS_CHUNK, 5]);
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.added).toHaveLength(PUSH_CONTACTS_CHUNK + 5);
  });

  it('reports a failed batch', async () => {
    const h = makeHarness([{ publicKey: key('01'), advType: 1 }]);
    const orig = (h.manager as any).sendBridgeCommand;
    (h.manager as any).sendBridgeCommand = async (cmd: string, params: any) =>
      cmd === 'add_contacts' ? { id: '1', success: false, error: MESHCORE_DEVICE_TABLE_FULL } : orig(cmd, params);
    const r = await h.manager.pushContactsToDevice();
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.error).toBe(MESHCORE_DEVICE_TABLE_FULL);
    expect(r.skipped).toEqual([expect.objectContaining({ publicKey: key('01'), reason: 'failed' })]);
  });

  it('is unavailable when not a connected companion, and single-flight', async () => {
    const h = makeHarness([{ publicKey: key('01'), advType: 1 }]);
    (h.manager as any).connected = false;
    expect(await h.manager.pushContactsToDevice()).toEqual({ status: 'unavailable' });
    (h.manager as any).connected = true;
    const first = h.manager.pushContactsToDevice();
    expect(await h.manager.pushContactsToDevice()).toEqual({ status: 'busy' });
    expect((await first).status).toBe('done');
  });
});

describe('MeshCoreManager auto-add + sync status (#5502)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('setAutoAddContacts sends set_auto_add_contacts and records the new byte', async () => {
    const h = makeHarness([]);
    const r = await h.manager.setAutoAddContacts(true);
    expect(h.calls.find((c) => c.cmd === 'set_auto_add_contacts')?.params).toEqual({ enabled: true });
    expect(r).toEqual({ ok: true, manualAddContacts: 0x06, autoAddEnabled: true });
    expect(h.manager.getLocalNode()?.manualAddContacts).toBe(0x06);
    // The sync status the Settings page reads reflects the write at once.
    const status = await h.manager.getDeviceContactSyncStatus();
    expect(status.manualAddContacts).toBe(0x06);
    expect(status.autoAddEnabled).toBe(true);
  });

  it('setAutoAddContacts refuses without a connected companion', async () => {
    const h = makeHarness([]);
    (h.manager as any).connected = false;
    const r = await h.manager.setAutoAddContacts(false);
    expect(r.ok).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it('getDeviceContactSyncStatus lists favourites the radio lacks and reads bit 0', async () => {
    const h = makeHarness([
      { publicKey: key('01'), advType: 1, isFavorite: true, name: 'On radio' },
      { publicKey: key('02'), advType: 1, isFavorite: true, name: 'Missing' },
      { publicKey: key('03'), advType: 1, name: 'Not a favourite' },
      { publicKey: LOCAL, advType: 1, isFavorite: true, isLocalNode: true },
    ]);
    (h.manager as any).contacts.set(key('01'), { publicKey: key('01'), onDevice: true });
    (h.manager as any).contacts.set(key('02'), { publicKey: key('02'), onDevice: false });
    (h.manager as any).deviceContactsKnown = true;
    const s = await h.manager.getDeviceContactSyncStatus();
    expect(s.deviceContactsKnown).toBe(true);
    expect(s.available).toBe(true);
    expect(s.manualAddContacts).toBe(1);
    expect(s.autoAddEnabled).toBe(false);
    expect(s.missingFavorites).toEqual([{ publicKey: key('02'), name: 'Missing' }]);
    expect(s.deviceContactCount).toBe(1);
  });

  it('getDeviceContactSyncStatus claims nothing missing before the radio list is read', async () => {
    // The device read timed out and the list was seeded from the DB: onDevice
    // is unknown, so a favourite must not be reported as missing.
    const h = makeHarness([
      { publicKey: key('02'), advType: 1, isFavorite: true, name: 'Unknown' },
    ]);
    (h.manager as any).contacts.set(key('02'), { publicKey: key('02') });
    (h.manager as any).deviceContactsKnown = false;
    const s = await h.manager.getDeviceContactSyncStatus();
    expect(s.deviceContactsKnown).toBe(false);
    expect(s.missingFavorites).toEqual([]);
  });

  it('getDeviceContactSyncStatus reports auto-add unknown before SelfInfo', async () => {
    const h = makeHarness([]);
    (h.manager as any).localNode = null;
    const s = await h.manager.getDeviceContactSyncStatus();
    expect(s.autoAddEnabled).toBeNull();
    expect(s.manualAddContacts).toBeNull();
  });
});
