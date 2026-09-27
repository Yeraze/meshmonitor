/**
 * GET /api/aircraft/trails (#5364/#5365 Phase 3).
 *
 * Real-middleware harness (createRouteTestApp) against the live :memory:
 * singleton, so permission checks and `buildPositionFilter` run real SQL.
 * The harness does not reset data between tests, so every node number here
 * is unique to this file and afterEach removes what it seeded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import aircraftRoutes from './aircraftRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { AIRCRAFT_TRAIL_MAX_POINTS } from '../utils/aircraftTrails.js';

const A_PLANE = 0x71000001;
const A_AGED_OUT = 0x71000002;
const A_GROUND = 0x71000003;
const A_PRIVATE = 0x71000004;
const B_PLANE = 0x72000001;
const ALL = [A_PLANE, A_AGED_OUT, A_GROUND, A_PRIVATE, B_PLANE];

const HOUR = 3_600_000;
const nodeIdFor = (num: number): string => `!${num.toString(16).padStart(8, '0')}`;

describe('GET /api/aircraft/trails', () => {
  let harness: RouteTestHarness;

  const seedNode = async (
    nodeNum: number,
    sourceId: string,
    opts: { aircraft?: boolean; agedOut?: boolean; privatePos?: boolean } = {},
  ) => {
    await harness.db.nodes.upsertNode(
      {
        nodeNum,
        nodeId: nodeIdFor(nodeNum),
        longName: `Node ${nodeNum.toString(16)}`,
        shortName: 'N',
        channel: 0,
        positionOverrideIsPrivate: opts.privatePos ?? false,
        lastHeard: Math.floor(Date.now() / 1000),
      } as any,
      sourceId,
    );
    if (opts.aircraft) {
      await harness.db.nodes.setAircraftClassification(nodeNum, sourceId, {
        likelyAircraft: true,
        aircraftBasis: null,
        groundElevation: 0,
        heightAboveGround: 3000,
        aircraftClassifiedAt: Date.now(),
      });
    }
    if (opts.agedOut) {
      await harness.db.nodes.markAircraftAgedOut(nodeNum, sourceId, Date.now());
    }
  };

  /** Write one lat/lon/alt fix `agoMs` in the past. */
  const seedFix = async (nodeNum: number, sourceId: string, agoMs: number, lat: number, lon: number) => {
    const ts = Date.now() - agoMs;
    for (const [telemetryType, value] of [['latitude', lat], ['longitude', lon], ['altitude', 9000]] as const) {
      await harness.db.telemetry.insertTelemetry(
        { nodeId: nodeIdFor(nodeNum), nodeNum, telemetryType, timestamp: ts, value, createdAt: ts },
        sourceId,
      );
    }
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', aircraftRoutes) });

    await seedNode(A_PLANE, harness.sourceA, { aircraft: true });
    await seedNode(A_AGED_OUT, harness.sourceA, { aircraft: true, agedOut: true });
    await seedNode(A_GROUND, harness.sourceA);
    await seedNode(A_PRIVATE, harness.sourceA, { aircraft: true, privatePos: true });
    await seedNode(B_PLANE, harness.sourceB, { aircraft: true });

    for (const n of [A_PLANE, A_AGED_OUT, A_GROUND, A_PRIVATE]) {
      await seedFix(n, harness.sourceA, 2 * HOUR, 30.1, -80.1);
      await seedFix(n, harness.sourceA, 1 * HOUR, 30.2, -80.2);
    }
    await seedFix(A_PLANE, harness.sourceA, 10 * HOUR, 29.0, -79.0); // outside the 6 h default
    await seedFix(B_PLANE, harness.sourceB, 1 * HOUR, 10.1, 20.1);
    await seedFix(B_PLANE, harness.sourceB, 0.5 * HOUR, 10.2, 20.2);
  });

  afterEach(async () => {
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      for (const n of ALL) {
        await harness.db.telemetry.purgeNodeTelemetry(n, sourceId).catch(() => {});
        await harness.db.nodes.deleteNodeRecord(n, sourceId).catch(() => {});
      }
    }
    await harness.cleanup();
  });

  const trailKeys = (body: any): string[] =>
    (body.data.trails as Array<{ sourceId: string; nodeNum: number }>)
      .map((t) => `${t.sourceId}:${t.nodeNum}`)
      .sort();

  it('returns only flagged or aged-out nodes, in the ok() envelope', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/trails');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const keys = trailKeys(res.body);
    expect(keys).toContain(`${harness.sourceA}:${A_PLANE}`);
    expect(keys).toContain(`${harness.sourceA}:${A_AGED_OUT}`);
    expect(keys).toContain(`${harness.sourceB}:${B_PLANE}`);
    expect(keys).not.toContain(`${harness.sourceA}:${A_GROUND}`);
  });

  it('returns points ascending by time with the item shape', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/trails');
    const trail = res.body.data.trails.find((t: any) => t.nodeNum === A_PLANE && t.sourceId === harness.sourceA);

    expect(trail.points).toHaveLength(2);
    expect(trail.points[0]).toMatchObject({ lat: 30.1, lon: -80.1, alt: 9000 });
    expect(trail.points[0].ts).toBeLessThan(trail.points[1].ts);
  });

  it('isolates sources by nodes:read permission', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/trails');

    expect(res.status).toBe(200);
    const keys = trailKeys(res.body);
    expect(keys).toContain(`${harness.sourceA}:${A_PLANE}`);
    expect(keys.some((k) => k.startsWith(`${harness.sourceB}:`))).toBe(false);
  });

  it('returns nothing to a caller with no source access', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/trails');

    expect(res.status).toBe(200);
    expect(res.body.data.trails).toEqual([]);
  });

  it('narrows to the `sources` param, never widening past permissions', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/trails?sources=${harness.sourceB}`);
    expect(trailKeys(res.body)).toEqual([`${harness.sourceB}:${B_PLANE}`]);
  });

  it('hides a private-override node from a non-admin but shows it to an admin', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    const limited = await harness.loginAs(harness.limited);
    const limitedKeys = trailKeys((await limited.get('/trails')).body);
    expect(limitedKeys).not.toContain(`${harness.sourceA}:${A_PRIVATE}`);

    const admin = await harness.loginAs(harness.admin);
    const adminKeys = trailKeys((await admin.get('/trails')).body);
    expect(adminKeys).toContain(`${harness.sourceA}:${A_PRIVATE}`);
  });

  it('drops trails on a channel without viewOnMap for a non-admin', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/trails');
    expect(res.body.data.trails).toEqual([]);
  });

  it('clamps hours: 0 reads as 1 h, 9999 as 168 h, junk as the 6 h default', async () => {
    const agent = await harness.loginAs(harness.admin);
    const pointsFor = async (q: string) => {
      const res = await agent.get(`/trails?sources=${harness.sourceA}&${q}`);
      const t = res.body.data.trails.find((x: any) => x.nodeNum === A_PLANE);
      return t ? t.points.length : 0;
    };

    // 1 h window: the 1 h-old fix sits on the edge, the 2 h-old one is out.
    expect(await pointsFor('hours=0')).toBeLessThanOrEqual(1);
    expect(await pointsFor('hours=9999')).toBe(3);
    expect(await pointsFor('hours=abc')).toBe(2);
  });

  it(`caps each trail at ${AIRCRAFT_TRAIL_MAX_POINTS} points, keeping the first and last`, async () => {
    const extra = AIRCRAFT_TRAIL_MAX_POINTS + 20;
    for (let i = 0; i < extra; i++) {
      await seedFix(B_PLANE, harness.sourceB, 3 * HOUR - i * 10_000, 11 + i / 1000, 21);
    }
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/trails?sources=${harness.sourceB}`);
    const trail = res.body.data.trails[0];

    expect(trail.points.length).toBe(AIRCRAFT_TRAIL_MAX_POINTS);
    expect(trail.points[0].lat).toBeCloseTo(11, 5);
    expect(trail.points[trail.points.length - 1].lat).toBeCloseTo(10.2, 5);
  });
});
