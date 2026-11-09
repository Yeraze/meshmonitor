/**
 * Security routes — rates, clock offset, scanner, export, clear and digest for
 * both protocols (P7b #6281). Real session/auth/permission middleware and DB
 * (createRouteTestApp); only the registry, scheduler and digest service are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import securityRoutes from './securityRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { meshcoreOwnIdentityTracker } from '../services/meshcoreOwnIdentityTracker.js';

const h = vi.hoisted(() => ({
  getManager: vi.fn(),
  getAllManagers: vi.fn().mockReturnValue([]),
  runScan: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn(),
  sendDigest: vi.fn(),
}));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: h.getManager, getAllManagers: h.getAllManagers },
}));
vi.mock('../services/duplicateKeySchedulerService.js', () => ({
  duplicateKeySchedulerService: { runScan: h.runScan, getStatus: h.getStatus },
}));
vi.mock('../services/securityDigestService.js', () => ({
  securityDigestService: { sendDigest: h.sendDigest },
}));

const pk = (c: string) => c.repeat(64);
const NOW = Date.now();

describe('securityRoutes — P7b', () => {
  let harness: RouteTestHarness;
  let mc: string;
  let mt: string;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/api/security', securityRoutes) });
    mc = harness.sourceA;
    mt = harness.sourceB;
    for (const n of await databaseService.meshcore.getNodesBySource(mc)) {
      await databaseService.meshcore.deleteNode(n.publicKey, mc);
    }
    vi.spyOn(meshcoreOwnIdentityTracker, 'getChange').mockResolvedValue(null);
    vi.spyOn(meshcoreOwnIdentityTracker, 'getCurrentKey').mockResolvedValue(null);
    h.getManager.mockImplementation((id: string) =>
      id === mc
        ? { sourceId: mc, sourceType: 'meshcore' }
        : id === mt
          ? { sourceId: mt, sourceType: 'meshtastic_tcp' }
          : undefined,
    );
    h.getStatus.mockReturnValue({ scanningNow: false });
    h.runScan.mockClear();
    h.sendDigest.mockReset().mockResolvedValue({ success: true, message: 'ok' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    return harness.cleanup();
  });

  const seedMeshcore = async () => {
    await databaseService.meshcore.upsertNode({ publicKey: pk('1'), name: 'Chatty "Cat", the first', advType: 2, lastHeard: NOW }, mc);
    await databaseService.meshcore.upsertNode({ publicKey: pk('2'), name: 'Skewed', advType: 1, lastHeard: NOW }, mc);
    await databaseService.meshcore.upsertNode({ publicKey: pk('3'), name: 'Quiet', advType: 1, lastHeard: NOW }, mc);
    await databaseService.meshcore.setNodeSecurityFlags(mc, [
      { publicKey: pk('1'), isExcessivePackets: true, packetRatePerHour: 44, advertRatePerHour: 40, packetRateLastChecked: 1_700_000_000_000 },
      { publicKey: pk('2'), isTimeOffsetIssue: true, timeOffsetSeconds: 7200, timeOffsetSource: 'advert', timeOffsetCheckedAt: NOW },
    ]);
  };

  const seedMeshtastic = async () => {
    const nodeNum = 0x1234abcd;
    await databaseService.nodes.upsertNode(
      { nodeNum, nodeId: '!1234abcd', shortName: 'Spam', longName: 'Spammer, Inc', lastHeard: Math.floor(NOW / 1000) } as never,
      mt,
    );
    await databaseService.updateNodeSpamFlagsAsync(nodeNum, true, 77, Math.floor(NOW / 1000), mt);
    return nodeNum;
  };

  describe('GET /issues', () => {
    it('MeshCore shape: seconds units, stored top broadcasters, additive fields', async () => {
      await seedMeshcore();
      const res = await (await harness.loginAs(harness.admin)).get(`/api/security/issues?sourceId=${mc}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        protocol: 'meshcore',
        total: 2,
        excessivePacketsCount: 1,
        timeOffsetCount: 1,
        lowEntropyCount: 0,
        duplicateKeyCount: 0,
        thresholds: { packetsPerHour: 30, timeOffsetMinutes: 30 },
      });
      expect(typeof res.body.packetLogEnabled).toBe('boolean');
      const chatty = res.body.nodes.find((n: any) => n.nodeKey === `mc:${pk('1')}`);
      expect(chatty).toMatchObject({ packetRatePerHour: 44, advertRatePerHour: 40, packetRateLastChecked: 1_700_000_000, isExcessivePackets: true });
      const skewed = res.body.nodes.find((n: any) => n.nodeKey === `mc:${pk('2')}`);
      expect(skewed).toMatchObject({ timeOffsetSeconds: 7200, timeOffsetSource: 'advert' });
      expect(res.body.topBroadcasters).toEqual([expect.objectContaining({ nodeKey: `mc:${pk('1')}`, packetCount: 44 })]);
    });

    it('Meshtastic keeps the old wire fields and adds nodeKey/protocol', async () => {
      const nodeNum = await seedMeshtastic();
      const res = await (await harness.loginAs(harness.admin)).get(`/api/security/issues?sourceId=${mt}`);
      expect(res.status).toBe(200);
      for (const k of ['total', 'lowEntropyCount', 'duplicateKeyCount', 'excessivePacketsCount', 'timeOffsetCount', 'nodes', 'topBroadcasters']) {
        expect(res.body).toHaveProperty(k);
      }
      expect(res.body.excessivePacketsCount).toBe(1);
      const node = res.body.nodes.find((n: any) => n.nodeNum === nodeNum);
      expect(Object.keys(node)).toEqual(expect.arrayContaining([
        'nodeNum', 'shortName', 'longName', 'lastHeard', 'keyIsLowEntropy', 'duplicateKeyDetected', 'keySecurityIssueDetails',
        'publicKey', 'hwModel', 'isExcessivePackets', 'packetRatePerHour', 'packetRateLastChecked', 'isTimeOffsetIssue',
        'timeOffsetSeconds', 'nodeKey', 'protocol',
      ]));
      expect(node).toMatchObject({ nodeKey: `mt:${nodeNum}`, protocol: 'meshtastic', isExcessivePackets: true, packetRatePerHour: 77, shortName: 'Spam' });
      expect(res.body).not.toHaveProperty('packetLogEnabled');
    });
  });

  describe('permission matrix', () => {
    const cases: Array<[string, 'get' | 'post', () => string, () => object | undefined]> = [
      ['issues', 'get', () => `/api/security/issues?sourceId=${mc}`, () => undefined],
      ['export', 'get', () => `/api/security/export?sourceId=${mc}`, () => undefined],
      ['key-mismatches', 'get', () => `/api/security/key-mismatches?sourceId=${mc}`, () => undefined],
    ];
    it.each(cases)('%s needs nodes:read on the source, not just security:read', async (_n, method, url) => {
      await harness.grant(harness.limited.id, 'security', 'read');
      await harness.grant(harness.limited.id, 'nodes', 'read', mt); // wrong source
      const res = await (await harness.loginAs(harness.limited))[method](url());
      expect(res.status).toBe(403);
      await harness.grant(harness.limited.id, 'nodes', 'read', mc);
      const ok = await (await harness.loginAs(harness.limited))[method](url());
      expect(ok.status).toBe(200);
    });

    it('the Meshtastic reads are gated the same way', async () => {
      await harness.grant(harness.limited.id, 'security', 'read');
      const denied = await (await harness.loginAs(harness.limited)).get(`/api/security/issues?sourceId=${mt}`);
      expect(denied.status).toBe(403);
      await harness.grant(harness.limited.id, 'nodes', 'read', mt);
      expect((await (await harness.loginAs(harness.limited)).get(`/api/security/issues?sourceId=${mt}`)).status).toBe(200);
    });

    it('scan and clear need security:write and nodes:read on the source', async () => {
      await harness.grant(harness.limited.id, 'security', 'read');
      await harness.grant(harness.limited.id, 'security', 'write', mc);
      const scan = () => harness.loginAs(harness.limited).then(a => a.post('/api/security/scanner/scan').send({ sourceId: mc }));
      expect((await scan()).status).toBe(403);
      await harness.grant(harness.limited.id, 'nodes', 'read', mc);
      expect((await scan()).status).toBe(200);
      const clear = () =>
        harness.loginAs(harness.limited).then(a => a.post('/api/security/nodes/clear').send({ sourceId: mc, nodeKey: `mc:${pk('9')}` }));
      expect((await clear()).status).toBe(404); // authorised, node unknown
    });
  });

  describe('POST /scanner/scan', () => {
    it('accepts a MeshCore source and runs the scan for that source', async () => {
      const res = await (await harness.loginAs(harness.admin)).post('/api/security/scanner/scan').send({ sourceId: mc });
      expect(res.status).toBe(200);
      await new Promise(r => setImmediate(r));
      expect(h.runScan).toHaveBeenCalledWith(mc);
    });

    it('409s while a scan is running', async () => {
      h.getStatus.mockReturnValue({ scanningNow: true });
      const res = await (await harness.loginAs(harness.admin)).post('/api/security/scanner/scan').send({ sourceId: mc });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SCAN_IN_PROGRESS');
      expect(h.runScan).not.toHaveBeenCalled();
    });
  });

  describe('GET /export', () => {
    it('MeshCore CSV: own columns, spam/clock-only nodes, quotes/commas/newlines escaped', async () => {
      await seedMeshcore();
      const res = await (await harness.loginAs(harness.admin)).get(`/api/security/export?sourceId=${mc}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      const lines = res.text.split('\r\n');
      expect(lines[0]).toBe('Node Key,Name,Type,Last Heard,Excessive Packets,Packets per Hour,Adverts per Hour,Time Offset,Offset (seconds),Offset Source,Advert Signature Failed,Name Reused,Key Prefix');
      expect(res.text).toContain('"Chatty ""Cat"", the first"');
      expect(res.text).toContain(`mc:${pk('2')},Skewed,Companion`);
      expect(res.text).not.toContain('Quiet');
    });

    it('MeshCore JSON carries counts and nodes', async () => {
      await seedMeshcore();
      const res = await (await harness.loginAs(harness.admin)).get(`/api/security/export?sourceId=${mc}&format=json`);
      const body = JSON.parse(res.text);
      expect(body).toMatchObject({ protocol: 'meshcore', total: 2, excessivePacketsCount: 1, timeOffsetCount: 1 });
      expect(body.nodes[0]).toHaveProperty('advertRatePerHour');
    });

    it('Meshtastic CSV keeps its column order, appends new ones and now lists spam-only nodes', async () => {
      await seedMeshtastic();
      const res = await (await harness.loginAs(harness.admin)).get(`/api/security/export?sourceId=${mt}`);
      const lines = res.text.split('\r\n');
      expect(lines[0]).toBe('Node ID,Short Name,Long Name,Hardware Model,Last Heard,Low-Entropy Key,Duplicate Key,Time Offset,Offset (seconds),Issue Details,Key Hash Prefix,Excessive Packets,Packets per Hour');
      expect(lines[1]).toContain('!1234abcd,Spam,"Spammer, Inc"');
      expect(lines[1]).toMatch(/,Yes,77$/);
    });

    it('audit line names the source', async () => {
      const spy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined as never);
      await (await harness.loginAs(harness.admin)).get(`/api/security/export?sourceId=${mc}`);
      expect(spy).toHaveBeenCalledWith(expect.anything(), 'security_export', 'security', expect.stringContaining(mc), expect.anything());
    });
  });

  describe('POST /nodes/clear', () => {
    it('clears both flag sets on a MeshCore node', async () => {
      await seedMeshcore();
      await databaseService.meshcore.setNodeSecurityFlags(mc, [{ publicKey: pk('1'), isTimeOffsetIssue: true, timeOffsetSeconds: 5000 }]);
      const res = await (await harness.loginAs(harness.admin)).post('/api/security/nodes/clear').send({ sourceId: mc, nodeKey: `mc:${pk('1')}` });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const n = await databaseService.meshcore.getNodeByPublicKeyAndSource(pk('1'), mc);
      expect(Boolean(n?.isExcessivePackets)).toBe(false);
      expect(Boolean(n?.isTimeOffsetIssue)).toBe(false);
      expect(n?.packetRatePerHour).toBeNull();
      // another node's flags stay
      expect(Boolean((await databaseService.meshcore.getNodeByPublicKeyAndSource(pk('2'), mc))?.isTimeOffsetIssue)).toBe(true);
    });

    it('clears spam and offset on a Meshtastic node', async () => {
      const nodeNum = await seedMeshtastic();
      await databaseService.updateNodeTimeOffsetFlagsAsync(nodeNum, true, 4000, mt);
      const res = await (await harness.loginAs(harness.admin)).post('/api/security/nodes/clear').send({ sourceId: mt, nodeKey: `mt:${nodeNum}` });
      expect(res.status).toBe(200);
      const after = await (await harness.loginAs(harness.admin)).get(`/api/security/issues?sourceId=${mt}`);
      expect(after.body.nodes.find((n: any) => n.nodeNum === nodeNum)).toBeUndefined();
    });

    it('rejects a key of the wrong protocol and an unknown node', async () => {
      const a = await harness.loginAs(harness.admin);
      expect((await a.post('/api/security/nodes/clear').send({ sourceId: mc, nodeKey: 'mt:5' })).body.code).toBe('INVALID_NODE_KEY');
      expect((await a.post('/api/security/nodes/clear').send({ sourceId: mt, nodeKey: `mc:${pk('1')}` })).body.code).toBe('INVALID_NODE_KEY');
      expect((await a.post('/api/security/nodes/clear').send({ sourceId: mc, nodeKey: `mc:${pk('9')}` })).status).toBe(404);
      expect((await a.post('/api/security/nodes/clear').send({ nodeKey: 'mt:5' })).body.code).toBe('MISSING_SOURCE_ID');
    });
  });

  describe('POST /digest/send', () => {
    it('passes the sourceId through so only that source is dispatched', async () => {
      const res = await (await harness.loginAs(harness.admin)).post('/api/security/digest/send').send({ sourceId: mc });
      expect(res.status).toBe(200);
      expect(h.sendDigest).toHaveBeenCalledWith(mc);
    });

    it('reports a skipped result', async () => {
      h.sendDigest.mockResolvedValue({ success: true, skipped: true, message: `${mc}:skipped` });
      const res = await (await harness.loginAs(harness.admin)).post('/api/security/digest/send').send({ sourceId: mc });
      expect(res.body).toMatchObject({ success: true, skipped: true });
    });
  });
});
