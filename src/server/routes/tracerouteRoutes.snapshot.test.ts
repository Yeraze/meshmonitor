/**
 * The #1862 position snapshot (`traceroutes.routePositions`) and `channel`,
 * end to end: built from real node rows, written through the REAL write path
 * (`recordTracerouteRequestAsync` + `insertTracerouteAsync`, the two calls
 * `sendTraceroute` and `processTracerouteMessage` make), served by the real
 * routes, and drawn by the reader the map, the dashboard and the widget share.
 *
 * Before the fix the SQLite upsert and the pending-row update dropped both
 * columns, so a run sent from MeshMonitor reached the map with no snapshot and
 * drew at the nodes' CURRENT positions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import tracerouteRoutes from './tracerouteRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import {
  STORED_FORMS, clearSourceLocalNode, nodeIdFor, setSourceLocalNode, storedTracerouteRows,
  writeRun, type TracerouteRunSpec,
} from '../test-helpers/tracerouteFixtures.js';
import { buildRoutePositionsSnapshot } from '../utils/tracerouteSnapshot.js';
import {
  decomposeTraceroute, parseSnapshotRoutePositions, resolveSegmentPosition,
} from '../../utils/tracerouteSegments.js';

const LOCAL = 0x7b000001; // our radio: asked
const HOP = 0x7b000002;
const REMOTE = 0x7b000003; // answered
const HOP_PRIVATE = 0x7b000004; // return leg, private position pin
const CHANNEL = 2;

// Where the nodes stood when the run was recorded...
const THEN: Record<number, [number, number]> = {
  [LOCAL]: [30.0, -90.0],
  [HOP]: [30.1, -90.1],
  [REMOTE]: [30.2, -90.2],
};
// ...and where they are when someone looks at it later.
const NOW: Record<number, [number, number]> = {
  [LOCAL]: [40.0, -80.0],
  [HOP]: [40.1, -80.1],
  [REMOTE]: [40.2, -80.2],
};
const PRIVATE_PIN: [number, number] = [35.5, -85.5];

describe('traceroute position snapshot, through the real write path', () => {
  let harness: RouteTestHarness;
  let runSpec: TracerouteRunSpec;

  const seedNode = (nodeNum: number, [latitude, longitude]: [number, number]) =>
    harness.db.nodes.upsertNode(
      {
        nodeNum, nodeId: nodeIdFor(nodeNum), longName: `Node ${nodeNum.toString(16)}`, shortName: 'N',
        channel: 0, latitude, longitude, lastHeard: Math.floor(Date.now() / 1000),
      },
      harness.sourceA,
    );

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', tracerouteRoutes) });
    await harness.db.traceroutes.deleteAllTraceroutes(harness.sourceA);
    await setSourceLocalNode(harness.sourceA, LOCAL);
    for (const n of [LOCAL, HOP, REMOTE]) await seedNode(n, THEN[n]);
    await seedNode(HOP_PRIVATE, [33.3, -83.3]);
    await harness.db.setNodePositionOverrideAsync(
      HOP_PRIVATE, true, harness.sourceA, PRIVATE_PIN[0], PRIVATE_PIN[1], undefined, true,
    );

    // The snapshot exactly as processTracerouteMessage builds it: every node
    // on the run, read from the run's own source.
    const routePositions = await buildRoutePositionsSnapshot(
      [LOCAL, HOP, REMOTE, HOP_PRIVATE],
      (n) => harness.db.nodes.getNode(n, harness.sourceA),
    );
    runSpec = {
      sourceId: harness.sourceA,
      requester: LOCAL,
      responder: REMOTE,
      route: [HOP],
      routeBack: [HOP_PRIVATE],
      snrTowards: [4, 8],
      snrBack: [12, 16],
      packetId: 5150,
      channel: CHANNEL,
      routePositions,
      timestamp: Date.now() - 1000,
    };
  });

  afterEach(async () => {
    await harness.db.traceroutes.deleteAllTraceroutes(harness.sourceA);
    for (const n of [LOCAL, HOP, REMOTE, HOP_PRIVATE]) await harness.db.nodes.deleteNodeRecord(n, harness.sourceA).catch(() => {});
    await clearSourceLocalNode(harness.sourceA);
    await harness.cleanup();
  });

  it('the snapshot holds every positioned node on the run, and not the private pin', () => {
    const snap = JSON.parse(runSpec.routePositions!);
    expect(snap).toEqual({
      [LOCAL]: { lat: 30.0, lng: -90.0 },
      [HOP]: { lat: 30.1, lng: -90.1 },
      [REMOTE]: { lat: 30.2, lng: -90.2 },
    });
    expect(runSpec.routePositions).not.toContain('35.5');
  });

  describe.each(STORED_FORMS)('stored form: %s', (form) => {
    beforeEach(async () => {
      await writeRun(form, runSpec);
    });

    it('the row on disk carries routePositions and channel', async () => {
      const stored = await storedTracerouteRows(harness.sourceA);
      expect(stored).toHaveLength(1);
      expect(stored[0].routePositions).toBe(runSpec.routePositions);
      expect(stored[0].channel).toBe(CHANNEL);
      // And the form really is the one this block names.
      expect([Number(stored[0].fromNodeNum), Number(stored[0].toNodeNum)])
        .toEqual(form === 'sent' ? [LOCAL, REMOTE] : [REMOTE, LOCAL]);
    });

    it('GET /recent and GET /history serve the snapshot', async () => {
      const agent = await harness.loginAs(harness.admin);
      const recent = await agent.get(`/recent?sourceId=${harness.sourceA}`);
      expect(recent.status).toBe(200);
      expect(recent.body).toHaveLength(1);
      expect(JSON.parse(recent.body[0].routePositions)).toEqual(JSON.parse(runSpec.routePositions!));

      const history = await agent.get(`/history/${LOCAL}/${REMOTE}?sourceId=${harness.sourceA}`);
      expect(history.status).toBe(200);
      expect(JSON.parse(history.body[0].routePositions)).toEqual(JSON.parse(runSpec.routePositions!));
    });

    it('the reader draws the run where the nodes were THEN, after they have moved', async () => {
      const agent = await harness.loginAs(harness.admin);
      const [row] = (await agent.get(`/recent?sourceId=${harness.sourceA}`)).body;

      // Exactly what useTraceroutePaths / DashboardMap / TracerouteWidget do.
      const live = new Map<number, [number, number]>(Object.entries(NOW).map(([n, p]) => [Number(n), p]));
      const snapshot = parseSnapshotRoutePositions(row.routePositions);
      const segments = decomposeTraceroute(row, {
        resolvePosition: (n) => resolveSegmentPosition(n, snapshot, live),
      });

      const forward = segments.filter((s) => s.leg === 'forward');
      expect(forward.map((s) => [s.fromNodeNum, s.toNodeNum, s.from, s.to])).toEqual([
        [LOCAL, HOP, THEN[LOCAL], THEN[HOP]],
        [HOP, REMOTE, THEN[HOP], THEN[REMOTE]],
      ]);
      // The private-pin hop is in neither the snapshot nor this viewer's live
      // set, so no return segment touches it: nothing is drawn at the pin.
      expect(segments.filter((s) => s.leg === 'return')).toEqual([]);
      expect(JSON.stringify(segments)).not.toContain('35.5');
    });
  });

  it('a row with NO snapshot (written before the fix) falls back to current positions', async () => {
    await writeRun('sent', { ...runSpec, routePositions: undefined });
    // What the old writers left on disk: the column NULL, not '{}'.
    const repo = harness.db.traceroutes as unknown as {
      tables: { traceroutes: unknown };
      db: { update: (t: unknown) => { set: (v: unknown) => Promise<unknown> } };
    };
    await repo.db.update(repo.tables.traceroutes).set({ routePositions: null });
    expect((await storedTracerouteRows(harness.sourceA))[0].routePositions).toBeNull();

    const agent = await harness.loginAs(harness.admin);
    const [row] = (await agent.get(`/recent?sourceId=${harness.sourceA}`)).body;
    expect(row.routePositions ?? null).toBeNull();

    const live = new Map<number, [number, number]>(Object.entries(NOW).map(([n, p]) => [Number(n), p]));
    const snapshot = parseSnapshotRoutePositions(row.routePositions);
    expect(snapshot.size).toBe(0);
    const forward = decomposeTraceroute(row, {
      resolvePosition: (n) => resolveSegmentPosition(n, snapshot, live),
    }).filter((s) => s.leg === 'forward');
    expect(forward.map((s) => [s.from, s.to])).toEqual([
      [NOW[LOCAL], NOW[HOP]],
      [NOW[HOP], NOW[REMOTE]],
    ]);
  });

  it('a snapshot that misses one node uses the snapshot where it can and live for the rest', () => {
    const snapshot = parseSnapshotRoutePositions(JSON.stringify({ [LOCAL]: { lat: 30.0, lng: -90.0 } }));
    const live = new Map<number, [number, number]>([[LOCAL, NOW[LOCAL]], [HOP, NOW[HOP]]]);
    expect(resolveSegmentPosition(LOCAL, snapshot, live)).toEqual(THEN[LOCAL]);
    expect(resolveSegmentPosition(HOP, snapshot, live)).toEqual(NOW[HOP]);
    expect(resolveSegmentPosition(REMOTE, snapshot, live)).toBeNull();
  });
});
