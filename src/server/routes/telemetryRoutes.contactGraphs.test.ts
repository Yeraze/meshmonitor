/**
 * telemetryRoutes — MeshCore contact graphs via the shared endpoints (#6262).
 * smarthops / linkquality / signal-trend with a 64-hex public key read
 * `meshcore_messages` on the named source; the grant is `nodes:viewOnMap`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import telemetryRoutes from './telemetryRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const KEY = 'ab'.repeat(32);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('MeshCore contact graphs on /telemetry/:nodeId/*', () => {
  let harness: RouteTestHarness;
  let seq = 0;

  const seed = async (sourceId: string, ts: number, hop: number, snr: number, rssi: number) => {
    await harness.db.meshcore.insertMessage(
      {
        id: `cg-${sourceId}-${++seq}`, fromPublicKey: KEY, toPublicKey: 'cd'.repeat(32), text: 'x',
        timestamp: ts, messageType: 'text', hopCount: hop, snr, rssi, sourceId, createdAt: ts,
      } as never,
      sourceId,
    );
  };

  beforeEach(async () => {
    seq = 0;
    harness = await createRouteTestApp({ mount: (app) => app.use('/', telemetryRoutes) });
    const now = Date.now();
    for (const h of [1, 2, 3]) await seed(harness.sourceA, now - h * HOUR, 2, 5, -95);
    for (const d of [2, 3, 4]) await seed(harness.sourceA, now - d * DAY, 1, 8, -80);
    await seed(harness.sourceB, now - HOUR, 6, 0, -120);
  });

  afterEach(async () => {
    await harness.db.meshcore.deleteAllMessagesForSource(harness.sourceA).catch(() => {});
    await harness.db.meshcore.deleteAllMessagesForSource(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  const url = (kind: string, sourceId: string, extra = '') => `/telemetry/${KEY}/${kind}?sourceId=${sourceId}${extra}`;

  it('smarthops reads meshcore_messages hop counts for the named source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(url('smarthops', harness.sourceA, '&hours=168'));
    expect(res.status).toBe(200);
    const pts = res.body.data;
    expect(pts.length).toBeGreaterThan(0);
    const last = pts[pts.length - 1];
    // Latest rolling-24h window holds only the 2-hop samples; earlier windows the 1-hop ones.
    expect(last.minHops).toBe(2);
    expect(last.maxHops).toBe(2);
    expect(pts.some((p: any) => p.minHops === 1)).toBe(true);
    // Source B's 6-hop row must not leak in.
    expect(Math.max(...pts.map((p: any) => p.maxHops))).toBeLessThanOrEqual(2);
  });

  it('linkquality replays the same hop samples', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(url('linkquality', harness.sourceA, '&hours=168'));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const p of res.body.data) {
      expect(p.quality).toBeGreaterThanOrEqual(0);
      expect(p.quality).toBeLessThanOrEqual(10);
    }
  });

  it('signal-trend uses DM rssi/snr (degrading: -95 vs -80)', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(url('signal-trend', harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body.data.trend).toBe('degrading');
    expect(res.body.data.basis).toBe('rssi');
    expect(res.body.data.rssi.delta).toBe(-15);
  });

  it('signal-trend folds in the polled mc_status_noise_floor telemetry', async () => {
    const now = Date.now();
    const rows: Array<[number, number]> = [
      [now - HOUR, -110], [now - 2 * HOUR, -110], [now - 3 * HOUR, -110],
      [now - 2 * DAY, -115], [now - 3 * DAY, -115], [now - 4 * DAY, -115],
    ];
    for (const [timestamp, value] of rows) {
      await harness.db.telemetry.insertTelemetry(
        { nodeId: KEY, nodeNum: 0, telemetryType: 'mc_status_noise_floor', timestamp, value, unit: 'dB', createdAt: timestamp },
        harness.sourceA,
      );
    }
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(url('signal-trend', harness.sourceA));
    expect(res.body.data.noiseFloor.delta).toBe(5);
    expect(res.body.data.noiseFloorRising).toBe(true);
    await harness.db.telemetry.deleteTelemetryByNode(0, harness.sourceA).catch(() => {});
  });

  it('signal-trend on another source does not see this source rows', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(url('signal-trend', harness.sourceB));
    expect(res.body.data.trend).toBe('insufficient');
  });

  it('gates on nodes:viewOnMap for that source', async () => {
    await harness.grant(harness.limited.id, 'info', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    for (const kind of ['smarthops', 'linkquality', 'signal-trend']) {
      expect((await agent.get(url(kind, harness.sourceA))).status).toBe(403);
    }
    await harness.grant(harness.limited.id, 'nodes', 'viewOnMap', harness.sourceA);
    for (const kind of ['smarthops', 'linkquality', 'signal-trend']) {
      expect((await agent.get(url(kind, harness.sourceA))).status).toBe(200);
      // Grant on A does not open B.
      expect((await agent.get(url(kind, harness.sourceB))).status).toBe(403);
    }
  });
});
