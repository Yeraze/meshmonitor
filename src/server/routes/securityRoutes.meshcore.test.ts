/**
 * Security routes — MeshCore + permission matrix (P7a #6254, WP2).
 *
 * Real session/auth/permission middleware and DB (createRouteTestApp); only the
 * source registry and the managers are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import securityRoutes from './securityRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { meshcoreOwnIdentityTracker } from '../services/meshcoreOwnIdentityTracker.js';

const h = vi.hoisted(() => ({ getManager: vi.fn(), getAllManagers: vi.fn().mockReturnValue([]) }));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: h.getManager, getAllManagers: h.getAllManagers },
}));
vi.mock('../services/duplicateKeySchedulerService.js', () => ({
  duplicateKeySchedulerService: { runScan: vi.fn(), getStatus: vi.fn() },
}));
vi.mock('../services/securityDigestService.js', () => ({
  securityDigestService: { sendDigest: vi.fn() },
}));

const pk = (c: string) => c.repeat(64);
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

describe('securityRoutes — MeshCore (P7a)', () => {
  let harness: RouteTestHarness;
  let src: string;
  let mcManager: Record<string, any>;
  let mtManager: Record<string, any>;

  const seed = async (key: string, over: Record<string, unknown> = {}) =>
    databaseService.meshcore.upsertNode({ publicKey: key, name: `n-${key.slice(0, 2)}`, advType: 1, lastHeard: NOW - 30 * DAY, ...over } as any, src);

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/api/security', securityRoutes) });
    src = harness.sourceA;
    await databaseService.settings.setSourceSetting(src, 'securityDeadNodeDays', '');
    for (const n of await databaseService.meshcore.getNodesBySource(src)) {
      await databaseService.meshcore.deleteNode(n.publicKey, src);
    }
    for (const i of await databaseService.meshcoreFilters.listIgnoredNodes(src)) {
      await databaseService.meshcoreFilters.removeIgnoredNode(src, i.publicKey);
    }
    mcManager = {
      sourceId: src,
      sourceType: 'meshcore',
      getLocalNode: () => ({ publicKey: pk('a') }),
      getContacts: () => [],
      removeContactsBulk: vi.fn(),
      forgetLocalContact: vi.fn().mockResolvedValue(true),
    };
    mtManager = {
      sourceId: harness.sourceB,
      sourceType: 'meshtastic_tcp',
      isNodeInDeviceDb: vi.fn().mockReturnValue(true),
      sendRemoveNode: vi.fn().mockResolvedValue(undefined),
    };
    h.getManager.mockImplementation((id: string) => (id === src ? mcManager : id === harness.sourceB ? mtManager : undefined));
  });
  afterEach(() => harness.cleanup());

  describe('GET /dead-nodes', () => {
    it('400s MISSING_SOURCE_ID without sourceId', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/api/security/dead-nodes');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_SOURCE_ID');
    });

    it('lists MeshCore dead nodes: seconds, never-heard in, local/ignored/favourite out, 14-day default', async () => {
      await seed(pk('1'), { lastHeard: NOW - 30 * DAY });
      await seed(pk('2'), { lastHeard: null });
      await seed(pk('3'), { lastHeard: NOW - 2 * DAY }); // fresh
      await seed(pk('a'), { lastHeard: NOW - 30 * DAY }); // local
      await seed(pk('4'), { lastHeard: NOW - 30 * DAY }); // ignored
      await seed(pk('5'), { lastHeard: NOW - 30 * DAY, isFavorite: true });
      await seed(pk('6'), { lastHeard: NOW - 30 * DAY }); // device favourite
      await seed(pk('7'), { lastHeard: NOW - 10 * DAY }); // inside 14d default
      await databaseService.meshcoreFilters.upsertIgnoredNode({ sourceId: src, publicKey: pk('4'), mode: 'ignore' } as any);
      mcManager.getContacts = () => [{ publicKey: pk('6'), deviceFavorite: true }, { publicKey: pk('1'), onDevice: true }];

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/security/dead-nodes?sourceId=${src}`);
      expect(res.status).toBe(200);
      expect(res.body.thresholdDays).toBe(14);
      const keys = res.body.nodes.map((n: any) => n.nodeKey).sort();
      expect(keys).toEqual([`mc:${pk('1')}`, `mc:${pk('2')}`].sort());
      const one = res.body.nodes.find((n: any) => n.publicKey === pk('1'));
      expect(one.protocol).toBe('meshcore');
      expect(one.inDeviceDb).toBe(true);
      expect(one.role).toBe(1);
      expect(one.lastHeard).toBe(Math.floor((NOW - 30 * DAY) / 1000));
      expect(res.body.nodes.find((n: any) => n.publicKey === pk('2')).lastHeard).toBeNull();
    });

    it('honours the per-source securityDeadNodeDays setting', async () => {
      await seed(pk('7'), { lastHeard: NOW - 10 * DAY });
      await databaseService.settings.setSourceSetting(src, 'securityDeadNodeDays', '5');
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/security/dead-nodes?sourceId=${src}`);
      expect(res.body.thresholdDays).toBe(5);
      expect(res.body.nodes).toHaveLength(1);
    });

    it('Meshtastic keeps its shape plus nodeKey/protocol, default 7 days', async () => {
      const nowSec = Math.floor(NOW / 1000);
      const spy = vi.spyOn(databaseService.nodes, 'getAllNodes').mockResolvedValue([
        { nodeNum: 111, nodeId: '!6f', longName: 'Old', shortName: 'O', hwModel: 1, lastHeard: nowSec - 8 * 86400, isIgnored: false },
        { nodeNum: 222, nodeId: '!de', longName: 'New', shortName: 'N', hwModel: 1, lastHeard: nowSec - 86400, isIgnored: false },
      ] as any);
      vi.spyOn(databaseService.settings, 'getLocalNodeNumForSource').mockResolvedValue('0');
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/security/dead-nodes?sourceId=${harness.sourceB}`);
      expect(spy).toHaveBeenCalledWith(harness.sourceB);
      expect(res.body.thresholdDays).toBe(7);
      expect(res.body.nodes).toEqual([
        expect.objectContaining({ nodeNum: 111, nodeKey: 'mt:111', protocol: 'meshtastic', inDeviceDb: true }),
      ]);
      spy.mockRestore();
    });
  });

  describe('POST /dead-nodes/bulk-delete', () => {
    const post = async (user: any, body: unknown) => (await harness.loginAs(user)).post('/api/security/dead-nodes/bulk-delete').send(body as object);

    it('Companion connected: uses removeContactsBulk, reports device vs local-only', async () => {
      mcManager.removeContactsBulk.mockResolvedValue({
        status: 'done', removedFromDevice: [pk('1')], removedLocalOnly: [pk('2')], failed: [pk('3')], total: 3,
      });
      const res = await post(harness.admin, { sourceId: src, nodeKeys: [`mc:${pk('1')}`, `mc:${pk('2')}`, `mc:${pk('3')}`] });
      expect(res.status).toBe(200);
      expect(mcManager.removeContactsBulk).toHaveBeenCalledWith([pk('1'), pk('2'), pk('3')]);
      expect(res.body.deletedCount).toBe(2);
      expect(res.body.results.find((r: any) => r.nodeKey === `mc:${pk('1')}`)).toMatchObject({ deleted: true, removedFromDevice: true });
      expect(res.body.results.find((r: any) => r.nodeKey === `mc:${pk('2')}`)).toMatchObject({ deleted: true, removedFromDevice: false });
      expect(res.body.results.find((r: any) => r.nodeKey === `mc:${pk('3')}`)).toMatchObject({ deleted: false });
    });

    it('unavailable (Repeater / disconnected / mqtt): DB-only via forgetLocalContact', async () => {
      mcManager.removeContactsBulk.mockResolvedValue({ status: 'unavailable' });
      const res = await post(harness.admin, { sourceId: src, nodeKeys: [`mc:${pk('1')}`] });
      expect(res.status).toBe(200);
      expect(mcManager.forgetLocalContact).toHaveBeenCalledWith(pk('1'));
      expect(res.body.results[0]).toMatchObject({ deleted: true, removedFromDevice: false });
    });

    it('meshcore_mqtt manager without bulk support is DB-only', async () => {
      delete mcManager.removeContactsBulk;
      mcManager.sourceType = 'meshcore_mqtt';
      const res = await post(harness.admin, { sourceId: src, nodeKeys: [pk('1').replace(/^/, 'mc:')] });
      expect(res.status).toBe(200);
      expect(mcManager.forgetLocalContact).toHaveBeenCalledWith(pk('1'));
    });

    it('busy → 409 BULK_REMOVE_BUSY', async () => {
      mcManager.removeContactsBulk.mockResolvedValue({ status: 'busy' });
      const res = await post(harness.admin, { sourceId: src, nodeKeys: [`mc:${pk('1')}`] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BULK_REMOVE_BUSY');
    });

    it('never deletes the local key or a favourite', async () => {
      await seed(pk('5'), { isFavorite: true });
      mcManager.removeContactsBulk.mockResolvedValue({ status: 'unavailable' });
      const res = await post(harness.admin, { sourceId: src, nodeKeys: [`mc:${pk('a')}`, `mc:${pk('5')}`] });
      expect(res.status).toBe(200);
      expect(res.body.deletedCount).toBe(0);
      expect(res.body.results.every((r: any) => r.error === 'PROTECTED')).toBe(true);
      expect(mcManager.forgetLocalContact).not.toHaveBeenCalled();
    });

    it('400s on a bad key, an empty list and more than 1000 keys', async () => {
      let res = await post(harness.admin, { sourceId: src, nodeKeys: ['mc:zz'] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_NODE_KEY');
      res = await post(harness.admin, { sourceId: src, nodeKeys: [`mt:5`] });
      expect(res.body.code).toBe('INVALID_NODE_KEY');
      res = await post(harness.admin, { sourceId: src, nodeKeys: [] });
      expect(res.body.code).toBe('INVALID_NODE_KEYS');
      res = await post(harness.admin, { sourceId: src, nodeKeys: Array.from({ length: 1001 }, (_, i) => `mc:${i.toString(16).padStart(64, '0')}`) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('TOO_MANY_KEYS');
      expect(mcManager.removeContactsBulk).not.toHaveBeenCalled();
    });

    it('400s MISSING_SOURCE_ID without sourceId', async () => {
      const res = await post(harness.admin, { nodeKeys: [`mc:${pk('1')}`] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_SOURCE_ID');
    });

    it('Meshtastic: nodeKeys and legacy nodeNums both work, with nodeKey in results', async () => {
      const del = vi.spyOn(databaseService, 'deleteNodeAsync').mockResolvedValue(undefined as any);
      const res = await post(harness.admin, { sourceId: harness.sourceB, nodeKeys: ['mt:10'], nodeNums: [11] });
      expect(res.status).toBe(200);
      expect(del).toHaveBeenCalledWith(10, harness.sourceB);
      expect(del).toHaveBeenCalledWith(11, harness.sourceB);
      expect(mtManager.sendRemoveNode).toHaveBeenCalledTimes(2);
      expect(res.body.results[0]).toMatchObject({ nodeKey: 'mt:10', nodeNum: 10, deleted: true, removedFromDevice: true });
      del.mockRestore();
    });

    describe('permission matrix (security:write AND nodes:write on the source)', () => {
      const cases: Array<[string, 'meshcore' | 'meshtastic']> = [['MeshCore', 'meshcore'], ['Meshtastic', 'meshtastic']];
      for (const [label, kind] of cases) {
        const sid = () => (kind === 'meshcore' ? src : harness.sourceB);
        const body = () => ({ sourceId: sid(), nodeKeys: [kind === 'meshcore' ? `mc:${pk('1')}` : 'mt:10'] });
        beforeEach(() => {
          mcManager.removeContactsBulk.mockResolvedValue({ status: 'unavailable' });
          vi.spyOn(databaseService, 'deleteNodeAsync').mockResolvedValue(undefined as any);
        });
        afterEach(() => vi.restoreAllMocks());

        it(`${label}: security:write alone is 403`, async () => {
          await harness.grant(harness.limited.id, 'security', 'read');
          await harness.grant(harness.limited.id, 'security', 'write');
          const res = await post(harness.limited, body());
          expect(res.status).toBe(403);
        });
        it(`${label}: nodes:write alone is 403`, async () => {
          await harness.grant(harness.limited.id, 'security', 'read');
          await harness.grant(harness.limited.id, 'nodes', 'write', sid());
          const res = await post(harness.limited, body());
          expect(res.status).toBe(403);
        });
        it(`${label}: nodes:write on a different source is 403`, async () => {
          await harness.grant(harness.limited.id, 'security', 'read');
          await harness.grant(harness.limited.id, 'security', 'write');
          await harness.grant(harness.limited.id, 'nodes', 'write', kind === 'meshcore' ? harness.sourceB : src);
          const res = await post(harness.limited, body());
          expect(res.status).toBe(403);
        });
        it(`${label}: both grants succeed`, async () => {
          await harness.grant(harness.limited.id, 'security', 'read');
          await harness.grant(harness.limited.id, 'security', 'write');
          await harness.grant(harness.limited.id, 'nodes', 'write', sid());
          const res = await post(harness.limited, body());
          expect(res.status).toBe(200);
        });
      }
    });
  });

  describe('GET /meshcore/findings', () => {
    it('returns collisions, signature failures, name reuse and own key', async () => {
      const a = 'ab' + '1'.repeat(62);
      const b = 'ab' + '2'.repeat(62);
      await seed(a, { advType: 2, name: 'R1', lastHeard: NOW - DAY });
      await seed(b, { advType: 2, name: 'R2', lastHeard: NOW - DAY });
      await seed(pk('c'), { name: 'Dup', firstHeard: NOW - 5 * DAY, advertSignatureVerified: false });
      await seed(pk('d'), { name: ' dup ', firstHeard: NOW - DAY, advertSignatureVerified: null });
      await meshcoreOwnIdentityTracker.observe(src, pk('e'));
      await meshcoreOwnIdentityTracker.observe(src, pk('f'));

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/security/meshcore/findings?sourceId=${src}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const d = res.body.data;
      expect(d.pathHashCollisions.width).toBe(1);
      expect(d.pathHashCollisions.countsByWidth).toEqual({ 1: 1, 2: 0, 3: 0 });
      expect(d.pathHashCollisions.groups).toHaveLength(1);
      expect(d.pathHashCollisions.groups[0].hash).toBe('ab');
      expect(d.pathHashCollisions.groups[0].nodes.map((n: any) => n.publicKey)).toEqual([a, b]);
      expect(d.signatureFailures.map((n: any) => n.publicKey)).toEqual([pk('c')]);
      expect(d.nameReuse).toHaveLength(1);
      expect(d.nameReuse[0].original.publicKey).toBe(pk('c'));
      expect(d.nameReuse[0].suspects.map((n: any) => n.publicKey)).toEqual([pk('d')]);
      expect(d.ownKey).toMatchObject({ currentKey: pk('f'), previousKey: pk('e'), pkiKeyMismatch: false });
      expect(typeof d.ownKey.detectedAt).toBe('number');
    });

    it('uses the source path-hash width', async () => {
      await databaseService.settings.setSourceSetting(src, 'meshcoreDefaultPathHashSize', '2');
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/security/meshcore/findings?sourceId=${src}`);
      expect(res.body.data.pathHashCollisions.width).toBe(2);
      await databaseService.settings.setSourceSetting(src, 'meshcoreDefaultPathHashSize', '');
    });

    it('non-MeshCore source → 400 INVALID_SOURCE_TYPE; missing sourceId → 400', async () => {
      const agent = await harness.loginAs(harness.admin);
      let res = await agent.get(`/api/security/meshcore/findings?sourceId=${harness.sourceB}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SOURCE_TYPE');
      res = await agent.get('/api/security/meshcore/findings');
      expect(res.body.code).toBe('MISSING_SOURCE_ID');
    });
  });

  describe('POST /own-key/acknowledge', () => {
    it('requires security:write', async () => {
      await harness.grant(harness.limited.id, 'security', 'read');
      const res = await (await harness.loginAs(harness.limited)).post('/api/security/own-key/acknowledge').send({ sourceId: src });
      expect(res.status).toBe(403);
    });

    it('clears the change record and keeps the baseline', async () => {
      await meshcoreOwnIdentityTracker.observe(src, pk('e'));
      await meshcoreOwnIdentityTracker.observe(src, pk('f'));
      await harness.grant(harness.limited.id, 'security', 'read');
      await harness.grant(harness.limited.id, 'security', 'write');
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/api/security/own-key/acknowledge').send({ sourceId: src });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { acknowledged: true } });
      expect(await meshcoreOwnIdentityTracker.getChange(src)).toBeNull();
      expect(await meshcoreOwnIdentityTracker.getCurrentKey(src)).toBe(pk('f'));
    });

    it('400s without sourceId and for non-MeshCore sources', async () => {
      const agent = await harness.loginAs(harness.admin);
      let res = await agent.post('/api/security/own-key/acknowledge').send({});
      expect(res.body.code).toBe('MISSING_SOURCE_ID');
      res = await agent.post('/api/security/own-key/acknowledge').send({ sourceId: harness.sourceB });
      expect(res.body.code).toBe('INVALID_SOURCE_TYPE');
    });
  });
});
