/**
 * Tests for positionEstimationService — the global, batch, multilateration
 * position estimator (issue #3271).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the database singleton before importing the service.
// vi.hoisted keeps the mock object available to the hoisted vi.mock factory.
const mockDb = vi.hoisted(() => ({
  sources: { getAllSources: vi.fn() },
  nodes: { getAllNodes: vi.fn() },
  traceroutes: { getAllTraceroutes: vi.fn() },
  neighbors: { getAllNeighborInfo: vi.fn() },
  upsertEstimatedPositionsAsync: vi.fn(),
  deleteEstimatedPositionsByNodeNumsAsync: vi.fn(),
  replaceEstimatedPositionAnchorsAsync: vi.fn(),
}));
vi.mock('../../services/database.js', () => ({ default: mockDb }));

import {
  solveNodePosition,
  buildObservations,
  observationWeight,
  positionEstimationService,
  DEFAULT_SINGLE_ANCHOR_KM,
  MAX_STORED_ANCHORS_PER_NODE,
  type PositionObservation,
  type TracerouteForEstimation,
  type NeighborForEstimation,
} from './positionEstimationService.js';
import { DEFAULT_MAX_UNCERTAINTY_KM } from './positionEstimationScheduler.js';

const NOW = 1_700_000_000_000;

function obs(partial: Partial<PositionObservation>): PositionObservation {
  return {
    nodeNum: 1,
    anchorNodeNum: 999,
    anchorLat: 0,
    anchorLon: 0,
    timestamp: NOW,
    kind: 'traceroute',
    ...partial,
  };
}

describe('solveNodePosition', () => {
  it('returns null for no observations', () => {
    expect(solveNodePosition([], NOW)).toBeNull();
  });

  it('places the estimate at the centroid of four symmetric anchors', () => {
    const d = 0.1; // ~11km
    const anchors = [
      obs({ anchorLat: 10 + d, anchorLon: 20 }),
      obs({ anchorLat: 10 - d, anchorLon: 20 }),
      obs({ anchorLat: 10, anchorLon: 20 + d }),
      obs({ anchorLat: 10, anchorLon: 20 - d }),
    ];
    const solved = solveNodePosition(anchors, NOW)!;
    expect(solved.latitude).toBeCloseTo(10, 5);
    expect(solved.longitude).toBeCloseTo(20, 5);
    expect(solved.observationCount).toBe(4);
  });

  it('a single traceroute segment yields the midpoint of its two anchors', () => {
    const segment = [
      obs({ anchorLat: 10, anchorLon: 20 }),
      obs({ anchorLat: 12, anchorLon: 20 }),
    ];
    const solved = solveNodePosition(segment, NOW)!;
    expect(solved.latitude).toBeCloseTo(11, 5);
    expect(solved.longitude).toBeCloseTo(20, 5);
  });

  it('a spread-out 2-anchor estimate is less certain than a tight 4-anchor cluster', () => {
    const farPair = solveNodePosition([
      obs({ anchorLat: 10, anchorLon: 20 }),
      obs({ anchorLat: 12, anchorLon: 20 }),
    ], NOW)!;
    const tightCluster = solveNodePosition([
      obs({ anchorLat: 10.01, anchorLon: 20 }),
      obs({ anchorLat: 9.99, anchorLon: 20 }),
      obs({ anchorLat: 10, anchorLon: 20.01 }),
      obs({ anchorLat: 10, anchorLon: 19.99 }),
    ], NOW)!;
    expect(farPair.uncertaintyKm).toBeGreaterThan(tightCluster.uncertaintyKm);
  });

  it('biases the estimate toward the higher-SNR anchor', () => {
    const solved = solveNodePosition([
      obs({ anchorLat: 10, anchorLon: 20, snrDb: 12 }),  // strong → closer
      obs({ anchorLat: 14, anchorLon: 20, snrDb: -4 }),  // weak → farther
    ], NOW)!;
    // Strong anchor at lat 10, weak at lat 14 → estimate pulled below midpoint (12).
    expect(solved.latitude).toBeLessThan(12);
    expect(solved.latitude).toBeGreaterThan(10);
  });

  it('down-weights stale observations via time decay', () => {
    const fresh = observationWeight(obs({ timestamp: NOW }), NOW);
    const dayOld = observationWeight(obs({ timestamp: NOW - 24 * 60 * 60 * 1000 }), NOW);
    expect(dayOld).toBeCloseTo(fresh / 2, 5); // 24h half-life
  });

  describe('SNR → weight ordering (issue #3616)', () => {
    // The weight model must be 10^(snr/10): higher (less negative) SNR → higher
    // weight → node pulled toward that anchor. A weak link must NOT pull harder.
    it('maps higher SNR to higher weight (not inverted)', () => {
      const w = (snrDb: number) => observationWeight(obs({ snrDb }), NOW);
      // Independently computed expected weights: 10^(-12/10)≈0.063, 10^0=1, 10^1=10.
      expect(w(-12)).toBeCloseTo(0.0631, 4);
      expect(w(0)).toBeCloseTo(1, 5);
      expect(w(10)).toBeCloseTo(10, 5);
      // Strictly increasing with SNR — the whole point of issue #3616.
      expect(w(-12)).toBeLessThan(w(0));
      expect(w(0)).toBeLessThan(w(10));
    });
  });

  describe('single low-confidence anchor stays uncertain (issue #3616)', () => {
    // A node seen by exactly one anchor at -12 dB collapses to that anchor (the
    // max-likelihood point for a single observation) but MUST report a large,
    // unreliable radius — not a tight confident one.
    it('a lone -12 dB anchor reports the full radio-range uncertainty', () => {
      const solved = solveNodePosition([
        obs({ anchorLat: 10, anchorLon: 20, snrDb: -12 }),
      ], NOW)!;
      expect(solved.latitude).toBeCloseTo(10, 5);  // at the anchor
      expect(solved.uncertaintyKm).toBe(5);        // DEFAULT_SINGLE_ANCHOR_KM, unreliable
    });

    // The regression case from issue #3616: a strong anchor and a far weak (-12 dB)
    // anchor. The centroid collapses onto the strong anchor and the weak/far one
    // barely contributes to the weighted RMS. Before the fix nEff was ~1.01 (just
    // above the old `nEff <= 1` cutoff) so it skipped the radio-range default and
    // reported a spuriously tight <1 km radius. It must now stay large/unreliable.
    it('does not report false confidence when one strong anchor dominates a far weak one', () => {
      const solved = solveNodePosition([
        obs({ anchorLat: 10.0, anchorLon: 20, snrDb: 10 }),    // strong, "reporter's house"
        obs({ anchorLat: 10.036, anchorLon: 20, snrDb: -12 }), // weak, ~4 km away
      ], NOW)!;
      // Estimate collapses onto the strong anchor (expected — it dominates).
      expect(solved.latitude).toBeCloseTo(10.0, 2);
      // ...but the radius reflects the near-single-observation confidence: large,
      // close to the radio-range default — NOT a sub-km confident circle.
      expect(solved.uncertaintyKm).toBeGreaterThan(4);
    });

    // Guard against regressing genuinely balanced multi-anchor estimates: equal
    // SNR anchors give nEff == anchor count, confidence == 1, so the radius is the
    // pure statistical estimate. A tight cluster must stay confident (small).
    it('keeps a balanced tight 4-anchor cluster confident', () => {
      const tight = solveNodePosition([
        obs({ anchorLat: 10.005, anchorLon: 20, snrDb: 0 }),
        obs({ anchorLat: 9.995, anchorLon: 20, snrDb: 0 }),
        obs({ anchorLat: 10, anchorLon: 20.005, snrDb: 0 }),
        obs({ anchorLat: 10, anchorLon: 19.995, snrDb: 0 }),
      ], NOW)!;
      expect(tight.latitude).toBeCloseTo(10, 4);
      expect(tight.uncertaintyKm).toBeLessThan(1); // confident, unchanged by the fix
    });
  });
});

// #4432 follow-up: a bogus anchor drags the weighted centroid to (0,0) and the
// resulting "estimate" gets substituted onto a node as though it were a fix.
// Two lines of defence: drop bogus anchors, and reject a solve that lands there.
describe('Null Island rejection (#4432 follow-up)', () => {
  it('returns null when the weighted centroid lands on Null Island', () => {
    // Legitimate anchors placed symmetrically about (0,0) average onto it —
    // the case anchor filtering alone cannot catch.
    const result = solveNodePosition(
      [
        obs({ anchorLat: 1, anchorLon: 1, snrDb: 0 }),
        obs({ anchorLat: -1, anchorLon: -1, snrDb: 0 }),
      ],
      NOW,
    );
    expect(result).toBeNull();
  });

  it('still solves normally when the centroid is a real position', () => {
    const result = solveNodePosition(
      [
        obs({ anchorLat: 35.0, anchorLon: -80.0, snrDb: 0 }),
        obs({ anchorLat: 35.2, anchorLon: -80.2, snrDb: 0 }),
      ],
      NOW,
    );
    expect(result).not.toBeNull();
    expect(result!.latitude).toBeCloseTo(35.1, 5);
  });

  it('solves for a genuine equator anchor pair (only BOTH axes near 0 is bogus)', () => {
    const result = solveNodePosition(
      [
        obs({ anchorLat: 0, anchorLon: 37.4, snrDb: 0 }),
        obs({ anchorLat: 0, anchorLon: 37.6, snrDb: 0 }),
      ],
      NOW,
    );
    expect(result).not.toBeNull();
    expect(result!.latitude).toBeCloseTo(0, 5);
    expect(result!.longitude).toBeCloseTo(37.5, 5);
  });

  it('drops a Null Island anchor before it can constrain a neighbour', () => {
    const anchors = new Map<number, { lat: number; lon: number }>([
      [10, { lat: 0, lon: 0 }],        // bogus — must not anchor anything
      [20, { lat: 35.1, lon: -80.6 }], // real
    ]);
    const neighbors: NeighborForEstimation[] = [
      { nodeNum: 1, neighborNodeNum: 10, snr: 5, timestamp: NOW },
      { nodeNum: 2, neighborNodeNum: 20, snr: 5, timestamp: NOW },
    ];

    const out = buildObservations([], neighbors, anchors);

    expect(out.get(1)).toBeUndefined();
    expect(out.get(2)).toHaveLength(1);
    expect(out.get(2)![0].anchorLat).toBeCloseTo(35.1, 5);
  });

  it('does not mutate the caller\'s anchors map', () => {
    const anchors = new Map<number, { lat: number; lon: number }>([[10, { lat: 0, lon: 0 }]]);

    buildObservations([], [], anchors);

    expect(anchors.size).toBe(1);
    expect(anchors.get(10)).toEqual({ lat: 0, lon: 0 });
  });
});

describe('buildObservations', () => {
  const anchors = new Map<number, { lat: number; lon: number }>([
    [100, { lat: 10, lon: 20 }],
    [200, { lat: 12, lon: 20 }],
  ]);

  it('anchors a traceroute intermediate to both positioned neighbors', () => {
    const trs: TracerouteForEstimation[] = [{
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([5]),       // path: 100 - 5 - 200
      routeBack: null,
      snrTowards: JSON.stringify([20, 24]),
      snrBack: null,
      timestamp: NOW,
    }];
    const out = buildObservations(trs, [], anchors);
    expect(out.has(5)).toBe(true);
    expect(out.get(5)!).toHaveLength(2);
  });

  it('does not estimate a node that already has a real position', () => {
    const trs: TracerouteForEstimation[] = [{
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([200]),     // 200 is an anchor, should be skipped
      routeBack: null,
      snrTowards: JSON.stringify([20, 24]),
      snrBack: null,
      timestamp: NOW,
    }];
    const out = buildObservations(trs, [], anchors);
    expect(out.has(200)).toBe(false);
  });

  it('anchors the unpositioned side of a neighbor pair', () => {
    const nbs: NeighborForEstimation[] = [
      { nodeNum: 100, neighborNodeNum: 7, snr: 6.5, timestamp: NOW },
    ];
    const out = buildObservations([], nbs, anchors);
    expect(out.get(7)).toHaveLength(1);
    expect(out.get(7)![0].kind).toBe('neighbor');
    expect(out.get(7)![0].anchorLat).toBe(10);
  });

  it('combines traceroute and neighbor observations for the same node', () => {
    const trs: TracerouteForEstimation[] = [{
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([9]),
      routeBack: null,
      snrTowards: JSON.stringify([20, 24]),
      snrBack: null,
      timestamp: NOW,
    }];
    const nbs: NeighborForEstimation[] = [
      { nodeNum: 200, neighborNodeNum: 9, snr: 5, timestamp: NOW },
    ];
    const out = buildObservations(trs, nbs, anchors);
    // 2 from traceroute (anchors 100 + 200) + 1 from neighbor (anchor 200) = 3
    expect(out.get(9)).toHaveLength(3);
    expect(out.get(9)!.some(o => o.kind === 'traceroute')).toBe(true);
    expect(out.get(9)!.some(o => o.kind === 'neighbor')).toBe(true);
  });
});

describe('positionEstimationService.recomputeAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pin system time so recomputeAll's internal Date.now() matches NOW-based fixtures.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockDb.traceroutes.getAllTraceroutes.mockResolvedValue([]);
    mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([]);
    mockDb.upsertEstimatedPositionsAsync.mockResolvedValue(undefined);
    mockDb.deleteEstimatedPositionsByNodeNumsAsync.mockResolvedValue(0);
    mockDb.replaceEstimatedPositionAnchorsAsync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pools anchors and observations across multiple Meshtastic sources into one estimate', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([
      { id: 'src-a', type: 'meshtastic_tcp' },
      { id: 'src-b', type: 'mqtt_broker' },
    ]);
    // Anchor 100 lives in source A, anchor 200 in source B (MQTT).
    mockDb.nodes.getAllNodes.mockImplementation(async (sourceId: string) => {
      if (sourceId === 'src-a') return [{ nodeNum: 100, latitude: 10, longitude: 20 }];
      if (sourceId === 'src-b') return [{ nodeNum: 200, latitude: 12, longitude: 20 }];
      return [];
    });
    // Traceroute heard on source A places node 5 between 100 and 200.
    mockDb.traceroutes.getAllTraceroutes.mockImplementation(async (_limit: number, sourceId: string) => {
      if (sourceId === 'src-a') return [{
        fromNodeNum: 100, toNodeNum: 200, route: JSON.stringify([5]),
        routeBack: null, snrTowards: JSON.stringify([20, 20]), snrBack: null, timestamp: NOW,
      }];
      return [];
    });

    const result = await positionEstimationService.recomputeAll({ lookbackMs: 7 * 24 * 60 * 60 * 1000 });

    expect(result.anchorCount).toBe(2);
    expect(result.estimatedNodeCount).toBe(1);
    const inputs = mockDb.upsertEstimatedPositionsAsync.mock.calls[0][0];
    expect(inputs).toHaveLength(1);
    expect(inputs[0].nodeNum).toBe(5);
    expect(inputs[0].latitude).toBeCloseTo(11, 5); // midpoint of cross-source anchors
  });

  it('excludes MeshCore sources', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([
      { id: 'mc', type: 'meshcore' },
      { id: 'mt', type: 'meshtastic_tcp' },
    ]);
    mockDb.nodes.getAllNodes.mockResolvedValue([]);

    await positionEstimationService.recomputeAll({ lookbackMs: 1000 });

    const queriedSources = mockDb.nodes.getAllNodes.mock.calls.map((c: any[]) => c[0]);
    expect(queriedSources).toContain('mt');
    expect(queriedSources).not.toContain('mc');
  });

  it('ignores observations older than the lookback window', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([{ id: 's', type: 'meshtastic_tcp' }]);
    mockDb.nodes.getAllNodes.mockResolvedValue([
      { nodeNum: 100, latitude: 10, longitude: 20 },
      { nodeNum: 200, latitude: 12, longitude: 20 },
    ]);
    const old = NOW - 30 * 24 * 60 * 60 * 1000; // 30 days ago
    mockDb.traceroutes.getAllTraceroutes.mockResolvedValue([{
      fromNodeNum: 100, toNodeNum: 200, route: JSON.stringify([5]),
      routeBack: null, snrTowards: JSON.stringify([20, 20]), snrBack: null, timestamp: old,
    }]);

    const result = await positionEstimationService.recomputeAll({ lookbackMs: 7 * 24 * 60 * 60 * 1000 });
    expect(result.estimatedNodeCount).toBe(0);
  });

  it('clears estimates for nodes that now have real positions', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([{ id: 's', type: 'meshtastic_tcp' }]);
    mockDb.nodes.getAllNodes.mockResolvedValue([
      { nodeNum: 100, latitude: 10, longitude: 20 },
      { nodeNum: 200, latitude: 12, longitude: 20 },
    ]);

    await positionEstimationService.recomputeAll({ lookbackMs: 1000 });

    const deletedNodeNums = mockDb.deleteEstimatedPositionsByNodeNumsAsync.mock.calls[0][0];
    expect(deletedNodeNums).toContain(100);
    expect(deletedNodeNums).toContain(200);
  });

  describe('maxUncertaintyKm threshold (issue #3271 follow-up)', () => {
    // A single-anchor neighbor observation yields the DEFAULT_SINGLE_ANCHOR_KM
    // (5 km) uncertainty — the dominant "huge circle" case.
    const singleAnchorSetup = () => {
      mockDb.sources.getAllSources.mockResolvedValue([{ id: 's', type: 'meshtastic_tcp' }]);
      mockDb.nodes.getAllNodes.mockResolvedValue([{ nodeNum: 100, latitude: 10, longitude: 20 }]);
      mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([
        { nodeNum: 100, neighborNodeNum: 5, snr: 10, timestamp: NOW },
      ]);
    };

    it('discards an estimate whose uncertainty exceeds the maximum and clears any stale row', async () => {
      singleAnchorSetup();
      const result = await positionEstimationService.recomputeAll({
        lookbackMs: 7 * 24 * 60 * 60 * 1000,
        maxUncertaintyKm: 3, // 5km estimate > 3km ceiling → rejected
      });
      expect(result.estimatedNodeCount).toBe(0);
      expect(result.rejectedNodeCount).toBe(1);
      // Nothing stored for the over-threshold node...
      expect(mockDb.upsertEstimatedPositionsAsync.mock.calls[0][0]).toHaveLength(0);
      // ...and its existing estimate (if any) is cleared.
      expect(mockDb.deleteEstimatedPositionsByNodeNumsAsync.mock.calls[0][0]).toContain(5);
    });

    it('rejects the single-anchor estimate at the SHIPPED default (#4450)', async () => {
      // The regression that mattered: the threshold machinery above always
      // worked, but DEFAULT_MAX_UNCERTAINTY_KM was 0 ("no limit"), so a stock
      // install stored single-anchor solves. Those sit at the anchor's exact
      // coordinates — and since the locally-connected node is itself an anchor,
      // that is the phantom pin on top of your own node reported in #4450.
      //
      // Asserted against the real exported default rather than a literal, so
      // this fails if it is ever raised back above the 5 km single-anchor radius.
      singleAnchorSetup();
      const result = await positionEstimationService.recomputeAll({
        lookbackMs: 7 * 24 * 60 * 60 * 1000,
        maxUncertaintyKm: DEFAULT_MAX_UNCERTAINTY_KM,
      });
      expect(result.estimatedNodeCount).toBe(0);
      expect(result.rejectedNodeCount).toBe(1);
      expect(mockDb.upsertEstimatedPositionsAsync.mock.calls[0][0]).toHaveLength(0);
      // The stale row is cleared too, so existing installs self-heal on the
      // next scheduled run rather than needing a manual purge.
      expect(mockDb.deleteEstimatedPositionsByNodeNumsAsync.mock.calls[0][0]).toContain(5);
    });

    it('keeps an estimate within the maximum', async () => {
      singleAnchorSetup();
      const result = await positionEstimationService.recomputeAll({
        lookbackMs: 7 * 24 * 60 * 60 * 1000,
        maxUncertaintyKm: 10, // 5km estimate ≤ 10km ceiling → kept
      });
      expect(result.estimatedNodeCount).toBe(1);
      expect(result.rejectedNodeCount).toBe(0);
      expect(mockDb.upsertEstimatedPositionsAsync.mock.calls[0][0]).toHaveLength(1);
    });

    it('treats maxUncertaintyKm 0 as no limit', async () => {
      singleAnchorSetup();
      const result = await positionEstimationService.recomputeAll({
        lookbackMs: 7 * 24 * 60 * 60 * 1000,
        maxUncertaintyKm: 0,
      });
      expect(result.estimatedNodeCount).toBe(1);
      expect(result.rejectedNodeCount).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #4609 — the rationale behind an estimated position.
//
// Before this, the estimator solved a position and discarded every observation
// that produced it, leaving no way to explain a pin. These tests pin down the
// three things that make an explanation possible: observations carry the
// identity of the node that anchored them, the solve reports which branch of
// the uncertainty math produced its radius, and the writer persists a capped,
// strongest-first anchor set.
// ---------------------------------------------------------------------------
describe('estimate rationale (#4609)', () => {
  describe('anchor identity', () => {
    it('records which node anchored each traceroute hop, on both sides', () => {
      const anchors = new Map<number, { lat: number; lon: number }>([
        [100, { lat: 10, lon: 20 }],
        [200, { lat: 12, lon: 20 }],
      ]);
      const traceroutes: TracerouteForEstimation[] = [{
        fromNodeNum: 100, toNodeNum: 200, route: JSON.stringify([5]),
        routeBack: null, snrTowards: JSON.stringify([20, 20]), snrBack: null, timestamp: NOW,
      }];

      const observations = buildObservations(traceroutes, [], anchors).get(5)!;

      expect(observations).toHaveLength(2);
      // Without anchorNodeNum the API could only say "some node at 10,20".
      expect(observations.map((o) => o.anchorNodeNum).sort()).toEqual([100, 200]);
      expect(observations.every((o) => o.kind === 'traceroute')).toBe(true);
    });

    it('records the anchoring node for a NeighborInfo pair, whichever side is positioned', () => {
      const anchors = new Map<number, { lat: number; lon: number }>([
        [100, { lat: 35.1, lon: -80.6 }],
      ]);
      const neighbors: NeighborForEstimation[] = [
        // Unpositioned node 1 reports positioned 100 as a neighbour.
        { nodeNum: 1, neighborNodeNum: 100, snr: 5, timestamp: NOW },
        // Positioned 100 reports unpositioned 2 as a neighbour — reverse direction.
        { nodeNum: 100, neighborNodeNum: 2, snr: -3, timestamp: NOW },
      ];

      const out = buildObservations([], neighbors, anchors);

      expect(out.get(1)![0].anchorNodeNum).toBe(100);
      expect(out.get(1)![0].kind).toBe('neighbor');
      expect(out.get(2)![0].anchorNodeNum).toBe(100);
      expect(out.get(2)![0].kind).toBe('neighbor');
    });
  });

  describe('radius derivation', () => {
    it('reports single_anchor for a lone observation (the flat 5 km heuristic)', () => {
      const solved = solveNodePosition([obs({ anchorLat: 35, anchorLon: -80 })], NOW)!;
      expect(solved.radiusMethod).toBe('single_anchor');
      expect(solved.nEff).toBeCloseTo(1, 6);
      expect(solved.uncertaintyKm).toBeCloseTo(DEFAULT_SINGLE_ANCHOR_KM, 6);
    });

    it('does not claim convergence when one strong anchor dominates the weights (#3616)', () => {
      // Two observations, but nEff barely exceeds 1 — the weak anchor
      // contributes almost nothing. The blend must stay pinned near the
      // radio-range default, so the reported radius does not imply a solve that
      // did not happen.
      const solved = solveNodePosition([
        obs({ anchorLat: 35.0, anchorLon: -80.0, snrDb: 20 }),
        obs({ anchorLat: 35.2, anchorLon: -80.0, snrDb: -20 }),
      ], NOW)!;
      expect(solved.nEff).toBeLessThan(1.1);
      expect(solved.radiusMethod).not.toBe('convergence');
      expect(solved.uncertaintyKm).toBeCloseTo(DEFAULT_SINGLE_ANCHOR_KM, 1);
    });

    it('reports convergence for a balanced multi-anchor solve', () => {
      // A tight, evenly weighted ring: nEff = 4 and the statistical radius is
      // well inside the lone-anchor default.
      const solved = solveNodePosition([
        obs({ anchorLat: 35.01, anchorLon: -80.0, snrDb: 0 }),
        obs({ anchorLat: 34.99, anchorLon: -80.0, snrDb: 0 }),
        obs({ anchorLat: 35.0, anchorLon: -80.01, snrDb: 0 }),
        obs({ anchorLat: 35.0, anchorLon: -79.99, snrDb: 0 }),
      ], NOW)!;
      expect(solved.nEff).toBeGreaterThanOrEqual(2);
      expect(solved.radiusMethod).toBe('convergence');
      expect(solved.uncertaintyKm).toBeLessThan(DEFAULT_SINGLE_ANCHOR_KM);
    });

    it('reports blended when confidence sits strictly between the two branches', () => {
      // Two equal-weight anchors give nEff = 2 exactly; unequal SNR lands nEff
      // in (1, 2) — the partial-convergence region.
      const solved = solveNodePosition([
        obs({ anchorLat: 35.0, anchorLon: -80.0, snrDb: 6 }),
        obs({ anchorLat: 35.1, anchorLon: -80.0, snrDb: 0 }),
      ], NOW)!;
      expect(solved.nEff).toBeGreaterThan(1);
      expect(solved.nEff).toBeLessThan(2);
      expect(solved.radiusMethod).toBe('blended');
      expect(solved.uncertaintyKm).toBeLessThan(DEFAULT_SINGLE_ANCHOR_KM);
    });

    it('returns used observations sorted strongest-contribution first', () => {
      const solved = solveNodePosition([
        obs({ anchorNodeNum: 1, anchorLat: 35.0, anchorLon: -80.0, snrDb: -10 }),
        obs({ anchorNodeNum: 2, anchorLat: 35.1, anchorLon: -80.0, snrDb: 10 }),
        obs({ anchorNodeNum: 3, anchorLat: 35.05, anchorLon: -80.0, snrDb: 0 }),
      ], NOW)!;

      expect(solved.usedObservations.map((u) => u.observation.anchorNodeNum)).toEqual([2, 3, 1]);
      expect(solved.usedObservations[0].weight).toBeGreaterThan(solved.usedObservations[2].weight);
    });
  });

  describe('persistence', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      mockDb.traceroutes.getAllTraceroutes.mockResolvedValue([]);
      mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([]);
      mockDb.upsertEstimatedPositionsAsync.mockResolvedValue(undefined);
      mockDb.deleteEstimatedPositionsByNodeNumsAsync.mockResolvedValue(0);
      mockDb.replaceEstimatedPositionAnchorsAsync.mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('persists the anchors behind each estimate, with the derivation on the estimate row', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([{ id: 'src-a', type: 'meshtastic_tcp' }]);
      mockDb.nodes.getAllNodes.mockResolvedValue([
        { nodeNum: 100, latitude: 10, longitude: 20 },
        { nodeNum: 200, latitude: 12, longitude: 20 },
      ]);
      mockDb.traceroutes.getAllTraceroutes.mockResolvedValue([{
        fromNodeNum: 100, toNodeNum: 200, route: JSON.stringify([5]),
        routeBack: null, snrTowards: JSON.stringify([20, 20]), snrBack: null, timestamp: NOW,
      }]);

      await positionEstimationService.recomputeAll({ lookbackMs: 7 * 24 * 60 * 60 * 1000 });

      const estimate = mockDb.upsertEstimatedPositionsAsync.mock.calls[0][0][0];
      expect(estimate.nodeNum).toBe(5);
      expect(estimate.nEff).toBeGreaterThan(0);
      expect(estimate.radiusMethod).toBeTruthy();

      const [nodeNums, anchorRows] = mockDb.replaceEstimatedPositionAnchorsAsync.mock.calls[0];
      expect(nodeNums).toEqual([5]);
      expect(anchorRows).toHaveLength(2);
      expect(anchorRows.map((a: any) => a.anchorNodeNum).sort()).toEqual([100, 200]);
      // nodeId is derived for display; the raw number stays authoritative.
      expect(anchorRows.map((a: any) => a.anchorNodeId).sort()).toEqual(['!00000064', '!000000c8']);
      expect(anchorRows.every((a: any) => a.kind === 'traceroute')).toBe(true);
      expect(anchorRows.every((a: any) => a.snrDb === 5)).toBe(true); // raw 20 / 4
      expect(anchorRows.every((a: any) => a.createdAt === NOW)).toBe(true);
    });

    it('caps stored anchors per node while leaving the true total on the estimate', async () => {
      const anchorCount = MAX_STORED_ANCHORS_PER_NODE + 7;
      mockDb.sources.getAllSources.mockResolvedValue([{ id: 'src-a', type: 'meshtastic_tcp' }]);
      mockDb.nodes.getAllNodes.mockResolvedValue(
        Array.from({ length: anchorCount }, (_, i) => ({
          nodeNum: 1000 + i,
          latitude: 35 + i * 0.001,
          longitude: -80,
        })),
      );
      // Every positioned node reports unpositioned node 7 as a neighbour, with
      // ascending SNR so the strongest anchors are identifiable.
      mockDb.neighbors.getAllNeighborInfo.mockResolvedValue(
        Array.from({ length: anchorCount }, (_, i) => ({
          nodeNum: 1000 + i, neighborNodeNum: 7, snr: i, timestamp: NOW,
        })),
      );

      await positionEstimationService.recomputeAll({ lookbackMs: 7 * 24 * 60 * 60 * 1000 });

      const estimate = mockDb.upsertEstimatedPositionsAsync.mock.calls[0][0][0];
      const [, anchorRows] = mockDb.replaceEstimatedPositionAnchorsAsync.mock.calls[0];

      expect(anchorRows).toHaveLength(MAX_STORED_ANCHORS_PER_NODE);
      // The count on the estimate stays the honest total, so a consumer can say
      // "showing 20 of 27" rather than implying the list is complete.
      expect(estimate.observationCount).toBe(anchorCount);
      // The kept anchors are the strongest, not an arbitrary prefix: SNR ascends
      // with the index, so the weakest survivor is the cap-th from the top.
      const keptSnrs = anchorRows.map((a: any) => a.snrDb).sort((x: number, y: number) => x - y);
      expect(keptSnrs[0]).toBe(anchorCount - MAX_STORED_ANCHORS_PER_NODE);
    });

    it('clears anchors for a node whose estimate is rejected as too uncertain', async () => {
      mockDb.sources.getAllSources.mockResolvedValue([{ id: 'src-a', type: 'meshtastic_tcp' }]);
      mockDb.nodes.getAllNodes.mockResolvedValue([{ nodeNum: 100, latitude: 10, longitude: 20 }]);
      mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([
        { nodeNum: 100, neighborNodeNum: 9, snr: 5, timestamp: NOW },
      ]);

      // A lone anchor always resolves to the 5 km default, so a 1 km ceiling
      // rejects it.
      const result = await positionEstimationService.recomputeAll({
        lookbackMs: 7 * 24 * 60 * 60 * 1000,
        maxUncertaintyKm: 1,
      });

      expect(result.rejectedNodeCount).toBe(1);
      // Nothing is written for node 9...
      const [nodeNums, anchorRows] = mockDb.replaceEstimatedPositionAnchorsAsync.mock.calls[0];
      expect(nodeNums).toEqual([]);
      expect(anchorRows).toEqual([]);
      // ...and the delete (which cascades anchors in the repository) covers it.
      expect(mockDb.deleteEstimatedPositionsByNodeNumsAsync).toHaveBeenCalledWith(
        expect.arrayContaining([9]),
      );
    });
  });
});
