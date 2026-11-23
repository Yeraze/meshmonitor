/**
 * /api/solar/irradiance, /usage, /refresh (#6523): read gate, position gate,
 * admin-only routes. Real auth + real SQL via the route harness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import solarRoutes from './solarRoutes.js';
import databaseService from '../../services/database.js';
import { cellFor, openMeteoSolarService } from '../services/openMeteoSolarService.js';

const NODE_NUM = 0x5e0f9a61;
const NODE_ID = '!5e0f9a61';
const LAT = 40.0123;
const LON = -89.9876;
const T0 = 1_795_305_600;

describe('solar irradiance routes', () => {
  let harness: RouteTestHarness;

  const url = (sourceId: string, extra = '') =>
    `/solar/irradiance?sourceId=${sourceId}&nodeId=${encodeURIComponent(NODE_ID)}&start=${T0}&end=${T0 + 7200}${extra}`;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/solar', solarRoutes) });
    await databaseService.settings.setSetting('solarMonitoringEnabled', '1');
    await databaseService.nodes.upsertNode(
      { nodeNum: NODE_NUM, nodeId: NODE_ID, longName: 'Sunny', shortName: 'S', hwModel: 43, channel: 0, lastHeard: Math.floor(Date.now() / 1000), latitude: LAT, longitude: LON },
      harness.sourceA,
    );
    await databaseService.setNodePositionOverrideAsync(NODE_NUM, false, harness.sourceA, undefined, undefined, undefined, false);
    await databaseService.setNodeHideFromMapAsync(NODE_NUM, false, harness.sourceA);
    await databaseService.solarIrradiance.replaceCellRows(cellFor(LAT, LON, 0.1).key, [
      { timestamp: T0, shortwaveRadiation: 0, cloudCover: 90 },
      { timestamp: T0 + 3600, shortwaveRadiation: 420, cloudCover: 10 },
    ], T0);
  });

  afterEach(async () => {
    await databaseService.settings.setSetting('solarMonitoringEnabled', '0');
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  /** One permission row carrying several actions (harness.grant writes one per row). */
  const give = async (resource: string, actions: Array<'read' | 'viewOnMap'>, sourceId: string) => {
    await databaseService.auth.createPermission({
      userId: harness.limited.id,
      resource,
      canRead: actions.includes('read'),
      canWrite: false,
      canViewOnMap: actions.includes('viewOnMap'),
      sourceId,
      grantedAt: Date.now(),
      grantedBy: null,
    } as never);
  };

  const giveViewer = async (opts: { viewOnMap: boolean }, sourceId = harness.sourceA) => {
    await give('info', ['read'], sourceId);
    await give('channel_0', opts.viewOnMap ? ['read', 'viewOnMap'] : ['read'], sourceId);
  };

  it('returns the node cell curve to a viewer who can see the position', async () => {
    await giveViewer({ viewOnMap: true });
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(url(harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        enabled: true,
        points: [
          { timestamp: T0, shortwaveRadiation: 0, cloudCover: 90 },
          { timestamp: T0 + 3600, shortwaveRadiation: 420, cloudCover: 10 },
        ],
      },
    });
    // Never echoes the position or cell.
    expect(JSON.stringify(res.body)).not.toContain('40.05');
  });

  it('refuses a viewer who cannot see the node on the map', async () => {
    await giveViewer({ viewOnMap: false });
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).status).toBe(403);
  });

  it('returns no points for a node hidden from the map', async () => {
    await giveViewer({ viewOnMap: true });
    await databaseService.setNodeHideFromMapAsync(NODE_NUM, true, harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).body.data.points).toEqual([]);
  });

  it('hides a private override from a viewer without nodes_private:read', async () => {
    await giveViewer({ viewOnMap: true });
    await databaseService.setNodePositionOverrideAsync(NODE_NUM, true, harness.sourceA, LAT, LON, undefined, true);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).body.data.points).toEqual([]);
    await give('nodes_private', ['read'], harness.sourceA);
    expect((await agent.get(url(harness.sourceA))).body.data.points).toHaveLength(2);
  });

  it('403s without info/dashboard read', async () => {
    await give('channel_0', ['read', 'viewOnMap'], harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).status).toBe(403);
  });

  it('a grant on another source does not open this one', async () => {
    await giveViewer({ viewOnMap: true }, harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(url(harness.sourceA));
    expect(res.status === 403 || res.body.data?.points?.length === 0).toBe(true);
  });

  it('reports disabled, and validates the window', async () => {
    const agent = await harness.loginAs(harness.admin);
    await databaseService.settings.setSetting('solarMonitoringEnabled', '0');
    expect((await agent.get(url(harness.sourceA))).body.data).toEqual({ enabled: false, points: [] });
    await databaseService.settings.setSetting('solarMonitoringEnabled', '1');
    const tooLong = `/solar/irradiance?sourceId=${harness.sourceA}&nodeId=${encodeURIComponent(NODE_ID)}&start=0&end=${T0}`;
    expect((await agent.get(tooLong)).status).toBe(400);
    expect((await agent.get(`/solar/irradiance?sourceId=${harness.sourceA}&start=${T0}&end=${T0}`)).status).toBe(400);
  });

  it('usage and refresh are admin-only', async () => {
    await giveViewer({ viewOnMap: true });
    const limitedAgent = await harness.loginAs(harness.limited);
    expect((await limitedAgent.get('/solar/usage')).status).toBe(403);
    expect((await limitedAgent.post('/solar/refresh')).status).toBe(403);

    const refresh = vi.spyOn(openMeteoSolarService, 'refresh').mockResolvedValue(3);
    const admin = await harness.loginAs(harness.admin);
    const usage = await admin.get('/solar/usage');
    expect(usage.status).toBe(200);
    expect(usage.body.data.freeDailyBudget).toBe(9000);
    expect(usage.body.data.activeNodes).toBeGreaterThanOrEqual(1);
    expect(usage.body.data.cellsByGrid['0.1']).toBeGreaterThanOrEqual(1);
    const r = await admin.post('/solar/refresh');
    expect(r.body).toEqual({ success: true, data: { fetched: 3 } });
    expect(refresh).toHaveBeenCalledOnce();
  });
});
