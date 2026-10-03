/**
 * GET /api/analysis/cross-source-links (#5561) — real-middleware harness.
 *
 * The rules under test: an edge is returned only when the caller can read
 * `nodes` on BOTH its tx and rx source, and only when both endpoint positions
 * pass the map's visibility gates. A caller with one source gets no edge and
 * no trace of the other source.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crossSourceLinkRoutes, { aggregateCrossSourceLinks } from './crossSourceLinkRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

const nodeIdFor = (num: number): string => `!${num.toString(16).padStart(8, '0')}`;
const nowSec = (): number => Math.floor(Date.now() / 1000);

describe('Cross-source link routes (#5561)', () => {
  let harness: RouteTestHarness;
  const NUM_A = 0x7a000001;
  const NUM_B = 0x7b000002;
  const GATEWAY = 0x7c000003;

  const hear = (o: Record<string, unknown> = {}) =>
    databaseService.crossSourceLinks.recordHearing({
      txSourceId: harness.sourceA, txNodeId: nodeIdFor(NUM_A),
      rxSourceId: harness.sourceB, rxNodeId: nodeIdFor(NUM_B),
      protocol: 'meshtastic', kind: 'origin', transportClass: 'rf',
      snr: 5, rssi: -90, heardAt: Date.now() - 60_000,
      ...o,
    } as Parameters<typeof databaseService.crossSourceLinks.recordHearing>[0]);

  const grantBoth = async () => {
    for (const src of [harness.sourceA, harness.sourceB]) {
      await harness.grant(harness.limited.id, 'nodes', 'read', src);
      await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', src);
    }
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', crossSourceLinkRoutes) });
    await harness.db.nodes.upsertNode({
      nodeNum: NUM_A, nodeId: nodeIdFor(NUM_A), longName: 'Radio A', shortName: 'A', channel: 0,
      latitude: 30.1, longitude: -90.1, lastHeard: nowSec(),
    } as any, harness.sourceA);
    await harness.db.nodes.upsertNode({
      nodeNum: NUM_B, nodeId: nodeIdFor(NUM_B), longName: 'Radio B', shortName: 'B', channel: 0,
      latitude: 30.2, longitude: -90.2, lastHeard: nowSec(),
    } as any, harness.sourceB);
    await harness.db.nodes.upsertNode({
      nodeNum: GATEWAY, nodeId: nodeIdFor(GATEWAY), longName: 'Hilltop GW', shortName: 'G', channel: 0,
      latitude: 30.3, longitude: -90.3, lastHeard: nowSec(),
    } as any, harness.sourceB);
    await hear();
  });

  afterEach(async () => {
    await databaseService.crossSourceLinks.deleteAll().catch(() => {});
    await harness.cleanup();
  });

  it('admin: returns the edge with both positions, names and stats', async () => {
    await hear({ snr: 9, rssi: -70, heardAt: Date.now() - 30_000 });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    expect(res.body.data.links).toHaveLength(1);
    expect(res.body.data.links[0]).toMatchObject({
      kind: 'origin', inferred: false, transportClass: 'rf', protocol: 'meshtastic',
      txSourceId: harness.sourceA, txName: 'Radio A', rxSourceId: harness.sourceB, rxName: 'Radio B',
      count: 2, snrMin: 5, snrMax: 9, snrAvg: 7, rssiAvg: -80,
      from: [30.1, -90.1], to: [30.2, -90.2],
    });
  });

  it('a relay edge is marked inferred; a gateway edge ends at the gateway', async () => {
    await hear({ kind: 'relay' });
    await hear({ transportClass: 'mqtt_gateway', rxNodeId: nodeIdFor(GATEWAY) });
    const agent = await harness.loginAs(harness.admin);
    const links = (await agent.get('/')).body.data.links;
    expect(links).toHaveLength(3);
    expect(links.find((l: any) => l.kind === 'relay')).toMatchObject({ inferred: true });
    expect(links.find((l: any) => l.transportClass === 'mqtt_gateway')).toMatchObject({
      rxName: 'Hilltop GW', to: [30.3, -90.3],
    });
  });

  it('an inferred relay row from a gateway (stored by an older build) is never returned', async () => {
    await hear({ kind: 'relay', transportClass: 'mqtt_gateway', rxNodeId: nodeIdFor(GATEWAY) });
    const agent = await harness.loginAs(harness.admin);
    const links = (await agent.get('/')).body.data.links;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: 'origin', transportClass: 'rf' });
  });

  it('a user who can read only one source gets no edge and no trace of the other', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    expect(res.body.data.links).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(harness.sourceA);
    expect(JSON.stringify(res.body)).not.toContain('Radio A');
  });

  it('anonymous with no grants gets nothing', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    expect(res.body.data.links).toEqual([]);
  });

  it('a user who can read both sources sees the edge', async () => {
    await grantBoth();
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/');
    expect(res.body.data.links).toHaveLength(1);
  });

  it('an endpoint whose position the user may not see drops the edge', async () => {
    // nodes:read on both, but no channel viewOnMap on A: Radio A's position is hidden.
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/');
    expect(res.body.data.links).toEqual([]);
  });

  it('falls back to the other source\'s table when the radio\'s own row has no position', async () => {
    // Radio A's row on its own source loses its coordinates; source B knows where A is.
    await harness.db.nodes.upsertNode({
      nodeNum: 0x7e00000a, nodeId: nodeIdFor(0x7e00000a), longName: 'Radio A2', shortName: 'A2', channel: 0, lastHeard: nowSec(),
    } as any, harness.sourceA);
    await harness.db.nodes.upsertNode({
      nodeNum: 0x7e00000a, nodeId: nodeIdFor(0x7e00000a), longName: 'Radio A2 seen by B', shortName: 'A2', channel: 0,
      latitude: 31.5, longitude: -91.5, lastHeard: nowSec(),
    } as any, harness.sourceB);
    await hear({ txNodeId: nodeIdFor(0x7e00000a) });
    const agent = await harness.loginAs(harness.admin);
    const links = (await agent.get('/')).body.data.links;
    expect(links.find((l: any) => l.txNodeId === nodeIdFor(0x7e00000a))).toMatchObject({ from: [31.5, -91.5] });
  });

  it('the fallback never overrides the owning source: hidden on A stays hidden even if B could show it', async () => {
    // The same radio is also in B's table with a position the user may see there.
    await harness.db.nodes.upsertNode({
      nodeNum: NUM_A, nodeId: nodeIdFor(NUM_A), longName: 'Radio A via B', shortName: 'A', channel: 0,
      latitude: 30.15, longitude: -90.15, lastHeard: nowSec(),
    } as any, harness.sourceB);
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/');
    expect(res.body.data.links).toEqual([]);
  });

  it('an endpoint with no position drops the edge', async () => {
    await hear({ rxNodeId: nodeIdFor(0x7d000009) });
    const agent = await harness.loginAs(harness.admin);
    const links = (await agent.get('/')).body.data.links;
    expect(links).toHaveLength(1);
    expect(links[0].rxNodeId).toBe(nodeIdFor(NUM_B));
  });

  it('?sources= keeps edges touching that source; an unrelated source filters them out', async () => {
    const agent = await harness.loginAs(harness.admin);
    expect((await agent.get(`/?sources=${harness.sourceB}`)).body.data.links).toHaveLength(1);
    expect((await agent.get('/?sources=nope')).body.data.links).toEqual([]);
  });

  it('honours since, clamps it to the retention window, and rejects junk', async () => {
    const agent = await harness.loginAs(harness.admin);
    const future = await agent.get(`/?since=${Date.now() + 3 * 3_600_000}`);
    expect(future.body.data.links).toEqual([]);
    const ancient = await agent.get('/?since=1');
    expect(ancient.body.data.sinceMs).toBeGreaterThan(1);
    expect(ancient.body.data.links).toHaveLength(1);
    const bad = await agent.get('/?since=abc');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_TIME_RANGE');
  });
});

describe('aggregateCrossSourceLinks', () => {
  const row = (o: Record<string, unknown>) => ({
    id: 1, txSourceId: 'a', txNodeId: '!a', rxSourceId: 'b', rxNodeId: '!b', protocol: 'meshtastic',
    kind: 'origin', transportClass: 'rf', hourBucket: 0, count: 1, snrMin: null, snrAvg: null, snrMax: null,
    snrCount: 0, rssiAvg: null, rssiCount: 0, lastHeardAt: 0, ...o,
  }) as any;

  it('sums counts and weights averages across hour buckets', () => {
    const [a] = aggregateCrossSourceLinks([
      row({ hourBucket: 0, count: 3, snrMin: 1, snrAvg: 2, snrMax: 3, snrCount: 3, rssiAvg: -100, rssiCount: 1, lastHeardAt: 10 }),
      row({ hourBucket: 3_600_000, count: 1, snrMin: 10, snrAvg: 10, snrMax: 10, snrCount: 1, lastHeardAt: 99 }),
      row({ hourBucket: 7_200_000, count: 2 }),
    ]);
    expect(a.count).toBe(6);
    expect(a.snrMin).toBe(1);
    expect(a.snrMax).toBe(10);
    expect(a.snrSum / a.snrCount).toBe(4);
    expect(a.rssiSum / a.rssiCount).toBe(-100);
    expect(a.lastHeardAt).toBe(99);
  });

  it('keeps different kinds and receivers apart', () => {
    expect(aggregateCrossSourceLinks([row({}), row({ kind: 'relay' }), row({ rxNodeId: '!c' })])).toHaveLength(3);
  });
});
