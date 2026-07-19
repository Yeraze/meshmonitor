/**
 * telemetryRoutes — GET /telemetry/:nodeId/signal-trend (issue #4110)
 *
 * Uses the real-middleware harness (createRouteTestApp) per project policy for
 * new route tests: real session + optionalAuth + real permission SQL, seeding
 * per-test grants and telemetry rows in the live :memory: singleton.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import telemetryRoutes from './telemetryRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { RSSI_TELEMETRY_TYPE } from '../services/signalTrend.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';

const NODE_ID = '!aabbccdd';
const NODE_NUM = 0xaabbccdd;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('GET /telemetry/:nodeId/signal-trend (#4110)', () => {
  let harness: RouteTestHarness;

  const seedRssi = async (sourceId: string) => {
    const now = Date.now();
    // Recent (last 24h) average -95 vs baseline (prior 7d) average -80 → degrading.
    const rows: Array<[number, number]> = [
      [now - 1 * HOUR, -95], [now - 2 * HOUR, -95], [now - 3 * HOUR, -95],
      [now - 2 * DAY, -80], [now - 3 * DAY, -80], [now - 4 * DAY, -80],
    ];
    for (const [timestamp, value] of rows) {
      await harness.db.telemetry.insertTelemetry(
        { nodeId: NODE_ID, nodeNum: NODE_NUM, telemetryType: RSSI_TELEMETRY_TYPE, timestamp, value, unit: 'dBm', createdAt: timestamp },
        sourceId,
      );
    }
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', telemetryRoutes) });
  });

  afterEach(async () => {
    // The harness reuses the live :memory: singleton across tests in this file,
    // and cleanup() only drops permissions/sources — clear this node's telemetry
    // so seeded rows don't leak into the next test.
    await harness.db.telemetry.deleteTelemetryByNode(NODE_NUM, ALL_SOURCES);
    await harness.cleanup();
  });

  it('returns a degrading trend for an admin with seeded RSSI history', async () => {
    await seedRssi(harness.sourceA);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/telemetry/${encodeURIComponent(NODE_ID)}/signal-trend?sourceId=${harness.sourceA}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.trend).toBe('degrading');
    expect(res.body.data.basis).toBe('rssi');
    expect(res.body.data.rssi.delta).toBe(-15);
  });

  it('returns insufficient when there is no signal history', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/telemetry/${encodeURIComponent(NODE_ID)}/signal-trend?sourceId=${harness.sourceA}`);
    expect(res.status).toBe(200);
    expect(res.body.data.trend).toBe('insufficient');
    expect(res.body.data.basis).toBeNull();
  });

  it('does not leak another source\'s telemetry', async () => {
    // Seed history on sourceB but query sourceA → still insufficient.
    await seedRssi(harness.sourceB);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/telemetry/${encodeURIComponent(NODE_ID)}/signal-trend?sourceId=${harness.sourceA}`);
    expect(res.status).toBe(200);
    expect(res.body.data.trend).toBe('insufficient');
  });

  it('400s when sourceId is missing', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/telemetry/${encodeURIComponent(NODE_ID)}/signal-trend`);
    expect(res.status).toBe(400);
  });

  it('403s for a user without info or dashboard read', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/telemetry/${encodeURIComponent(NODE_ID)}/signal-trend?sourceId=${harness.sourceA}`);
    expect(res.status).toBe(403);
  });

  it('allows a user granted info read + channel view on the node source', async () => {
    await seedRssi(harness.sourceA);
    await harness.grant(harness.limited.id, 'info', 'read', harness.sourceA);
    // Node has no stored row → channel defaults to 0; grant channel_0 view.
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/telemetry/${encodeURIComponent(NODE_ID)}/signal-trend?sourceId=${harness.sourceA}`);
    expect(res.status).toBe(200);
    expect(res.body.data.trend).toBe('degrading');
  });
});
