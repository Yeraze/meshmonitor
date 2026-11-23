/**
 * /api/nodes/timezone (#6523): read gate, position gate (which decides
 * between the node's zone and the server's), per-source write permission,
 * validation, and the MeshCore path. Real auth + real SQL via the harness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import nodeTimezoneRoutes from './nodeTimezoneRoutes.js';
import nodesRoutes from './nodesRoutes.js';
import databaseService from '../../services/database.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { loadAllNodesAsDeviceInfo } from '../utils/dbNodeMapper.js';
import { serverTimeZone } from '../utils/nodeTimezone.js';

const NODE_NUM = 0x6523a001;
const NODE_ID = '!6523a001';
// Chicago.
const LAT = 41.8781;
const LON = -87.6298;
// London.
const MC_KEY = 'cd'.repeat(32);
const MC_LAT = 51.507;
const MC_LON = -0.128;

const fakeManager = (sourceId: string): ISourceManager =>
  ({
    sourceId,
    sourceType: 'meshtastic_tcp',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ sourceId, sourceName: sourceId, sourceType: 'meshtastic_tcp', connected: true }),
    getLocalNodeInfo: vi.fn().mockReturnValue(null),
    getAllNodesAsync: vi.fn((id?: string) => loadAllNodesAsDeviceInfo(id)),
  }) as unknown as ISourceManager;

describe('node timezone routes', () => {
  let harness: RouteTestHarness;

  const url = (sourceId: string, nodeId = NODE_ID) =>
    `/nodes/timezone?sourceId=${sourceId}&nodeId=${encodeURIComponent(nodeId)}`;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: app => {
        app.use('/nodes/timezone', nodeTimezoneRoutes);
        app.use('/', nodesRoutes);
      },
    });
    await databaseService.nodes.upsertNode(
      { nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Clock', shortName: 'C', hwModel: 43, channel: 0, lastHeard: Math.floor(Date.now() / 1000), latitude: LAT, longitude: LON },
      harness.sourceA,
    );
    await databaseService.setNodePositionOverrideAsync(NODE_NUM, false, harness.sourceA, undefined, undefined, undefined, false);
    await databaseService.setNodeHideFromMapAsync(NODE_NUM, false, harness.sourceA);
    await databaseService.setNodeTimezoneOverrideAsync(NODE_NUM, harness.sourceA, null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  /** One permission row carrying several actions. */
  const give = async (resource: string, actions: Array<'read' | 'write' | 'viewOnMap'>, sourceId: string) => {
    await databaseService.auth.createPermission({
      userId: harness.limited.id,
      resource,
      canRead: actions.includes('read'),
      canWrite: actions.includes('write'),
      canViewOnMap: actions.includes('viewOnMap'),
      sourceId,
      grantedAt: Date.now(),
      grantedBy: null,
    } as never);
  };

  const giveViewer = async (sourceId = harness.sourceA) => {
    await give('info', ['read'], sourceId);
    await give('channel_0', ['read', 'viewOnMap'], sourceId);
  };

  it('gives a viewer who can see the position the zone at that position', async () => {
    await giveViewer();
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(url(harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { timeZone: 'America/Chicago', source: 'position' } });
  });

  it('a private position override hides the zone (server zone) without nodes_private:read', async () => {
    await giveViewer();
    // Tokyo, private.
    await databaseService.setNodePositionOverrideAsync(NODE_NUM, true, harness.sourceA, 35.68, 139.69, undefined, true);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).body.data).toEqual({ timeZone: serverTimeZone(), source: 'server' });
    await give('nodes_private', ['read'], harness.sourceA);
    expect((await agent.get(url(harness.sourceA))).body.data).toEqual({ timeZone: 'Asia/Tokyo', source: 'position' });
  });

  it('the Timezone Override wins for a viewer who passes the gate, and is hidden from one who does not', async () => {
    await giveViewer();
    await databaseService.setNodeTimezoneOverrideAsync(NODE_NUM, harness.sourceA, 'Europe/Berlin');
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).body.data).toEqual({ timeZone: 'Europe/Berlin', source: 'override' });

    await databaseService.setNodePositionOverrideAsync(NODE_NUM, true, harness.sourceA, LAT, LON, undefined, true);
    const hidden = await agent.get(url(harness.sourceA));
    expect(hidden.body.data).toEqual({ timeZone: serverTimeZone(), source: 'server' });
    expect(JSON.stringify(hidden.body)).not.toContain('Berlin');
  });

  it('a node hidden from the map still gets its zone (its graphs still show)', async () => {
    await giveViewer();
    await databaseService.setNodeHideFromMapAsync(NODE_NUM, true, harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).body.data.source).toBe('position');
  });

  it('a node with no position falls back to the server zone', async () => {
    const admin = await harness.loginAs(harness.admin);
    const id = '!6523a002';
    await databaseService.nodes.upsertNode({ nodeNum: 0x6523a002, nodeId: id, longName: 'NoGps', shortName: 'N', hwModel: 43, channel: 0 }, harness.sourceA);
    expect((await admin.get(url(harness.sourceA, id))).body.data).toEqual({ timeZone: serverTimeZone(), source: 'server' });
    // Unknown node: the server zone too, not an error.
    expect((await admin.get(url(harness.sourceA, '!6523a0ff'))).body.data.source).toBe('server');
  });

  it('403s without info/dashboard read, and a grant on another source opens nothing', async () => {
    await give('channel_0', ['read', 'viewOnMap'], harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).status).toBe(403);
    await harness.revokeAll(harness.limited.id);
    await giveViewer(harness.sourceB);
    const res = await agent.get(url(harness.sourceA));
    expect(res.status === 403 || res.body.data?.source === 'server').toBe(true);
  });

  it('validates sourceId and nodeId', async () => {
    const admin = await harness.loginAs(harness.admin);
    expect((await admin.get(`/nodes/timezone?nodeId=${encodeURIComponent(NODE_ID)}`)).status).toBe(400);
    expect((await admin.get(url(harness.sourceA, 'nope'))).status).toBe(400);
    // Unprefixed 8-hex is refused: the channel gate would read it as decimal
    // while the resolver reads hex, so the two would check different nodes.
    expect((await admin.get(url(harness.sourceA, NODE_ID.replace('!', '')))).body.code).toBe('INVALID_NODE_ID');
  });

  describe('PUT', () => {
    const put = (agent: Awaited<ReturnType<RouteTestHarness['loginAs']>>, body: Record<string, unknown>) =>
      agent.put('/nodes/timezone').send(body);

    it('needs nodes:write on THAT source; a grant on another source fails', async () => {
      await giveViewer();
      await give('nodes', ['read', 'write'], harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      expect((await put(agent, { sourceId: harness.sourceA, nodeId: NODE_ID, timeZone: 'Europe/Berlin' })).status).toBe(403);
      expect((await databaseService.nodes.getNode(NODE_NUM, harness.sourceA))?.timezoneOverride ?? null).toBeNull();

      await give('nodes', ['read', 'write'], harness.sourceA);
      const res = await put(agent, { sourceId: harness.sourceA, nodeId: NODE_ID, timeZone: 'europe/berlin' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { timeZone: 'Europe/Berlin', source: 'override' } });
      // Stored in the runtime's canonical spelling.
      expect((await databaseService.nodes.getNode(NODE_NUM, harness.sourceA))?.timezoneOverride).toBe('Europe/Berlin');

      const cleared = await put(agent, { sourceId: harness.sourceA, nodeId: NODE_ID, timeZone: null });
      expect(cleared.body.data).toEqual({ timeZone: 'America/Chicago', source: 'position' });
    });

    it('refuses anonymous callers', async () => {
      const anon = await harness.loginAs(null);
      const res = await put(anon, { sourceId: harness.sourceA, nodeId: NODE_ID, timeZone: 'UTC' });
      expect([401, 403]).toContain(res.status);
    });

    it('rejects a bad zone, a bad node id, a missing sourceId and an unknown node', async () => {
      const admin = await harness.loginAs(harness.admin);
      for (const timeZone of ['Mars/Olympus', '', 42, 'x'.repeat(65), undefined]) {
        const res = await put(admin, { sourceId: harness.sourceA, nodeId: NODE_ID, timeZone });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_TIMEZONE');
      }
      expect((await put(admin, { sourceId: harness.sourceA, nodeId: 'zz', timeZone: 'UTC' })).body.code).toBe('INVALID_NODE_ID');
      expect((await put(admin, { nodeId: NODE_ID, timeZone: 'UTC' })).status).toBe(400);
      const missing = await put(admin, { sourceId: harness.sourceB, nodeId: NODE_ID, timeZone: 'UTC' });
      expect(missing.status).toBe(404);
      expect(await put(admin, { sourceId: harness.sourceA, nodeId: NODE_ID, timeZone: 'UTC' })).toMatchObject({
        status: 200,
        body: { data: { timeZone: 'UTC', source: 'override' } },
      });
    });
  });

  describe('MeshCore node (real rows)', () => {
    beforeEach(async () => {
      await databaseService.meshcore.upsertNode(
        { publicKey: MC_KEY, name: 'Clock MC', latitude: MC_LAT, longitude: MC_LON, lastHeard: Date.now() - 60_000 },
        harness.sourceA,
      );
      await databaseService.meshcore.setNodePositionOverride(harness.sourceA, MC_KEY, { enabled: false });
      await databaseService.meshcore.setNodeTimezoneOverride(harness.sourceA, MC_KEY, null);
    });

    it('reads the position zone with nodes:viewOnMap, the server zone without', async () => {
      await give('info', ['read'], harness.sourceA);
      await give('nodes', ['read'], harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const before = await agent.get(url(harness.sourceA, MC_KEY));
      // Without viewOnMap: either no channel access at all, or the server zone.
      expect(before.status === 403 || before.body.data?.source === 'server').toBe(true);
      await harness.revokeAll(harness.limited.id);
      await give('info', ['read'], harness.sourceA);
      await give('nodes', ['read', 'viewOnMap'], harness.sourceA);
      expect((await agent.get(url(harness.sourceA, MC_KEY))).body.data).toEqual({ timeZone: 'Europe/London', source: 'position' });
    });

    it('sets and clears the override with nodes:write on the source', async () => {
      await give('info', ['read'], harness.sourceA);
      await give('nodes', ['read', 'write', 'viewOnMap'], harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.put('/nodes/timezone').send({ sourceId: harness.sourceA, nodeId: MC_KEY.toUpperCase(), timeZone: 'America/Denver' });
      expect(res.body).toEqual({ success: true, data: { timeZone: 'America/Denver', source: 'override' } });
      expect((await databaseService.meshcore.getNodeByPublicKeyAndSource(MC_KEY, harness.sourceA))?.timezoneOverride).toBe('America/Denver');
      const cleared = await agent.put('/nodes/timezone').send({ sourceId: harness.sourceA, nodeId: MC_KEY, timeZone: null });
      expect(cleared.body.data).toEqual({ timeZone: 'Europe/London', source: 'position' });
    });
  });

  describe('MeshCore contact known only to the live device list', () => {
    const LIVE_KEY = 'ef'.repeat(32);
    beforeEach(async () => {
      await sourceManagerRegistry.addManager({
        sourceId: harness.sourceA,
        sourceType: 'meshcore',
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn().mockReturnValue({ sourceId: harness.sourceA, sourceName: 'mc', sourceType: 'meshcore', connected: true }),
        getContact: vi.fn((key: string) => (key === LIVE_KEY ? { publicKey: LIVE_KEY, advName: 'Live Only', advType: 1, lastSeen: Date.now() } : undefined)),
      } as unknown as ISourceManager);
    });
    afterEach(async () => {
      await sourceManagerRegistry.removeManager(harness.sourceA);
    });

    it('gets its identity row first, like the Position Override route; an unknown key is 404', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.put('/nodes/timezone').send({ sourceId: harness.sourceA, nodeId: LIVE_KEY, timeZone: 'Asia/Tokyo' });
      expect(res.status).toBe(200);
      const row = await databaseService.meshcore.getNodeByPublicKeyAndSource(LIVE_KEY, harness.sourceA);
      expect(row?.name).toBe('Live Only');
      expect(row?.timezoneOverride).toBe('Asia/Tokyo');
      const unknown = await admin.put('/nodes/timezone').send({ sourceId: harness.sourceA, nodeId: '12'.repeat(32), timeZone: 'Asia/Tokyo' });
      expect(unknown.status).toBe(404);
    });
  });

  describe('node list (GET /nodes)', () => {
    beforeEach(async () => {
      await sourceManagerRegistry.addManager(fakeManager(harness.sourceA));
    });
    afterEach(async () => {
      await sourceManagerRegistry.removeManager(harness.sourceA);
    });

    it('does not send a Timezone Override with a private position override the viewer cannot see', async () => {
      await giveViewer();
      await give('nodes', ['read'], harness.sourceA);
      await databaseService.setNodeTimezoneOverrideAsync(NODE_NUM, harness.sourceA, 'Europe/Berlin');
      await databaseService.setNodePositionOverrideAsync(NODE_NUM, true, harness.sourceA, LAT, LON, undefined, true);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/nodes?sourceId=${harness.sourceA}`);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain('Clock');
      expect(JSON.stringify(res.body)).not.toContain('Berlin');
    });

    it('still sends latitude/longitude for a node hidden from the map (#6523 report)', async () => {
      await giveViewer();
      await give('nodes', ['read'], harness.sourceA);
      await databaseService.setNodeHideFromMapAsync(NODE_NUM, true, harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/nodes?sourceId=${harness.sourceA}`);
      const node = (res.body as Array<{ nodeNum: number; hideFromMap?: boolean; position?: { latitude?: number } }>).find(n => n.nodeNum === NODE_NUM);
      expect(node?.hideFromMap).toBe(true);
      expect(node?.position?.latitude).toBeCloseTo(LAT, 3);
    });
  });
});
