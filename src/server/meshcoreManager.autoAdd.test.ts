/**
 * #5777 — auto-add options wrappers and the bulk "remove non-favourite
 * contacts" action, including per-source isolation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';

const key = (b: string) => b.repeat(32);

interface Row { pk: string; flags?: number }

function makeManager(
  sourceId: string,
  opts: { rows?: Row[]; appFavs?: string[]; failRemove?: string[]; type?: MeshCoreDeviceType } = {},
) {
  const m = new MeshCoreManager(sourceId);
  (m as any).deviceType = opts.type ?? MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).deviceContactsKnown = true;
  const calls: Array<{ cmd: string; params: Record<string, any> }> = [];
  const device = new Map((opts.rows ?? []).map((r) => [r.pk, r.flags ?? 0]));
  for (const r of opts.rows ?? []) {
    (m as any).contacts.set(r.pk, { publicKey: r.pk, onDevice: true, deviceFavorite: ((r.flags ?? 0) & 1) === 1 });
  }
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, any>) => {
    calls.push({ cmd, params });
    switch (cmd) {
      case 'get_contacts':
        return { id: '1', success: true, data: [...device].map(([public_key, flags]) => ({ public_key, flags })) };
      case 'remove_contact':
        if (opts.failRemove?.includes(params.public_key)) return { id: '1', success: false, error: 'nope' };
        device.delete(params.public_key);
        return { id: '1', success: true, data: { ok: true } };
      case 'get_autoadd_config':
        return { id: '1', success: true, data: { supported: true, overwrite_oldest: true, types: { chat: true, room: true }, max_hops: 4 } };
      case 'set_autoadd_config':
        return { id: '1', success: true, data: { supported: false } };
      default:
        return { id: '1', success: true, data: {} };
    }
  };
  return { m, calls, device };
}

let getNodes: ReturnType<typeof vi.spyOn>;
let deleteNode: ReturnType<typeof vi.spyOn>;

function dbFavs(bySource: Record<string, string[]>) {
  getNodes.mockImplementation((async (sourceId: string) =>
    (bySource[sourceId] ?? []).map((publicKey) => ({ publicKey, isFavorite: true, sourceId }))) as any);
}

describe('MeshCoreManager auto-add options (#5777)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getNodes = vi.spyOn(databaseService.meshcore, 'getNodesBySource');
    deleteNode = vi.spyOn(databaseService.meshcore, 'deleteNode').mockResolvedValue(true as any);
    dbFavs({});
  });

  it('getAutoAddConfig maps the bridge shape', async () => {
    const { m, calls } = makeManager('a');
    const r = await m.getAutoAddConfig();
    expect(calls[0].cmd).toBe('get_autoadd_config');
    expect(r).toEqual({
      ok: true,
      config: {
        supported: true,
        overwriteOldest: true,
        types: { chat: true, repeater: false, room: true, sensor: false },
        maxHops: 4,
      },
    });
  });

  it('setAutoAddConfig forwards only the given fields and reports unsupported', async () => {
    const { m, calls } = makeManager('a');
    const r = await m.setAutoAddConfig({ maxHops: 2 });
    expect(calls[0]).toEqual({
      cmd: 'set_autoadd_config',
      params: { overwrite_oldest: undefined, types: undefined, max_hops: 2 },
    });
    expect(r.ok && r.config.supported).toBe(false);
  });

  it('refuses a repeater source and a disconnected source', async () => {
    const rep = makeManager('r', { type: MeshCoreDeviceType.REPEATER });
    expect((await rep.m.getAutoAddConfig()).ok).toBe(false);
    expect((await rep.m.setAutoAddConfig({ maxHops: 1 })).ok).toBe(false);
    expect(await rep.m.removeNonFavoriteContacts()).toEqual({ status: 'unavailable' });
    const down = makeManager('d');
    (down.m as any).connected = false;
    const r = await down.m.getAutoAddConfig();
    expect(r.ok).toBe(false);
    expect(down.calls).toEqual([]);
  });
});

describe('MeshCoreManager.removeNonFavoriteContacts (#5777)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getNodes = vi.spyOn(databaseService.meshcore, 'getNodesBySource');
    deleteNode = vi.spyOn(databaseService.meshcore, 'deleteNode').mockResolvedValue(true as any);
    dbFavs({});
  });

  it('keeps a favourite from either side and removes the rest one at a time', async () => {
    dbFavs({ a: [key('02')] }); // favourite only in MeshMonitor
    const { m, calls, device } = makeManager('a', {
      rows: [
        { pk: key('01') },
        { pk: key('02') },
        { pk: key('03'), flags: 0x01 }, // favourite only on the radio
        { pk: key('04'), flags: 0x06 }, // other flag bits, NOT a favourite
      ],
    });
    const r = await m.removeNonFavoriteContacts();
    expect(r).toEqual({ status: 'done', removed: 2, kept: 2, failed: 0, total: 4 });
    expect(calls.filter((c) => c.cmd === 'remove_contact').map((c) => c.params.public_key)).toEqual([key('01'), key('04')]);
    expect([...device.keys()].sort()).toEqual([key('02'), key('03')]);
  });

  it('leaves MeshMonitor node rows alone and marks the contact off the radio', async () => {
    const { m } = makeManager('a', { rows: [{ pk: key('01') }] });
    const events: unknown[] = [];
    m.on('contact_removed', (e) => events.push(e));
    await m.removeNonFavoriteContacts();
    expect(deleteNode).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect((m as any).contacts.get(key('01'))).toMatchObject({ onDevice: false });
    expect((m as any).isContactTombstoned(key('01'))).toBe(false);
  });

  it('counts a refused removal as failed and keeps going', async () => {
    const { m } = makeManager('a', {
      rows: [{ pk: key('01') }, { pk: key('02') }],
      failRemove: [key('01')],
    });
    expect(await m.removeNonFavoriteContacts()).toEqual({ status: 'done', removed: 1, kept: 0, failed: 1, total: 2 });
  });

  it('refuses a second run while one is in flight', async () => {
    const { m } = makeManager('a', { rows: [{ pk: key('01') }] });
    const first = m.removeNonFavoriteContacts();
    expect(await m.removeNonFavoriteContacts()).toEqual({ status: 'busy' });
    expect((await first).status).toBe('done');
    expect((await m.removeNonFavoriteContacts()).status).toBe('done');
  });

  it('reports the preview counts in the sync status', async () => {
    dbFavs({ a: [key('02')] });
    const { m } = makeManager('a', {
      rows: [{ pk: key('01') }, { pk: key('02') }, { pk: key('03'), flags: 1 }],
    });
    const s = await m.getDeviceContactSyncStatus();
    expect(s.removableContactCount).toBe(1);
    expect(s.keptContactCount).toBe(2);
  });
});

describe('bulk remove is per-source (#5777)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getNodes = vi.spyOn(databaseService.meshcore, 'getNodesBySource');
    deleteNode = vi.spyOn(databaseService.meshcore, 'deleteNode').mockResolvedValue(true as any);
  });

  it('never touches another source\'s contacts or favourites', async () => {
    // key 01 is a favourite on source B only; source A must still remove its own copy.
    dbFavs({ b: [key('01')] });
    const a = makeManager('a', { rows: [{ pk: key('01') }, { pk: key('02') }] });
    const b = makeManager('b', { rows: [{ pk: key('01') }, { pk: key('03') }] });
    const r = await a.m.removeNonFavoriteContacts();
    expect(r).toMatchObject({ status: 'done', removed: 2, kept: 0 });
    expect(getNodes).toHaveBeenCalledWith('a');
    expect(getNodes).not.toHaveBeenCalledWith('b');
    expect(b.calls).toEqual([]);
    expect([...b.device.keys()].sort()).toEqual([key('01'), key('03')]);
    expect(deleteNode).not.toHaveBeenCalled();
  });
});
