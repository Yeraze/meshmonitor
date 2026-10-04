/**
 * Every server-side reader of the `traceroutes` table, against rows written
 * through the REAL write path in both stored orientations.
 *
 * One logical run is stored two ways (src/utils/tracerouteOrientation.ts):
 *   - sent from MeshMonitor: a pending row, then the reply fills it in.
 *     On disk: { from: requester, to: responder }.
 *   - a reply with no pending row (sent from a phone app, or the pending row
 *     timed out). On disk: { from: responder, to: requester }.
 * The route and SNR arrays are identical in both. Each reader below must give
 * the same answer whichever form the row has.
 *
 * The run has TWO forward hops on purpose. With zero or one hop, reading the
 * endpoints the wrong way round still gives the same set of links; with two,
 * it invents links that do not exist (responder–first hop, last hop–requester).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import tracerouteRoutes from './tracerouteRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import {
  STORED_FORMS, clearSourceLocalNode, nodeIdFor, setSourceLocalNode, storedTracerouteRows,
  writeReplyOnlyRun, writeRun, writeSentRun, type TracerouteRunSpec,
} from '../test-helpers/tracerouteFixtures.js';
import { decomposeTraceroute, decomposeTracerouteLinks } from '../../utils/tracerouteSegments.js';
import { buildObservations } from '../services/positionEstimationService.js';
import { discoverTracerouteNeighbors } from '../services/autoFavoriteManagementService.js';
import { analyzeTraceroutes } from '../../hooks/useTracerouteAnalysis.js';
import { getEnvironmentConfig } from '../config/environment.js';

const LOCAL = 0x7a000001; // our radio: asked
const H1 = 0x7a000002;
const H2 = 0x7a000003;
const REMOTE = 0x7a000004; // answered
const H3 = 0x7a000005; // return leg only

// out:  LOCAL -> H1 -> H2 -> REMOTE     arrival SNR 1, 2, 3 dB
// back: REMOTE -> H3 -> LOCAL           arrival SNR 4, 5 dB
const TRUE_LINKS = [
  { leg: 'forward', fromNodeNum: LOCAL, toNodeNum: H1, snrDb: 1 },
  { leg: 'forward', fromNodeNum: H1, toNodeNum: H2, snrDb: 2 },
  { leg: 'forward', fromNodeNum: H2, toNodeNum: REMOTE, snrDb: 3 },
  { leg: 'return', fromNodeNum: REMOTE, toNodeNum: H3, snrDb: 4 },
  { leg: 'return', fromNodeNum: H3, toNodeNum: LOCAL, snrDb: 5 },
];

describe('traceroute readers, both stored orientations', () => {
  let harness: RouteTestHarness;
  let runSpec: TracerouteRunSpec;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', tracerouteRoutes) });
    await harness.db.traceroutes.deleteAllTraceroutes(harness.sourceA);
    await setSourceLocalNode(harness.sourceA, LOCAL);
    runSpec = {
      sourceId: harness.sourceA,
      requester: LOCAL,
      responder: REMOTE,
      route: [H1, H2],
      routeBack: [H3],
      snrTowards: [4, 8, 12],
      snrBack: [16, 20],
      packetId: 4242,
      timestamp: Date.now() - 1000,
    };
  });

  afterEach(async () => {
    await harness.db.traceroutes.deleteAllTraceroutes(harness.sourceA);
    await clearSourceLocalNode(harness.sourceA);
    await harness.cleanup();
  });

  it('the two write paths really do store the run the two ways round', async () => {
    await writeSentRun(runSpec);
    await writeReplyOnlyRun({ ...runSpec, packetId: 4243 });
    const stored = await storedTracerouteRows(harness.sourceA);
    expect(stored.map((r) => [Number(r.fromNodeNum), Number(r.toNodeNum)])).toEqual([
      [LOCAL, REMOTE],
      [REMOTE, LOCAL],
    ]);
    // Same arrays in both: nothing rewrites them.
    for (const r of stored) {
      expect(r).toMatchObject({ route: JSON.stringify([H1, H2]), routeBack: JSON.stringify([H3]) });
    }
  });

  describe.each(STORED_FORMS)('stored form: %s', (form) => {
    beforeEach(async () => {
      await writeRun(form, runSpec);
    });

    const expectRequesterFirst = (row: Record<string, unknown>) => {
      expect(row).toMatchObject({
        fromNodeNum: LOCAL, toNodeNum: REMOTE,
        fromNodeId: nodeIdFor(LOCAL), toNodeId: nodeIdFor(REMOTE),
        route: JSON.stringify([H1, H2]), routeBack: JSON.stringify([H3]),
        snrTowards: '[4,8,12]', snrBack: '[16,20]',
      });
    };

    it('GET /recent (dashboard widget, node map, poll parity)', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/recent?sourceId=${harness.sourceA}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expectRequesterFirst(res.body[0]);
      expect(res.body[0].hopCount).toBe(2);
    });

    it('GET /history/:a/:b, asked either way round (Traceroute History dialog)', async () => {
      const agent = await harness.loginAs(harness.admin);
      for (const [a, b] of [[LOCAL, REMOTE], [REMOTE, LOCAL]]) {
        const res = await agent.get(`/history/${a}/${b}?sourceId=${harness.sourceA}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expectRequesterFirst(res.body[0]);
      }
    });

    it('GET /participation/:nodeNum (node traceroute panel)', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/participation/${REMOTE}?sourceId=${harness.sourceA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.entries).toHaveLength(1);
      expectRequesterFirst(res.body.data.entries[0]);
      expect(res.body.data.entries[0]).toMatchObject({ participation: 'endpoint', hopCount: 2 });
    });

    it('GET /explorer (Traceroute Explorer report)', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/explorer');
      expect(res.status).toBe(200);
      const runs = res.body.data.runs.filter((r: { packetId: number | null }) => r.packetId === 4242);
      expect(runs).toHaveLength(1);
      // The explorer row carries node numbers only, no id strings.
      expect(runs[0]).toMatchObject({
        fromNodeNum: LOCAL, toNodeNum: REMOTE,
        route: JSON.stringify([H1, H2]), routeBack: JSON.stringify([H3]),
        snrTowards: '[4,8,12]', snrBack: '[16,20]',
      });
    });

    it('hop links and map segments (map layers, embed, Mesh Issues RF graph)', async () => {
      const [row] = await databaseService.traceroutes.getAllTraceroutes(10, harness.sourceA);
      expect(decomposeTracerouteLinks(row).map(({ leg, fromNodeNum, toNodeNum, snrDb }) => ({ leg, fromNodeNum, toNodeNum, snrDb })))
        .toEqual(TRUE_LINKS);

      const pos = new Map([LOCAL, H1, H2, REMOTE, H3].map((n, i) => [n, [30 + i, -90 - i] as [number, number]]));
      const segments = decomposeTraceroute(row, { resolvePosition: (n) => pos.get(n) ?? null });
      expect(segments.map((s) => s.key)).toEqual([
        `forward:${LOCAL}-${H1}`, `forward:${H1}-${H2}`, `forward:${H2}-${REMOTE}`,
        `return:${REMOTE}-${H3}`, `return:${H3}-${LOCAL}`,
      ]);
    });

    it('Map Analysis rows (AnalysisRepository.getTraceroutes -> analyzeTraceroutes)', async () => {
      const { items } = await databaseService.analysis.getTraceroutes({ sourceIds: [harness.sourceA], sinceMs: 0, pageSize: 50 });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ fromNodeNum: LOCAL, toNodeNum: REMOTE });

      const positionByKey = new Map([LOCAL, H1, H2, REMOTE, H3].map((n, i) => [`${harness.sourceA}:${n}`, [30 + i, -90 - i] as [number, number]]));
      const { segments } = analyzeTraceroutes({
        traceroutes: items, positionByKey, selectedNodeNum: null, selectedSourceId: null,
        options: { directionMode: 'both', scopeToSelectedNode: false, minOccurrences: 1, minSnr: null },
        visibleNodeNums: null, timeWindow: null,
      });
      const got = segments.map((s) => `${s.from}>${s.to}@${s.avgSnr}`).sort();
      expect(got).toEqual(TRUE_LINKS.map((l) => `${l.fromNodeNum}>${l.toNodeNum}@${l.snrDb}`).sort());
    });

    it('position estimation: an unlocated first hop is anchored on its real neighbours', async () => {
      const rows = await databaseService.traceroutes.getAllTraceroutes(10, harness.sourceA);
      const anchors = new Map([LOCAL, H2, REMOTE, H3].map((n, i) => [n, { lat: 30 + i, lon: -90 - i }]));
      const obs = buildObservations(
        rows.map((r) => ({
          fromNodeNum: Number(r.fromNodeNum), toNodeNum: Number(r.toNodeNum),
          route: r.route, routeBack: r.routeBack, snrTowards: r.snrTowards, snrBack: r.snrBack, timestamp: r.timestamp,
        })),
        [],
        anchors,
      );
      // H1 sits between our radio and H2. Read the wrong way round it would
      // be placed next to REMOTE, the far end of the run.
      expect((obs.get(H1) ?? []).map((o) => o.anchorNodeNum).sort()).toEqual([LOCAL, H2].sort());
    });

    it('auto-favourite neighbour discovery: our radio\'s neighbours are the first hop out and the last hop back', async () => {
      const rows = await databaseService.traceroutes.getAllTraceroutes(10, harness.sourceA);
      expect(discoverTracerouteNeighbors(rows as any, LOCAL).sort()).toEqual([H1, H3].sort());
      expect(discoverTracerouteNeighbors(rows as any, REMOTE).sort()).toEqual([H2, H3].sort());
    });
  });

  describe('per-pair history', () => {
    const limit = getEnvironmentConfig().tracerouteHistoryLimit;

    it('keeps one limit for a pair whose runs are stored both ways round, and "latest" finds the newest of either', async () => {
      const base = Date.now() - 10 * 60_000;
      const perForm = Math.ceil(limit * 0.6); // 2 x perForm > limit
      for (let i = 0; i < perForm; i++) {
        await writeSentRun({ ...runSpec, packetId: 1000 + 2 * i, timestamp: base + 2 * i });
        await writeReplyOnlyRun({ ...runSpec, packetId: 1001 + 2 * i, timestamp: base + 2 * i + 1 });
      }
      const newest = 1001 + 2 * (perForm - 1);

      // Keyed on (from, to) as stored, each form had its own limit and the
      // pair kept up to twice as many runs.
      const stored = await storedTracerouteRows(harness.sourceA);
      expect(stored).toHaveLength(limit);
      expect(new Set(stored.map((r) => Number(r.fromNodeNum)))).toEqual(new Set([LOCAL, REMOTE]));

      const [latest] = await databaseService.traceroutes.getTraceroutesByNodes(LOCAL, REMOTE, 1, harness.sourceA);
      expect(Number(latest.packetId)).toBe(newest);

      const kept = await databaseService.traceroutes.getTraceroutesByNodes(LOCAL, REMOTE, limit * 3, harness.sourceA);
      expect(kept).toHaveLength(limit);
      // The survivors are the newest `limit` runs, with no gap.
      expect(kept.map((r) => Number(r.packetId))).toEqual(
        Array.from({ length: limit }, (_, i) => newest - i),
      );
    });
  });
});
