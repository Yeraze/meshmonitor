/**
 * GET /api/assets/:nodeNum/track (#5354, Asset Tracking Phase 2).
 *
 * Real-middleware harness (createRouteTestApp) against the `:memory:` SQLite
 * DB. The properties that matter:
 *  - only sources the caller may read contribute, and only where the node's
 *    channel is `viewOnMap` for them (non-admins);
 *  - a private position override hides that source's fixes unless the caller
 *    holds `nodes_private:read` on that source;
 *  - a non-asset, or an asset the caller can't see, is `NOT_AN_ASSET`;
 *  - `hours` is clamped to 1 .. retentionDays x 24;
 *  - the same fix heard by two sources is drawn once; gaps split segments.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import assetRoutes from './assetRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { clearAssetTrackCache } from '../services/assetTrackService.js';

const NODE_A = 0x0a0a0a0a;
const NODE_B = 0x0b0b0b0b;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

interface Seg { latitude: number; longitude: number; timestamp: number }

describe('assetRoutes GET /:nodeNum/track (#5354)', () => {
  let harness: RouteTestHarness;

  async function seedNode(
    nodeNum: number,
    sourceId: string,
    extra: { positionOverrideIsPrivate?: boolean; channel?: number } = {},
  ): Promise<void> {
    await harness.db.nodes.upsertNode(
      {
        nodeNum,
        nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
        longName: `Node ${nodeNum}`,
        shortName: 'NODE',
        lastHeard: Math.floor(Date.now() / 1000),
        ...extra,
      },
      sourceId,
    );
  }

  async function seedFix(nodeNum: number, sourceId: string, ts: number, lat: number, lon: number): Promise<void> {
    const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
    for (const [telemetryType, value] of [['latitude', lat], ['longitude', lon], ['battery', 50]] as const) {
      await harness.db.telemetry.insertTelemetry(
        { nodeId, nodeNum, telemetryType, timestamp: ts, value, createdAt: ts },
        sourceId,
      );
    }
  }

  async function clearAssets(): Promise<void> {
    for (const a of await harness.db.assetNodes.getAllAsync()) {
      await harness.db.assetNodes.clearAsync(a.nodeNum);
    }
  }

  async function limitedWithMapAccess(...sources: string[]): Promise<void> {
    for (const s of sources) {
      await harness.grant(harness.limited.id, 'nodes', 'read', s);
      await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', s);
    }
  }

  let now: number;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', assetRoutes), useOptionalAuth: false });
    clearAssetTrackCache();
    await clearAssets();
    await harness.db.purgeAllTelemetryAsync();
    now = Date.now();
    await seedNode(NODE_A, harness.sourceA);
    await seedNode(NODE_A, harness.sourceB);
    await seedNode(NODE_B, harness.sourceA);
    await harness.db.assetNodes.setAsync(NODE_A, 2);
    // Source A: one drive, three fixes 1 min apart.
    await seedFix(NODE_A, harness.sourceA, now - 10 * MIN, 40.0, -75.0);
    await seedFix(NODE_A, harness.sourceA, now - 9 * MIN, 40.001, -75.0);
    await seedFix(NODE_A, harness.sourceA, now - 8 * MIN, 40.002, -75.0);
    // Source B heard the middle fix too (same position, 400 ms later)…
    await seedFix(NODE_A, harness.sourceB, now - 9 * MIN + 400, 40.001, -75.0);
    // …and an earlier drive, 5 h ago, that A didn't hear.
    await seedFix(NODE_A, harness.sourceB, now - 5 * HOUR, 41.0, -76.0);
    await seedFix(NODE_A, harness.sourceB, now - 5 * HOUR + MIN, 41.001, -76.0);
  });

  afterEach(async () => {
    clearAssetTrackCache();
    await clearAssets();
    await harness.db.purgeAllTelemetryAsync();
    await harness.cleanup();
  });

  it('merges sources for an admin, dedupes the shared fix, and splits at the gap', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${NODE_A}/track`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(data).toMatchObject({ nodeNum: NODE_A, retentionDays: 2, hours: 48, totalFixes: 5 });
    expect(data.windowStartMs).toBeGreaterThan(now - 48 * HOUR - MIN);
    expect(data.segments.map((s: Seg[]) => s.map((f) => f.latitude))).toEqual([
      [41.0, 41.001],
      [40.0, 40.001, 40.002],
    ]);
    // Fix shape stays compatible with the client's PositionHistoryItem.
    expect(data.segments[1][0]).toMatchObject({ latitude: 40.0, longitude: -75.0, timestamp: now - 10 * MIN });
  });

  it('only reads the caller\'s permitted, map-visible sources', async () => {
    await limitedWithMapAccess(harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${NODE_A}/track`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalFixes).toBe(3);
    expect(res.body.data.segments).toHaveLength(1);
  });

  it('honours the sources filter, intersected with what is permitted', async () => {
    await limitedWithMapAccess(harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${NODE_A}/track?sources=${harness.sourceB}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalFixes).toBe(0);
    expect(res.body.data.segments).toEqual([]);

    const admin = await harness.loginAs(harness.admin);
    const onlyB = await admin.get(`/${NODE_A}/track?sources=${harness.sourceB}`);
    expect(onlyB.body.data.totalFixes).toBe(3);
  });

  it('draws nothing without channel viewOnMap', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${NODE_A}/track`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalFixes).toBe(0);
  });

  it('drops a source with a private override unless nodes_private:read is held there', async () => {
    await seedNode(NODE_A, harness.sourceA, { positionOverrideIsPrivate: true });
    await limitedWithMapAccess(harness.sourceA, harness.sourceB);
    let agent = await harness.loginAs(harness.limited);
    let res = await agent.get(`/${NODE_A}/track`);
    expect(res.status).toBe(200);
    // Only source B's three fixes remain.
    expect(res.body.data.totalFixes).toBe(3);
    expect(res.body.data.segments.flat().every((f: Seg) => f.latitude !== 40.0)).toBe(true);

    // The grant on the OTHER source does not unlock source A.
    await harness.grant(harness.limited.id, 'nodes_private', 'read', harness.sourceB);
    clearAssetTrackCache();
    agent = await harness.loginAs(harness.limited);
    res = await agent.get(`/${NODE_A}/track`);
    expect(res.body.data.totalFixes).toBe(3);

    await harness.grant(harness.limited.id, 'nodes_private', 'read', harness.sourceA);
    agent = await harness.loginAs(harness.limited);
    res = await agent.get(`/${NODE_A}/track`);
    expect(res.body.data.totalFixes).toBe(5);
  });

  it('returns NOT_AN_ASSET for a node that is not tracked', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${NODE_B}/track`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_AN_ASSET');
  });

  it('returns NOT_AN_ASSET for an asset on no permitted source, so the flag does not leak', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${NODE_A}/track`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_AN_ASSET');
  });

  it('clamps hours to 1 .. retentionDays x 24', async () => {
    const agent = await harness.loginAs(harness.admin);

    const big = await agent.get(`/${NODE_A}/track?hours=100000`);
    expect(big.body.data.hours).toBe(48);
    expect(big.body.data.totalFixes).toBe(5);

    const zero = await agent.get(`/${NODE_A}/track?hours=0`);
    expect(zero.body.data.hours).toBe(1);
    // Only the recent drive is inside the last hour.
    expect(zero.body.data.totalFixes).toBe(3);
    expect(zero.body.data.windowStartMs).toBeGreaterThan(now - HOUR - MIN);
  });

  it('rejects a non-numeric hours value and a bad nodeNum', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${NODE_A}/track?hours=abc`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_HOURS');
    const bad = await agent.get('/nope/track');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_NODE_NUM');
  });

  it('serves a cached answer, and drops it when the asset changes', async () => {
    const agent = await harness.loginAs(harness.admin);
    const first = await agent.get(`/${NODE_A}/track`);
    expect(first.body.data.totalFixes).toBe(5);

    await seedFix(NODE_A, harness.sourceA, now - 7 * MIN, 40.003, -75.0);
    const cached = await agent.get(`/${NODE_A}/track`);
    expect(cached.body.data.totalFixes).toBe(5);

    // Changing retention (a PUT) invalidates this node's cache entries.
    await agent.put(`/${NODE_A}`).send({ retentionDays: 2 });
    const fresh = await agent.get(`/${NODE_A}/track`);
    expect(fresh.body.data.totalFixes).toBe(6);
  });
});
