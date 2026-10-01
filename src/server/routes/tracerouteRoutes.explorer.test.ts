/**
 * GET /api/traceroutes/explorer (#5511, Traceroute Explorer report).
 *
 * Real-middleware harness (createRouteTestApp) against the live :memory:
 * singleton, so source permissions and channel masks run real SQL. The
 * harness does not reset data between tests, so node numbers here are unique
 * to this file and afterEach removes the traceroutes it seeded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import tracerouteRoutes from './tracerouteRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const N_FROM = 0x55110001;
const N_HOP = 0x55110002;
const N_TO = 0x55110003;
const N_B_ONLY = 0x55110004;
const HOUR = 3_600_000;
const nodeIdFor = (num: number): string => `!${num.toString(16).padStart(8, '0')}`;

describe('GET /api/traceroutes/explorer', () => {
  let harness: RouteTestHarness;

  const seedNode = async (nodeNum: number, sourceId: string, extra: Record<string, unknown> = {}) => {
    await harness.db.nodes.upsertNode(
      {
        nodeNum,
        nodeId: nodeIdFor(nodeNum),
        longName: `Node ${nodeNum.toString(16)}`,
        shortName: nodeNum.toString(16).slice(-4),
        channel: 0,
        latitude: 40.1,
        longitude: -75.2,
        lastHeard: Math.floor(Date.now() / 1000),
        ...extra,
      } as any,
      sourceId,
    );
  };

  const seedRun = async (
    sourceId: string,
    opts: { from?: number; to?: number; route?: string | null; agoMs?: number; channel?: number; packetId?: number } = {},
  ) => {
    const ts = Date.now() - (opts.agoMs ?? 0);
    await harness.db.traceroutes.insertTraceroute(
      {
        fromNodeNum: opts.from ?? N_FROM,
        toNodeNum: opts.to ?? N_TO,
        fromNodeId: nodeIdFor(opts.from ?? N_FROM),
        toNodeId: nodeIdFor(opts.to ?? N_TO),
        route: opts.route === undefined ? JSON.stringify([N_HOP]) : opts.route,
        routeBack: opts.route === undefined ? JSON.stringify([N_HOP]) : null,
        snrTowards: opts.route === undefined ? '[24,-12]' : null,
        snrBack: opts.route === undefined ? '[8,4]' : null,
        channel: opts.channel ?? 0,
        packetId: opts.packetId ?? null,
        timestamp: ts,
        createdAt: ts,
      },
      sourceId,
    );
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/', tracerouteRoutes) });
    for (const sid of [harness.sourceA, harness.sourceB]) {
      for (const n of [N_FROM, N_HOP, N_TO]) await seedNode(n, sid);
    }
    await seedNode(N_B_ONLY, harness.sourceB);
  });

  afterEach(async () => {
    await harness.db.traceroutes.deleteAllTraceroutes(harness.sourceA);
    await harness.db.traceroutes.deleteAllTraceroutes(harness.sourceB);
    await harness.cleanup();
  });

  const ourRuns = (body: any) =>
    (body.data.runs as any[]).filter(r => r.sourceId === harness.sourceA || r.sourceId === harness.sourceB);

  it('returns runs from every source to an admin, newest first, with node entries', async () => {
    await seedRun(harness.sourceA, { agoMs: 2 * HOUR, packetId: 1 });
    await seedRun(harness.sourceB, { from: N_B_ONLY, agoMs: HOUR, packetId: 2 });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/explorer');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const runs = ourRuns(res.body);
    expect(runs.map(r => r.packetId)).toEqual([2, 1]);
    expect(runs[1]).toMatchObject({ fromNodeNum: N_FROM, toNodeNum: N_TO, route: JSON.stringify([N_HOP]) });

    const hop = res.body.data.nodes.find((n: any) => n.nodeNum === N_HOP);
    expect(hop).toMatchObject({ nodeId: nodeIdFor(N_HOP), longName: `Node ${N_HOP.toString(16)}`, latitude: 40.1, longitude: -75.2 });
    expect(res.body.data).toMatchObject({ truncated: false, scanLimit: 5000 });
    expect(typeof res.body.data.retentionPerPair).toBe('number');
  });

  it('limits a non-admin to sources with traceroute:read', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    await seedRun(harness.sourceA, { packetId: 10 });
    await seedRun(harness.sourceB, { from: N_B_ONLY, packetId: 20 });

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/explorer');

    expect(res.status).toBe(200);
    expect(ourRuns(res.body).map(r => r.packetId)).toEqual([10]);
    expect(res.body.data.sources.map((s: any) => s.id)).toEqual([harness.sourceA]);
    // A node that only exists on the unreadable source never surfaces.
    expect(res.body.data.nodes.find((n: any) => n.nodeNum === N_B_ONLY)).toBeUndefined();
  });

  it('narrows to the sources param but never widens past permissions', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    await seedRun(harness.sourceA, { packetId: 30 });
    await seedRun(harness.sourceB, { packetId: 40 });

    const agent = await harness.loginAs(harness.limited);
    const onlyB = await agent.get(`/explorer?sources=${harness.sourceB}`);
    expect(ourRuns(onlyB.body)).toEqual([]);
    expect(onlyB.body.data.sources).toEqual([]);

    const admin = await harness.loginAs(harness.admin);
    const narrowed = await admin.get(`/explorer?sources=${harness.sourceB}`);
    expect(ourRuns(narrowed.body).map(r => r.packetId)).toEqual([40]);
  });

  it('applies the hours window and rejects a bad value', async () => {
    await seedRun(harness.sourceA, { agoMs: HOUR / 2, packetId: 50 });
    await seedRun(harness.sourceA, { agoMs: 30 * HOUR, packetId: 51 });

    const agent = await harness.loginAs(harness.admin);
    const day = await agent.get('/explorer?hours=24');
    expect(ourRuns(day.body).map(r => r.packetId)).toEqual([50]);

    const all = await agent.get('/explorer');
    expect(ourRuns(all.body).map(r => r.packetId)).toEqual([50, 51]);

    for (const bad of ['0', '-1', '1.5', 'abc', String(24 * 366)]) {
      const res = await agent.get(`/explorer?hours=${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_HOURS');
    }
  });

  it('hides runs on a channel the caller cannot view', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    await seedRun(harness.sourceA, { channel: 0, packetId: 60 });
    await seedRun(harness.sourceA, { channel: 2, packetId: 61 });

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/explorer');
    expect(ourRuns(res.body).map(r => r.packetId)).toEqual([60]);
  });

  it('keeps node names but drops positions the caller cannot see on the map', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    // No channel_0 viewOnMap: runs with no recorded channel stay visible, but
    // the nodes (channel 0) are not visible on the map.
    const ts = Date.now();
    await harness.db.traceroutes.insertTraceroute(
      {
        fromNodeNum: N_FROM, toNodeNum: N_TO, fromNodeId: nodeIdFor(N_FROM), toNodeId: nodeIdFor(N_TO),
        route: '[]', routeBack: '[]', snrTowards: '[20]', snrBack: '[16]', channel: null,
        packetId: 71, timestamp: ts, createdAt: ts,
      },
      harness.sourceA,
    );

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/explorer');
    expect(ourRuns(res.body).map(r => r.packetId)).toEqual([71]);
    const from = res.body.data.nodes.find((n: any) => n.nodeNum === N_FROM);
    expect(from).toMatchObject({ longName: `Node ${N_FROM.toString(16)}`, latitude: null, longitude: null });
  });

  it('returns nothing to an anonymous caller with no grants', async () => {
    await seedRun(harness.sourceA, { packetId: 80 });
    const agent = await harness.loginAs(null);
    const res = await agent.get('/explorer');
    expect(res.status).toBe(200);
    expect(ourRuns(res.body)).toEqual([]);
  });
});
