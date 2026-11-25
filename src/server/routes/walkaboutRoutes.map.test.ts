/**
 * Walkabout map routes (#5891 P2): auth matrix, validation, visibility gate,
 * names, track. Real harness + real repository (in-memory SQLite).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { latLngToCell } from 'h3-js';
import walkaboutRoutes from './walkaboutRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const LAT = 40.1;
const LON = -105.1;
const CELL9 = latLngToCell(LAT, LON, 9);
const OK_NUM = 0xaabbccdd;
const HIDDEN_NUM = 0xaabb0002;
const GONE_NUM = 0xaabb0003;
const MC_KEY = 'cd'.repeat(32);
const idOf = (n: number) => `!${n.toString(16).padStart(8, '0')}`;

describe('walkabout map routes', () => {
  let h: RouteTestHarness;
  let start: number;
  const end = () => start + 600_000;
  const url = (src: string, p: string) => `/api/sources/${src}/walkabout${p}`;
  let seq = 0;

  const rx = (sourceId: string, sessionId: string, o: Record<string, unknown> = {}) =>
    h.db.coverageWalkabout.recordReception({
      sessionId, sourceId, protocol: 'meshtastic', creditedKey: idOf(OK_NUM), creditedNodeNum: OK_NUM,
      creditKind: 'direct', hopsAway: 0, packetKey: `p${seq++}`, snr: 3, rssi: null, heardAt: start + 1000,
      sampleId: null, latitude: LAT, longitude: LON, accuracyM: 5, sampleAgeMs: 0, ...o,
    } as never);
  const sm = (sourceId: string, sessionId: string, o: Record<string, unknown> = {}) =>
    h.db.coverageWalkabout.insertSample({
      sessionId, sourceId, latitude: LAT, longitude: LON, accuracyM: 5, deviceFixAt: start, fixAt: start + 500,
      receivedAt: start + 500, ...o,
    } as never);

  beforeEach(async () => {
    start = Date.now() - 3_600_000;
    h = await createRouteTestApp({ mount: (app) => app.use('/api/sources/:id/walkabout', walkaboutRoutes) });
    const repo = h.db.coverageWalkabout;
    for (const [src, id] of [[h.sourceA, 'sa'], [h.sourceB, 'sb']] as const) {
      await repo.createSession({ id, sourceId: src, name: null, startedAt: start, startedBy: null });
      await repo.endSession(src, id, end(), 'user');
    }
    const node = (nodeNum: number, o: Record<string, unknown>) =>
      h.db.nodes.upsertNode({ nodeNum, nodeId: idOf(nodeNum), channel: 0, lastHeard: Math.floor(Date.now() / 1000), ...o } as never, h.sourceA);
    await node(OK_NUM, { longName: 'Alpha', shortName: 'AL' });
    await node(HIDDEN_NUM, { longName: 'Hidden', shortName: 'HD', hideFromMap: true });
    await h.db.meshcore.upsertNode({ publicKey: MC_KEY, name: 'Repeater' } as never, h.sourceB);
    await sm(h.sourceA, 'sa');
    await sm(h.sourceA, 'sa', { fixAt: start + 2000, latitude: 40.2, longitude: -105.2 });
    await rx(h.sourceA, 'sa');
    await rx(h.sourceA, 'sa', { snr: -4, heardAt: start + 2000 });
    await rx(h.sourceA, 'sa', { creditedKey: idOf(HIDDEN_NUM), creditedNodeNum: HIDDEN_NUM, snr: 9 });
    await rx(h.sourceA, 'sa', { creditedKey: idOf(GONE_NUM), creditedNodeNum: GONE_NUM, snr: 8 });
  });

  afterEach(async () => {
    for (const s of [h.sourceA, h.sourceB]) await h.db.coverageWalkabout.deleteForSource(s);
    await h.cleanup();
  });

  it('anonymous gets 401 on all three routes', async () => {
    const agent = await h.loginAs(null);
    const a = h.sourceA;
    expect((await agent.get(url(a, '/cells?window=7d'))).status).toBe(401);
    expect((await agent.get(url(a, `/cell-nodes?window=7d&cell=${CELL9}`))).status).toBe(401);
    expect((await agent.get(url(a, '/sessions/sa/track'))).status).toBe(401);
  });

  it('nodes:read on A passes on A and 403s on B, for all three routes', async () => {
    await h.grant(h.limited.id, 'nodes', 'read', h.sourceA);
    const agent = await h.loginAs(h.limited);
    expect((await agent.get(url(h.sourceA, '/cells?window=7d'))).status).toBe(200);
    expect((await agent.get(url(h.sourceA, `/cell-nodes?window=7d&cell=${CELL9}`))).status).toBe(200);
    expect((await agent.get(url(h.sourceA, '/sessions/sa/track'))).status).toBe(200);
    expect((await agent.get(url(h.sourceB, '/cells?window=7d'))).status).toBe(403);
    expect((await agent.get(url(h.sourceB, `/cell-nodes?window=7d&cell=${CELL9}`))).status).toBe(403);
    expect((await agent.get(url(h.sourceB, '/sessions/sb/track'))).status).toBe(403);
  });

  describe('validation', () => {
    const bad = (q: string) => async () => {
      const agent = await h.loginAs(h.admin);
      const res = await agent.get(url(h.sourceA, `/cells?${q}`));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'INVALID_WALKABOUT' });
      expect(typeof res.body.error).toBe('string');
    };
    it('no mode', bad(''));
    it('two modes', bad('window=7d&sessionId=sa'));
    it('window=1y', bad('window=1y'));
    it('res=6', bad('window=7d&res=6'));
    it('since > until', bad('since=2000&until=1000'));
    it('span over 31 days', bad(`since=0&until=${32 * 86_400_000}`));
    it('since without until', bad('since=1000'));
    it('bad node', bad('window=7d&node=zzz'));
    it('bad sessionId', bad('sessionId=a%20b'));
    it('bad cell on /cell-nodes', async () => {
      const agent = await h.loginAs(h.admin);
      for (const c of ['', 'nope', latLngToCell(LAT, LON, 6)]) {
        const res = await agent.get(url(h.sourceA, `/cell-nodes?window=7d&cell=${c}`));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_WALKABOUT');
      }
    });
  });

  it('a session of another source is a 404 on all three routes', async () => {
    await h.grant(h.limited.id, 'nodes', 'read', h.sourceA);
    const agent = await h.loginAs(h.limited);
    for (const p of [`/cells?sessionId=sb`, `/cell-nodes?sessionId=sb&cell=${CELL9}`, '/sessions/sb/track']) {
      const res = await agent.get(url(h.sourceA, p));
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ success: false, code: 'WALKABOUT_NOT_FOUND' });
    }
  });

  it('admin: envelope, best-per-cell, hidden and deleted nodes dropped and counted', async () => {
    const agent = await h.loginAs(h.admin);
    const res = await agent.get(url(h.sourceA, '/cells?window=7d&res=9'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(d.res).toBe(9);
    expect(d.hiddenReceptionCount).toBe(2); // hideFromMap node + node deleted from the source
    const cell = d.cells.find((c: { cell: string }) => c.cell === CELL9);
    expect(cell).toMatchObject({ bestSnr: 3, receptionCount: 2, nodeCount: 1, sampleCount: 1 });
    expect(d.cells.some((c: { receptionCount: number; sampleCount: number }) => c.receptionCount === 0 && c.sampleCount > 0)).toBe(true);
    expect(d.bounds).toMatchObject({ bboxSouth: LAT, bboxNorth: 40.2 });
  });

  it('node=hidden gives an empty result and no count', async () => {
    const agent = await h.loginAs(h.admin);
    const res = await agent.get(url(h.sourceA, `/cells?window=7d&node=${idOf(HIDDEN_NUM)}`));
    expect(res.body.data).toMatchObject({ cells: [], hiddenReceptionCount: 0, bounds: null });
  });

  it('non-admin without channel viewOnMap sees sample cells only; with the grant the hexes appear', async () => {
    await h.grant(h.limited.id, 'nodes', 'read', h.sourceA);
    const agent = await h.loginAs(h.limited);
    let d = (await agent.get(url(h.sourceA, '/cells?sessionId=sa'))).body.data;
    expect(d.cells.length).toBeGreaterThan(0);
    expect(d.cells.every((c: { receptionCount: number }) => c.receptionCount === 0)).toBe(true);
    expect(d.hiddenReceptionCount).toBeGreaterThan(0);
    await h.grant(h.limited.id, 'channel_0', 'viewOnMap', h.sourceA);
    d = (await agent.get(url(h.sourceA, '/cells?sessionId=sa'))).body.data;
    expect(d.cells.find((c: { cell: string }) => c.cell === CELL9).receptionCount).toBe(2);
  });

  it('MeshCore source: nodes:viewOnMap gates the hexes', async () => {
    await rx(h.sourceB, 'sb', { protocol: 'meshcore', creditedKey: MC_KEY, creditedNodeNum: null });
    await h.grant(h.limited.id, 'nodes', 'read', h.sourceB);
    const agent = await h.loginAs(h.limited);
    let d = (await agent.get(url(h.sourceB, '/cells?sessionId=sb'))).body.data;
    expect(d.cells).toEqual([]);
    expect(d.hiddenReceptionCount).toBe(1);
    await h.revokeAll(h.limited.id);
    await h.db.auth.createPermission({
      userId: h.limited.id, resource: 'nodes', canRead: true, canWrite: false, canViewOnMap: true,
      sourceId: h.sourceB, grantedAt: Date.now(), grantedBy: null,
    } as never);
    d = (await agent.get(url(h.sourceB, '/cells?sessionId=sb'))).body.data;
    expect(d.cells[0]).toMatchObject({ receptionCount: 1, nodeCount: 1 });
    const n = (await agent.get(url(h.sourceB, `/cell-nodes?sessionId=sb&cell=${CELL9}`))).body.data;
    expect(n.nodes).toEqual([
      expect.objectContaining({ protocol: 'meshcore', publicKey: MC_KEY, nodeId: null, longName: 'Repeater', shortName: null }),
    ]);
  });

  it('cell-nodes names Meshtastic nodes and drops hidden or deleted ones; res comes from the cell', async () => {
    const agent = await h.loginAs(h.admin);
    const res = await agent.get(url(h.sourceA, `/cell-nodes?window=7d&cell=${latLngToCell(LAT, LON, 7)}`));
    expect(res.status).toBe(200);
    expect(res.body.data.cell).toBe(latLngToCell(LAT, LON, 7));
    expect(res.body.data.nodes).toEqual([
      expect.objectContaining({
        protocol: 'meshtastic', nodeId: idOf(OK_NUM), nodeNum: OK_NUM, publicKey: null,
        longName: 'Alpha', shortName: 'AL', bestSnr: 3, receptionCount: 2,
      }),
    ]);
  });

  it('track: clipped to the session, ordered by fixAt, pairs', async () => {
    await sm(h.sourceA, 'sa', { fixAt: start - 1000, latitude: 1, longitude: 1 }); // before start
    await sm(h.sourceA, 'sa', { fixAt: end() + 1, latitude: 2, longitude: 2 }); // after end
    const agent = await h.loginAs(h.admin);
    const res = await agent.get(url(h.sourceA, '/sessions/sa/track'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { sessionId: 'sa', positions: [[LAT, LON], [40.2, -105.2]], truncated: false },
    });
    expect((await agent.get(url(h.sourceA, '/sessions/nope/track'))).status).toBe(404);
  });
});
