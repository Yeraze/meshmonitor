/**
 * P7a (#6254): MeshCoreManager.removeContactsBulk (Security tab dead-contact
 * delete) and the own-key tracker hook.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { meshcoreOwnIdentityTracker } from './services/meshcoreOwnIdentityTracker.js';
import { serverEventNotificationService } from './services/serverEventNotificationService.js';

const key = (b: string) => b.repeat(32);

function makeManager(opts: { failRemove?: string[]; type?: MeshCoreDeviceType; connected?: boolean } = {}) {
  const m = new MeshCoreManager('src-a', 'Source A');
  (m as any).deviceType = opts.type ?? MeshCoreDeviceType.COMPANION;
  (m as any).connected = opts.connected ?? true;
  const calls: Array<{ cmd: string; params: Record<string, any> }> = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, any>) => {
    calls.push({ cmd, params });
    if (cmd === 'remove_contact' && opts.failRemove?.includes(params.public_key)) {
      return { id: '1', success: false, error: 'nope' };
    }
    return { id: '1', success: true, data: { ok: true } };
  };
  return { m, calls };
}

describe('MeshCoreManager.removeContactsBulk (P7a #6254)', () => {
  let deleteNode: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.restoreAllMocks();
    deleteNode = vi.spyOn(databaseService.meshcore, 'deleteNode').mockResolvedValue(true as any);
  });

  it('removes each key from the radio and the DB, deduping case-blind', async () => {
    const { m, calls } = makeManager();
    const r = await m.removeContactsBulk([key('aa'), key('bb'), key('AA')]);
    expect(r).toEqual({
      status: 'done', removedFromDevice: [key('aa'), key('bb')], removedLocalOnly: [], failed: [], total: 2,
    });
    expect(calls.filter((c) => c.cmd === 'remove_contact')).toHaveLength(2);
    expect(deleteNode).toHaveBeenCalledTimes(2);
  });

  it('falls back to a local-only delete for a key the radio refuses', async () => {
    const { m } = makeManager({ failRemove: [key('aa')] });
    const r = await m.removeContactsBulk([key('aa'), key('bb')]);
    expect(r).toMatchObject({ status: 'done', removedFromDevice: [key('bb')], removedLocalOnly: [key('aa')], failed: [] });
    expect(deleteNode).toHaveBeenCalledWith(key('aa'), 'src-a');
  });

  it('reports a key that cannot be removed anywhere as failed', async () => {
    const { m } = makeManager({ failRemove: [key('aa')] });
    deleteNode.mockRejectedValue(new Error('db down'));
    const r = await m.removeContactsBulk([key('aa')]);
    expect(r).toMatchObject({ status: 'done', removedFromDevice: [], removedLocalOnly: [], failed: [key('aa')] });
  });

  it('refuses a second run while one is in flight, then frees the guard', async () => {
    const { m } = makeManager();
    const first = m.removeContactsBulk([key('aa')]);
    expect(await m.removeContactsBulk([key('bb')])).toEqual({ status: 'busy' });
    expect((await first).status).toBe('done');
    expect((await m.removeContactsBulk([key('bb')])).status).toBe('done');
  });

  it('shares the guard with removeNonFavoriteContacts', async () => {
    const { m } = makeManager();
    (m as any).bulkRemoveInFlight = true;
    expect(await m.removeContactsBulk([key('aa')])).toEqual({ status: 'busy' });
  });

  it('is unavailable for a Repeater and for a disconnected Companion (caller does DB-only)', async () => {
    const rep = makeManager({ type: MeshCoreDeviceType.REPEATER });
    expect(await rep.m.removeContactsBulk([key('aa')])).toEqual({ status: 'unavailable' });
    const down = makeManager({ connected: false });
    expect(await down.m.removeContactsBulk([key('aa')])).toEqual({ status: 'unavailable' });
    expect(down.calls).toEqual([]);
    expect(deleteNode).not.toHaveBeenCalled();
  });

  it('frees the guard even when a key throws unexpectedly', async () => {
    const { m } = makeManager();
    (m as any).removeContact = async () => { throw new Error('boom'); };
    await expect(m.removeContactsBulk([key('aa')])).rejects.toThrow('boom');
    expect((m as any).bulkRemoveInFlight).toBe(false);
  });
});

describe('MeshCoreManager own-key hook (P7a #6254)', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  beforeEach(() => vi.restoreAllMocks());

  it('notifies once on a change and not on baseline / same', async () => {
    const m = new MeshCoreManager('src-a', 'Source A');
    const observe = vi.spyOn(meshcoreOwnIdentityTracker, 'observe');
    const getChange = vi.spyOn(meshcoreOwnIdentityTracker, 'getChange')
      .mockResolvedValue({ previousKey: A, currentKey: B, detectedAt: 1 });
    const notify = vi.spyOn(serverEventNotificationService, 'notifyOwnKeyChanged').mockResolvedValue(undefined);

    observe.mockResolvedValueOnce('baseline').mockResolvedValueOnce('same').mockResolvedValueOnce('changed');
    await (m as any).observeOwnIdentity(A);
    await (m as any).observeOwnIdentity(A);
    expect(notify).not.toHaveBeenCalled();
    await (m as any).observeOwnIdentity(B);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('src-a', 'Source A', A.slice(0, 8), B.slice(0, 8));
    expect(getChange).toHaveBeenCalledTimes(1);
  });

  it('swallows tracker failures', async () => {
    const m = new MeshCoreManager('src-a');
    vi.spyOn(meshcoreOwnIdentityTracker, 'observe').mockRejectedValue(new Error('db'));
    await expect((m as any).observeOwnIdentity(A)).resolves.toBeUndefined();
  });
});
