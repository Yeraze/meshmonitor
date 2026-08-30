import { describe, it, expect } from 'vitest';
import {
  evaluateB1,
  evaluateB2,
  evaluateB3,
  evaluateB4,
  evaluateB5,
  evaluateB6,
  evaluateB7,
  evaluateAllTierB,
  tierBSkips,
  findRouterClusters,
  type TierBRuleContext,
  type HopHorizonStats,
} from './rulesTierB.js';
import { MESH_ISSUE_TYPES } from './types.js';
import {
  ROUTER_CLUSTER_CRITICAL_SIZE,
  REDUNDANT_MIN_NEIGHBORS,
  ASYMMETRY_DELTA_DB,
  ASYMMETRY_MIN_SAMPLES_PER_DIRECTION,
  IDLE_ROUTER_MIN_AREA_PATHS,
  LOAD_BEARING_MIN_TRACEROUTES,
  LOAD_BEARING_MIN_AREA_SHARE,
  HOP_HORIZON_MIN_PACKETS,
  COVERAGE_SHADOW_MIN_RANGE_SAMPLES,
  COVERAGE_SHADOW_MAX_RANGE_M,
  MOBILE_MIN_PRECISION_BITS,
  EVIDENCE_MEMBER_LIST_CAP,
  DEFAULT_MESH_ISSUE_THRESHOLDS,
} from './thresholds.js';
import { DeviceRole } from '../../../constants/index.js';
import { calculateDistance } from '../../../utils/distance.js';
import type { PooledNode } from './nodeSnapshot.js';
import type { TracerouteSample } from './tracerouteCorpus.js';
import { edgeKey, type RfEdge, type RfGraph, type RfEvidenceClass, type DirectionalSnr } from './rfGraph.js';
import { tracerouteParticipationKind } from '../../../utils/tracerouteSegments.js';

const NOW_MS = 2_000_000_000_000;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<PooledNode> = {}): PooledNode {
  const nodeNum = overrides.nodeNum ?? 1;
  return {
    nodeNum,
    nodeId: `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`,
    longName: 'Test Node',
    shortName: 'TN',
    hwModel: 1,
    role: null,
    isUnmessagable: false,
    firmwareVersion: null,
    batteryLevel: null,
    voltage: null,
    channelUtilization: null,
    airUtilTx: null,
    latitude: null,
    longitude: null,
    positionPrecisionBits: null,
    mobile: false,
    lastHeardMs: null,
    sourceIds: ['src-a'],
    isExcessivePackets: false,
    packetRatePerHour: null,
    keyIsLowEntropy: false,
    duplicateKeyDetected: false,
    keyMismatchDetected: false,
    keySecurityIssueDetails: null,
    isTimeOffsetIssue: false,
    timeOffsetSeconds: null,
    ...overrides,
  };
}

function nodeMap(nodes: PooledNode[]): Map<number, PooledNode> {
  return new Map(nodes.map((n) => [n.nodeNum, n]));
}

function snr(count: number, meanDb: number | null): DirectionalSnr {
  return { count, meanDb, minDb: meanDb, maxDb: meanDb };
}

function makeEdge(overrides: Partial<RfEdge> = {}): RfEdge {
  const a = overrides.a ?? 1;
  const b = overrides.b ?? 2;
  return {
    a,
    b,
    key: edgeKey(a, b),
    evidenceClasses: ['neighborInfo'] as RfEvidenceClass[],
    direct: true,
    neighborInfoCount: 1,
    tracerouteSampleCount: 0,
    tracerouteDistinctPairCount: 0,
    gatewayDirectCount: 0,
    coReceptionGateways: [],
    observationCount: 1,
    snrToA: snr(0, null),
    snrToB: snr(0, null),
    sourceIds: ['src-a'],
    firstSeenMs: null,
    lastSeenMs: null,
    ...overrides,
  };
}

/** Direct-evidence edge shorthand for adjacency-only fixtures (B1/B2/B4/B7). */
function directEdge(a: number, b: number, overrides: Partial<RfEdge> = {}): RfEdge {
  return makeEdge({ a, b, direct: true, ...overrides });
}

/** Builds a minimal RfGraph directly from a list of edges — WP3's own test
 *  suite already covers `buildRfGraph`'s evidence-stitching correctness;
 *  Tier B's tests exercise rule logic against a graph shape, not the
 *  builder. */
function makeGraph(edges: RfEdge[]): RfGraph {
  const edgeMap = new Map<string, RfEdge>();
  const directAdjacency = new Map<number, Set<number>>();
  const adjacency = new Map<number, Set<number>>();

  const addAdj = (map: Map<number, Set<number>>, a: number, b: number) => {
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(b)) map.set(b, new Set());
    map.get(a)!.add(b);
    map.get(b)!.add(a);
  };

  let directCount = 0;
  const nodeSet = new Set<number>();
  for (const e of edges) {
    edgeMap.set(e.key, e);
    addAdj(adjacency, e.a, e.b);
    if (e.direct) {
      addAdj(directAdjacency, e.a, e.b);
      directCount++;
    }
    nodeSet.add(e.a);
    nodeSet.add(e.b);
  }

  return {
    edges: edgeMap,
    directAdjacency,
    adjacency,
    stats: {
      availability: { neighborInfo: true, traceroute: true, mqttGateway: true, packetLog: true, mqttSourceConfigured: true },
      neighborInfoRowCount: 0,
      neighborInfoEdgeCount: 0,
      tracerouteHopLinkCount: 0,
      tracerouteEdgeCount: 0,
      tracerouteSentinelHopsDropped: 0,
      gatewayCount: 0,
      gatewayDirectEdgeCount: 0,
      gatewayCoReceptionEdgeCount: 0,
      gatewayCellsSkipped: 0,
      totalEdgeCount: edges.length,
      directEdgeCount: directCount,
      nodeCount: nodeSet.size,
      snrDirectionsWithMinSamples: 0,
    },
  };
}

let nextSampleId = 1;
function sample(overrides: Partial<TracerouteSample> = {}): TracerouteSample {
  const fromNodeNum = overrides.fromNodeNum ?? 900;
  const toNodeNum = overrides.toNodeNum ?? 901;
  return {
    id: nextSampleId++,
    fromNodeNum,
    toNodeNum,
    sourceId: 'src-a',
    route: '[]',
    routeBack: null,
    snrTowards: '[]',
    snrBack: null,
    timestamp: NOW_MS,
    createdAt: NOW_MS,
    packetId: nextSampleId,
    routeHops: [],
    routeBackHops: [],
    snrTowardsValues: [],
    snrBackValues: [],
    pairKey: fromNodeNum <= toNodeNum ? `${fromNodeNum}-${toNodeNum}` : `${toNodeNum}-${fromNodeNum}`,
    bucket: 0,
    ...overrides,
  } as TracerouteSample;
}

function hopStats(overrides: Partial<HopHorizonStats> = {}): HopHorizonStats {
  return { totalPackets: 0, exhaustedPackets: 0, sourceIds: ['src-a'], ...overrides };
}

function makeCtx(overrides: Partial<TierBRuleContext> = {}): TierBRuleContext {
  return {
    nodes: new Map(),
    graph: makeGraph([]),
    samples: [],
    hopHorizon: new Map(),
    mqttSourceIds: new Set(),
    nowMs: NOW_MS,
    thresholds: DEFAULT_MESH_ISSUE_THRESHOLDS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// B1 — Router cluster
// ---------------------------------------------------------------------------

describe('evaluateB1 — router cluster', () => {
  it('fires warning for a 2-router cluster with high confidence (all-neighborInfo internal edges)', () => {
    const n1 = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER, longName: 'R1' });
    const n2 = makeNode({ nodeNum: 2, role: DeviceRole.ROUTER, longName: 'R2' });
    const graph = makeGraph([directEdge(1, 2)]);
    const ctx = makeCtx({ nodes: nodeMap([n1, n2]), graph });

    const findings = evaluateB1(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].issueType).toBe(MESH_ISSUE_TYPES.B1_ROUTER_CLUSTER);
    expect(findings[0].nodeNum).toBeNull();
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].confidence).toBe('high');
    expect(findings[0].evidence.size).toBe(2);
    expect(findings[0].evidence.inferredOnly).toBe(false);
  });

  it('includes each member position in evidence so the report can map the cluster (#4974)', () => {
    const n1 = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER, longName: 'R1', latitude: 26.1, longitude: -80.2 });
    const n2 = makeNode({ nodeNum: 2, role: DeviceRole.ROUTER, longName: 'R2' }); // unpositioned
    const graph = makeGraph([directEdge(1, 2)]);
    const ctx = makeCtx({ nodes: nodeMap([n1, n2]), graph });

    const findings = evaluateB1(ctx);

    expect(findings).toHaveLength(1);
    const members = findings[0].evidence.members as Array<{
      nodeNum: number;
      latitude: number | null;
      longitude: number | null;
    }>;
    const byNum = new Map(members.map((m) => [m.nodeNum, m]));
    expect(byNum.get(1)!.latitude).toBe(26.1);
    expect(byNum.get(1)!.longitude).toBe(-80.2);
    expect(byNum.get(2)!.latitude).toBeNull();
    expect(byNum.get(2)!.longitude).toBeNull();
  });

  it('fires critical for a 4-router clique (>= ROUTER_CLUSTER_CRITICAL_SIZE, all mutually audible)', () => {
    expect(ROUTER_CLUSTER_CRITICAL_SIZE).toBe(4);
    const nodes = [1, 2, 3, 4].map((n) => makeNode({ nodeNum: n, role: DeviceRole.ROUTER }));
    // K4: every pair adjacent.
    const graph = makeGraph([
      directEdge(1, 2), directEdge(1, 3), directEdge(1, 4),
      directEdge(2, 3), directEdge(2, 4), directEdge(3, 4),
    ]);
    const ctx = makeCtx({ nodes: nodeMap(nodes), graph });

    const findings = evaluateB1(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.size).toBe(4);
    expect(findings[0].severity).toBe('critical');
  });

  it('does NOT merge a chain of routers into one cluster — clusters are mutually-audible cliques (#4976)', () => {
    // 1-2-3-4-5-6 path: each link is a genuine RF observation, but the
    // endpoints never hear each other. Component semantics reported one
    // 6-router "cluster" spanning the whole chain; clique semantics must
    // report only mutually-audible pairs, and never a group of 3+.
    const nodes = [1, 2, 3, 4, 5, 6].map((n) => makeNode({ nodeNum: n, role: DeviceRole.ROUTER }));
    const graph = makeGraph([
      directEdge(1, 2), directEdge(2, 3), directEdge(3, 4), directEdge(4, 5), directEdge(5, 6),
    ]);
    const ctx = makeCtx({ nodes: nodeMap(nodes), graph });

    const findings = evaluateB1(ctx);

    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.evidence.size).toBe(2);
      const members = (f.evidence.members as Array<{ nodeNum: number }>).map((m) => m.nodeNum);
      // Every reported pair must actually be adjacent.
      expect(Math.abs(members[0] - members[1])).toBe(1);
    }
    expect(findings.every((f) => f.severity !== 'critical')).toBe(true);
  });

  it('ignores edges between positioned nodes farther apart than routerClusterMaxLinkKm (#4976)', () => {
    // A and B sit together; C is ~110 km north but has a recorded "direct"
    // traceroute edge to both (MQTT-bridged hop that never happened over
    // RF). The distance guard must keep C out of the cluster.
    const A = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER, latitude: 26.0, longitude: -80.2 });
    const B = makeNode({ nodeNum: 2, role: DeviceRole.ROUTER, latitude: 26.01, longitude: -80.21 });
    const C = makeNode({ nodeNum: 3, role: DeviceRole.ROUTER, latitude: 27.0, longitude: -80.2 });
    const graph = makeGraph([directEdge(1, 2), directEdge(1, 3), directEdge(2, 3)]);
    const ctx = makeCtx({ nodes: nodeMap([A, B, C]), graph });

    const findings = evaluateB1(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.size).toBe(2);
    const members = (findings[0].evidence.members as Array<{ nodeNum: number }>).map((m) => m.nodeNum);
    expect(members).toEqual([1, 2]);
  });

  it('keeps edges with an unpositioned endpoint regardless of the distance guard (fail-open, #4976)', () => {
    const A = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER, latitude: 26.0, longitude: -80.2 });
    const B = makeNode({ nodeNum: 2, role: DeviceRole.ROUTER }); // unpositioned
    const ctx = makeCtx({ nodes: nodeMap([A, B]), graph: makeGraph([directEdge(1, 2)]) });

    const findings = evaluateB1(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.size).toBe(2);
  });

  it('co-reception edges never inflate a direct clique nor form a warning/critical one (#4976)', () => {
    // A-B genuinely hear each other (direct). C, D, E are only glued to
    // everything by co-reception (one MQTT gateway heard them all) — a full
    // inferred clique among {A..E}. Direct pass must report exactly {A,B};
    // the leftovers {C,D,E} form an inferred-only info group.
    const nodes = [1, 2, 3, 4, 5].map((n) => makeNode({ nodeNum: n, role: DeviceRole.ROUTER }));
    const inferred = (a: number, b: number) =>
      makeEdge({ a, b, direct: false, evidenceClasses: ['gatewayCoReception'] });
    const edges = [directEdge(1, 2)];
    for (let a = 1; a <= 5; a++) for (let b = a + 1; b <= 5; b++) {
      if (!(a === 1 && b === 2)) edges.push(inferred(a, b));
    }
    const ctx = makeCtx({ nodes: nodeMap(nodes), graph: makeGraph(edges) });

    const findings = evaluateB1(ctx);

    expect(findings).toHaveLength(2);
    const direct = findings.find((f) => f.evidence.inferredOnly === false)!;
    const inferredGroup = findings.find((f) => f.evidence.inferredOnly === true)!;
    expect((direct.evidence.members as Array<{ nodeNum: number }>).map((m) => m.nodeNum)).toEqual([1, 2]);
    expect(direct.severity).toBe('warning');
    expect((inferredGroup.evidence.members as Array<{ nodeNum: number }>).map((m) => m.nodeNum)).toEqual([3, 4, 5]);
    expect(inferredGroup.severity).toBe('info');
    expect(inferredGroup.confidence).toBe('low');
  });

  it('downgrades an inferred-only-glued cluster to info/low (D2) and falls back sourceIds to the member union', () => {
    const n1 = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER, sourceIds: ['src-x'] });
    const n2 = makeNode({ nodeNum: 2, role: DeviceRole.ROUTER, sourceIds: ['src-y'] });
    // gatewayCoReception is INFERRED (direct: false) and carries no sourceIds
    // in the real graph builder — exercises the sourceIds fallback too.
    const graph = makeGraph([
      makeEdge({ a: 1, b: 2, direct: false, evidenceClasses: ['gatewayCoReception'], sourceIds: [] }),
    ]);
    const ctx = makeCtx({ nodes: nodeMap([n1, n2]), graph });

    const findings = evaluateB1(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.inferredOnly).toBe(true);
    expect(findings[0].severity).toBe('info');
    expect(findings[0].confidence).toBe('low');
    expect(findings[0].sourceIds).toEqual(['src-x', 'src-y']);
  });

  it('never counts ROUTER_LATE as a cluster member', () => {
    const n1 = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER });
    const n2 = makeNode({ nodeNum: 2, role: DeviceRole.ROUTER });
    const n3 = makeNode({ nodeNum: 3, role: DeviceRole.ROUTER_LATE });
    // 1-3 edge exists too — if ROUTER_LATE counted, this would be a 3-node cluster.
    const graph = makeGraph([directEdge(1, 2), directEdge(1, 3)]);
    const ctx = makeCtx({ nodes: nodeMap([n1, n2, n3]), graph });

    const findings = evaluateB1(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.size).toBe(2);
    const members = findings[0].evidence.members as Array<{ nodeNum: number }>;
    expect(members.map((m) => m.nodeNum).sort()).toEqual([1, 2]);
  });

  it('picks the highest direct-adjacency-degree member as best-sited', () => {
    const A = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER, longName: 'A' });
    const B = makeNode({ nodeNum: 2, role: DeviceRole.ROUTER, longName: 'B' });
    const C = makeNode({ nodeNum: 3, role: DeviceRole.ROUTER, longName: 'C' });
    // A is the hub (degree 2); B and C each have degree 1.
    const graph = makeGraph([directEdge(1, 2), directEdge(1, 3)]);
    const ctx = makeCtx({ nodes: nodeMap([A, B, C]), graph });

    const findings = evaluateB1(ctx);

    expect(findings[0].evidence.bestSitedNodeNum).toBe(1);
    expect(findings[0].evidence.bestSitedName).toBe('A');
    expect(findings[0].recommendation).toContain('Keep A as the router');
  });

  it('clusterSubjectKey is identical across two runs with the same membership regardless of node-map insertion order, and differs when membership changes', () => {
    const n1 = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER });
    const n2 = makeNode({ nodeNum: 2, role: DeviceRole.ROUTER });
    const n3 = makeNode({ nodeNum: 3, role: DeviceRole.ROUTER });
    // Triangle so all three land in one clique under #4976 semantics.
    const graph = makeGraph([directEdge(1, 2), directEdge(2, 3), directEdge(1, 3)]);

    const ctxForward = makeCtx({ nodes: nodeMap([n1, n2, n3]), graph });
    const ctxReversed = makeCtx({ nodes: nodeMap([n3, n2, n1]), graph });

    const keyForward = evaluateB1(ctxForward)[0].subjectKey;
    const keyReversed = evaluateB1(ctxReversed)[0].subjectKey;
    expect(keyForward).toBe(keyReversed);

    // Different membership (only 2 of the 3 routers known) -> different key.
    const ctxSmaller = makeCtx({ nodes: nodeMap([n1, n2]), graph: makeGraph([directEdge(1, 2)]) });
    const keySmaller = evaluateB1(ctxSmaller)[0].subjectKey;
    expect(keySmaller).not.toBe(keyForward);
  });

  it('recommendation never contains "promote" or suggests bare ROUTER', () => {
    const n1 = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER });
    const n2 = makeNode({ nodeNum: 2, role: DeviceRole.ROUTER });
    const ctx = makeCtx({ nodes: nodeMap([n1, n2]), graph: makeGraph([directEdge(1, 2)]) });
    const findings = evaluateB1(ctx);
    expect(findings[0].recommendation.toLowerCase()).not.toContain('promote');
    expect(findings[0].recommendation).not.toMatch(/\bROUTER\b/);
  });

  it('membersTotal / edgesTotal equal the pre-cap length, not the (untruncated) items length (#4964 Phase 3 WP3 §4.2)', () => {
    const n1 = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER });
    const n2 = makeNode({ nodeNum: 2, role: DeviceRole.ROUTER });
    const ctx = makeCtx({ nodes: nodeMap([n1, n2]), graph: makeGraph([directEdge(1, 2)]) });
    const findings = evaluateB1(ctx);
    expect(findings[0].evidence.membersTruncated).toBe(false);
    expect(findings[0].evidence.membersTotal).toBe(2);
    expect(findings[0].evidence.edgesTruncated).toBe(false);
    expect(findings[0].evidence.edgesTotal).toBe(1);
  });

  it('caps members/edges at EVIDENCE_MEMBER_LIST_CAP and reports the true pre-cap total (#4964 Phase 3 WP3 §4.2)', () => {
    // A 30-router CLIQUE (every pair adjacent, #4976): 30 members, 435
    // internal edges — both over the cap.
    const nums = Array.from({ length: 30 }, (_, i) => i + 1);
    const nodes = nums.map((n) => makeNode({ nodeNum: n, role: DeviceRole.ROUTER }));
    const edges = nums.flatMap((a) => nums.filter((b) => b > a).map((b) => directEdge(a, b)));
    const ctx = makeCtx({ nodes: nodeMap(nodes), graph: makeGraph(edges) });

    const findings = evaluateB1(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.size).toBe(30);

    expect(findings[0].evidence.membersTruncated).toBe(true);
    expect(findings[0].evidence.membersTotal).toBe(30);
    expect((findings[0].evidence.members as unknown[]).length).toBe(EVIDENCE_MEMBER_LIST_CAP);

    expect(findings[0].evidence.edgesTruncated).toBe(true);
    expect(findings[0].evidence.edgesTotal).toBe(435);
    expect((findings[0].evidence.edges as unknown[]).length).toBe(EVIDENCE_MEMBER_LIST_CAP);
  });
});

describe('findRouterClusters — shared by B1 and B6', () => {
  it('returns clusters independent of call order', () => {
    const n1 = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER });
    const n2 = makeNode({ nodeNum: 2, role: DeviceRole.ROUTER });
    const ctx = makeCtx({ nodes: nodeMap([n1, n2]), graph: makeGraph([directEdge(1, 2)]) });
    const clusters = findRouterClusters(ctx);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toEqual([1, 2]);
    expect(clusters[0].inferredOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B2 — Redundant router
// ---------------------------------------------------------------------------

describe('evaluateB2 — redundant router', () => {
  function buildOverlapFixture(sharedCount: number, aOnlyCount: number, bOnlyCount: number) {
    const shared = Array.from({ length: sharedCount }, (_, i) => 1000 + i);
    const aOnly = Array.from({ length: aOnlyCount }, (_, i) => 2000 + i);
    const bOnly = Array.from({ length: bOnlyCount }, (_, i) => 3000 + i);

    const edges = [
      ...shared.map((s) => directEdge(1, s)),
      ...aOnly.map((s) => directEdge(1, s)),
      ...shared.map((s) => directEdge(2, s)),
      ...bOnly.map((s) => directEdge(2, s)),
    ];
    const graph = makeGraph(edges);

    const allNums = new Set<number>([1, 2, ...shared, ...aOnly, ...bOnly]);
    const nodes = Array.from(allNums).map((n) =>
      makeNode({ nodeNum: n, role: n === 1 || n === 2 ? DeviceRole.ROUTER : null }),
    );
    return { graph, nodes };
  }

  it('does NOT report a router as covered by one beyond routerClusterMaxLinkKm (#4976)', () => {
    // Identical (MQTT-fabricated) neighbor sets, but the routers sit ~110 km
    // apart — they cannot cover the same area, so B2 must stay silent.
    const { graph, nodes } = buildOverlapFixture(9, 1, 2);
    const positioned = nodes.map((n) => {
      if (n.nodeNum === 1) return { ...n, latitude: 26.0, longitude: -80.2 };
      if (n.nodeNum === 2) return { ...n, latitude: 27.0, longitude: -80.2 };
      return n;
    });
    const ctx = makeCtx({ nodes: nodeMap(positioned), graph });

    expect(evaluateB2(ctx)).toHaveLength(0);
  });

  it('fires on the smaller router at 90% overlap', () => {
    // A: 9 shared + 1 aOnly = 10. B: 9 shared + 2 bOnly = 11 (strictly larger
    // than A so B itself does not also qualify as a candidate).
    const { graph, nodes } = buildOverlapFixture(9, 1, 2);
    const ctx = makeCtx({ nodes: nodeMap(nodes), graph });

    const findings = evaluateB2(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].subjectKey).toBe('node:1');
    expect(findings[0].nodeNum).toBe(1);
    expect(findings[0].evidence.coveredByNodeNum).toBe(2);
    expect(findings[0].evidence.overlapRatio).toBeCloseTo(0.9);
    expect(findings[0].severity).toBe('warning');
  });

  it('does not fire at 89% overlap', () => {
    // A: 8 shared + 1 aOnly = 9. B: 8 shared + 2 bOnly = 10.
    // overlap = 8/9 = 0.888... < 0.9
    const { graph, nodes } = buildOverlapFixture(8, 1, 2);
    const ctx = makeCtx({ nodes: nodeMap(nodes), graph });

    expect(evaluateB2(ctx)).toEqual([]);
  });

  it('does not fire when |N(A)| === 2 (below REDUNDANT_MIN_NEIGHBORS)', () => {
    expect(REDUNDANT_MIN_NEIGHBORS).toBe(3);
    const { graph, nodes } = buildOverlapFixture(2, 0, 5);
    const ctx = makeCtx({ nodes: nodeMap(nodes), graph });

    expect(evaluateB2(ctx)).toEqual([]);
  });

  it('skips the whole rule when directEdgeCount === 0, even if directAdjacency looks populated', () => {
    const { graph, nodes } = buildOverlapFixture(9, 1, 2);
    // Force the coarse gate independent of directAdjacency's actual content,
    // to prove the guard reads graph.stats.directEdgeCount specifically.
    const zeroDirectGraph: RfGraph = { ...graph, stats: { ...graph.stats, directEdgeCount: 0 } };
    const ctx = makeCtx({ nodes: nodeMap(nodes), graph: zeroDirectGraph });

    expect(evaluateB2(ctx)).toEqual([]);
  });

  it('recommendation never contains "promote" or suggests bare ROUTER', () => {
    const { graph, nodes } = buildOverlapFixture(9, 1, 2);
    const ctx = makeCtx({ nodes: nodeMap(nodes), graph });
    const findings = evaluateB2(ctx);
    expect(findings[0].recommendation.toLowerCase()).not.toContain('promote');
    expect(findings[0].recommendation).not.toMatch(/\bROUTER\b/);
  });

  it('sharedNeighborsTotal / otherCoveringRoutersTotal are the pre-cap length (#4964 Phase 3 WP3 §4.2)', () => {
    // 30 shared neighbours (over the cap) + 1 aOnly keeps the overlap ratio
    // at 30/31 ≈ 0.968, comfortably above REDUNDANT_OVERLAP_RATIO (0.9).
    const { graph, nodes } = buildOverlapFixture(30, 1, 2);
    const ctx = makeCtx({ nodes: nodeMap(nodes), graph });
    const findings = evaluateB2(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.sharedNeighborsTruncated).toBe(true);
    expect(findings[0].evidence.sharedNeighborsTotal).toBe(30);
    expect((findings[0].evidence.sharedNeighbors as unknown[]).length).toBe(EVIDENCE_MEMBER_LIST_CAP);

    // Only one candidate (node 2) qualifies here, so "rest" (other covering
    // routers) is empty — total is still present and is the pre-cap length (0).
    expect(findings[0].evidence.otherCoveringRoutersTruncated).toBe(false);
    expect(findings[0].evidence.otherCoveringRoutersTotal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B3 — Asymmetric link
// ---------------------------------------------------------------------------

describe('evaluateB3 — asymmetric link', () => {
  it('fires at 7dB delta with 3+3 samples', () => {
    expect(ASYMMETRY_DELTA_DB).toBe(6);
    const n1 = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER });
    const n2 = makeNode({ nodeNum: 2, role: null });
    const edge = makeEdge({ a: 1, b: 2, snrToA: snr(3, 0), snrToB: snr(3, 7) });
    const ctx = makeCtx({ nodes: nodeMap([n1, n2]), graph: makeGraph([edge]) });

    const findings = evaluateB3(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].subjectKey).toBe('edge:1-2');
    expect(findings[0].evidence.deltaDb).toBeCloseTo(-7);
    // snrToA (arrival at a, i.e. the b->a direction) has the lower mean, so
    // b->a is the weaker direction.
    expect(findings[0].evidence.weakerDirection).toBe('b->a');
  });

  it('does not fire at 5dB delta', () => {
    const n1 = makeNode({ nodeNum: 1 });
    const n2 = makeNode({ nodeNum: 2 });
    const edge = makeEdge({ a: 1, b: 2, snrToA: snr(3, 0), snrToB: snr(3, 5) });
    const ctx = makeCtx({ nodes: nodeMap([n1, n2]), graph: makeGraph([edge]) });

    expect(evaluateB3(ctx)).toEqual([]);
  });

  it('does not fire with only 2 samples in one direction', () => {
    expect(ASYMMETRY_MIN_SAMPLES_PER_DIRECTION).toBe(3);
    const n1 = makeNode({ nodeNum: 1 });
    const n2 = makeNode({ nodeNum: 2 });
    const edge = makeEdge({ a: 1, b: 2, snrToA: snr(2, 0), snrToB: snr(5, 10) });
    const ctx = makeCtx({ nodes: nodeMap([n1, n2]), graph: makeGraph([edge]) });

    expect(evaluateB3(ctx)).toEqual([]);
  });

  it('attaches nodeNum to the infra endpoint when exactly one end is infra', () => {
    const n1 = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER });
    const n2 = makeNode({ nodeNum: 2, role: null });
    const edge = makeEdge({ a: 1, b: 2, snrToA: snr(3, 0), snrToB: snr(3, 10) });
    const ctx = makeCtx({ nodes: nodeMap([n1, n2]), graph: makeGraph([edge]) });

    const findings = evaluateB3(ctx);
    expect(findings[0].nodeNum).toBe(1);
    expect(findings[0].severity).toBe('warning');
  });

  it('sets nodeNum to null when both ends are infra (D6)', () => {
    const n1 = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER });
    const n2 = makeNode({ nodeNum: 2, role: DeviceRole.REPEATER });
    const edge = makeEdge({ a: 1, b: 2, snrToA: snr(3, 0), snrToB: snr(3, 10) });
    const ctx = makeCtx({ nodes: nodeMap([n1, n2]), graph: makeGraph([edge]) });

    const findings = evaluateB3(ctx);
    expect(findings[0].nodeNum).toBeNull();
    expect(findings[0].severity).toBe('warning');
  });

  it('severity is info when neither end is infra', () => {
    const n1 = makeNode({ nodeNum: 1, role: DeviceRole.CLIENT });
    const n2 = makeNode({ nodeNum: 2, role: DeviceRole.CLIENT });
    const edge = makeEdge({ a: 1, b: 2, snrToA: snr(3, 0), snrToB: snr(3, 10) });
    const ctx = makeCtx({ nodes: nodeMap([n1, n2]), graph: makeGraph([edge]) });

    expect(evaluateB3(ctx)[0].severity).toBe('info');
  });

  it('a gatewayCoReception-only edge (no SNR) never fires', () => {
    const n1 = makeNode({ nodeNum: 1 });
    const n2 = makeNode({ nodeNum: 2 });
    const edge = makeEdge({ a: 1, b: 2, direct: false, evidenceClasses: ['gatewayCoReception'], sourceIds: [] });
    const ctx = makeCtx({ nodes: nodeMap([n1, n2]), graph: makeGraph([edge]) });

    expect(evaluateB3(ctx)).toEqual([]);
  });

  it('honours ctx.thresholds.snrAsymmetryDb rather than the code constant (#4964 Phase 3 WP1)', () => {
    const n1 = makeNode({ nodeNum: 1 });
    const n2 = makeNode({ nodeNum: 2 });
    const edge = makeEdge({ a: 1, b: 2, snrToA: snr(3, 0), snrToB: snr(3, 5) });
    const lowDelta = { ...DEFAULT_MESH_ISSUE_THRESHOLDS, snrAsymmetryDb: 3 };
    const highDelta = { ...DEFAULT_MESH_ISSUE_THRESHOLDS, snrAsymmetryDb: 20 };

    const firesAt3 = makeCtx({ nodes: nodeMap([n1, n2]), graph: makeGraph([edge]), thresholds: lowDelta });
    const suppressedAt20 = makeCtx({ nodes: nodeMap([n1, n2]), graph: makeGraph([edge]), thresholds: highDelta });

    expect(evaluateB3(firesAt3)).toHaveLength(1);
    expect(evaluateB3(suppressedAt20)).toEqual([]);
  });

  it('emits the effective thresholdUsed in evidence', () => {
    const n1 = makeNode({ nodeNum: 1 });
    const n2 = makeNode({ nodeNum: 2 });
    const edge = makeEdge({ a: 1, b: 2, snrToA: snr(3, 0), snrToB: snr(3, 7) });
    const thresholds = { ...DEFAULT_MESH_ISSUE_THRESHOLDS, snrAsymmetryDb: 3 };
    const ctx = makeCtx({ nodes: nodeMap([n1, n2]), graph: makeGraph([edge]), thresholds });

    expect(evaluateB3(ctx)[0].evidence.thresholdUsed).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// B4 — Idle router
// ---------------------------------------------------------------------------

describe('evaluateB4 — idle router', () => {
  const R = () => makeNode({ nodeNum: 501, role: DeviceRole.ROUTER, latitude: 10.0, longitude: 20.0 });
  const P = () => makeNode({ nodeNum: 502, role: DeviceRole.ROUTER, latitude: 10.001, longitude: 20.001 });

  function fixture(areaPathCount: number, peerHopSampleCount: number) {
    const r = R();
    const p = P();
    const z1 = makeNode({ nodeNum: 505 });
    const z2 = makeNode({ nodeNum: 506 });
    const graph = makeGraph([directEdge(501, 505), directEdge(502, 506)]);

    const samples: TracerouteSample[] = [];
    for (let i = 0; i < areaPathCount; i++) {
      const isPeerHop = i < peerHopSampleCount;
      samples.push(
        sample({
          fromNodeNum: 900,
          toNodeNum: r.nodeNum, // R as endpoint keeps R's bin in every sample
          routeHops: isPeerHop ? [p.nodeNum] : [],
        }),
      );
    }

    return { nodes: nodeMap([r, p, z1, z2]), graph, samples };
  }

  it('fires with info severity when hopShare < 1% and a peer carries > 10%', () => {
    expect(IDLE_ROUTER_MIN_AREA_PATHS).toBe(20);
    const { nodes, graph, samples } = fixture(20, 3); // peer share 3/20 = 15%
    const ctx = makeCtx({ nodes, graph, samples });

    const findings = evaluateB4(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].nodeNum).toBe(501);
    expect(findings[0].severity).toBe('info');
    expect(findings[0].evidence.hopShare).toBe(0);
    expect(findings[0].evidence.peerBestShare).toBeCloseTo(0.15);
    expect(findings[0].evidence.peerBestNodeNum).toBe(502);
  });

  it('does not fire with only 19 area paths', () => {
    const { nodes, graph, samples } = fixture(19, 3);
    const ctx = makeCtx({ nodes, graph, samples });
    expect(evaluateB4(ctx)).toEqual([]);
  });

  it('does not fire when peer share is exactly 10% (strict >)', () => {
    const { nodes, graph, samples } = fixture(20, 2); // 2/20 = 10%
    const ctx = makeCtx({ nodes, graph, samples });
    expect(evaluateB4(ctx)).toEqual([]);
  });

  it('recommendation never contains "promote" or suggests bare ROUTER', () => {
    const { nodes, graph, samples } = fixture(20, 3);
    const ctx = makeCtx({ nodes, graph, samples });
    const findings = evaluateB4(ctx);
    expect(findings[0].recommendation.toLowerCase()).not.toContain('promote');
    expect(findings[0].recommendation).not.toMatch(/\bROUTER\b/);
  });
});

// ---------------------------------------------------------------------------
// B5 — Load-bearing CLIENT
// ---------------------------------------------------------------------------

describe('evaluateB5 — load-bearing client', () => {
  function fixture(role: number, batteryLevel: number | null, mobile: boolean, hopCount = 10) {
    const s = makeNode({ nodeNum: 601, role, latitude: 30.0, longitude: 40.0, batteryLevel, mobile });
    const x = makeNode({ nodeNum: 900 });
    const y = makeNode({ nodeNum: 901 });

    const samples: TracerouteSample[] = [];
    for (let i = 0; i < hopCount; i++) {
      samples.push(sample({ fromNodeNum: x.nodeNum, toNodeNum: y.nodeNum, routeHops: [s.nodeNum] }));
    }

    return { nodes: nodeMap([s, x, y]), samples };
  }

  it('warning severity + "another CLIENT" wording for a battery (not fixed/powered) node', () => {
    expect(LOAD_BEARING_MIN_TRACEROUTES).toBe(10);
    expect(LOAD_BEARING_MIN_AREA_SHARE).toBe(0.25);
    const { nodes, samples } = fixture(DeviceRole.CLIENT, 50, false);
    const ctx = makeCtx({ nodes, samples });

    const findings = evaluateB5(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].evidence.fixedAndPowered).toBe(false);
    expect(findings[0].recommendation).toContain('another CLIENT');
    expect(findings[0].recommendation).not.toContain('CLIENT_BASE');
  });

  it('info severity + CLIENT_BASE wording for a fixed/powered CLIENT', () => {
    const { nodes, samples } = fixture(DeviceRole.CLIENT, 101, false);
    const ctx = makeCtx({ nodes, samples });

    const findings = evaluateB5(ctx);

    expect(findings[0].severity).toBe('info');
    expect(findings[0].evidence.fixedAndPowered).toBe(true);
    expect(findings[0].recommendation).toContain('CLIENT_BASE');
  });

  it('a node already CLIENT_BASE (fixed/powered) gets "another CLIENT" wording, not a CLIENT_BASE suggestion', () => {
    const { nodes, samples } = fixture(DeviceRole.CLIENT_BASE, 101, false);
    const ctx = makeCtx({ nodes, samples });

    const findings = evaluateB5(ctx);

    expect(findings[0].severity).toBe('info');
    expect(findings[0].recommendation).toContain('another CLIENT');
    expect(findings[0].recommendation).not.toContain('CLIENT_BASE fits');
  });

  it('does not fire an INFRA_ROLES node (routers are excluded from B5)', () => {
    const { nodes, samples } = fixture(DeviceRole.ROUTER, 101, false);
    const ctx = makeCtx({ nodes, samples });
    expect(evaluateB5(ctx)).toEqual([]);
  });

  it('does not fire below LOAD_BEARING_MIN_TRACEROUTES hop count', () => {
    const { nodes, samples } = fixture(DeviceRole.CLIENT, 50, false, 9);
    const ctx = makeCtx({ nodes, samples });
    expect(evaluateB5(ctx)).toEqual([]);
  });

  it('recommendation never contains "promote" or suggests bare ROUTER', () => {
    const { nodes, samples } = fixture(DeviceRole.CLIENT, 50, false);
    const ctx = makeCtx({ nodes, samples });
    const findings = evaluateB5(ctx);
    expect(findings[0].recommendation.toLowerCase()).not.toContain('promote');
    expect(findings[0].recommendation).not.toMatch(/\bROUTER\b/);
  });
});

// ---------------------------------------------------------------------------
// B6 — Hop horizon
// ---------------------------------------------------------------------------

describe('evaluateB6 — hop horizon', () => {
  it('returns [] and tierBSkips reports it when hopHorizon is empty', () => {
    const ctx = makeCtx({ hopHorizon: new Map() });
    expect(evaluateB6(ctx)).toEqual([]);
    expect(tierBSkips(ctx)).toContainEqual({ rule: 'B6', reason: 'no packet log enabled' });
  });

  it('does not fire with only 19 packets', () => {
    expect(HOP_HORIZON_MIN_PACKETS).toBe(20);
    const ctx = makeCtx({ hopHorizon: new Map([[100, hopStats({ totalPackets: 19, exhaustedPackets: 19 })]]) });
    expect(evaluateB6(ctx)).toEqual([]);
  });

  it('does not fire at exactly 50% exhausted (strict >)', () => {
    const ctx = makeCtx({ hopHorizon: new Map([[100, hopStats({ totalPackets: 20, exhaustedPackets: 10 })]]) });
    expect(evaluateB6(ctx)).toEqual([]);
  });

  it('fires info severity above 50% exhausted with >= 20 packets', () => {
    const ctx = makeCtx({ hopHorizon: new Map([[100, hopStats({ totalPackets: 20, exhaustedPackets: 11 })]]) });
    const findings = evaluateB6(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('info');
    expect(findings[0].evidence.hopDeltaIsLowerBound).toBe(true);
    expect(findings[0].evidence.behindRouterCluster).toBe(false);
  });

  it('flips the recommendation text and sets behindRouterCluster when adjacent to a router cluster', () => {
    const r1 = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER });
    const r2 = makeNode({ nodeNum: 2, role: DeviceRole.ROUTER });
    const subject = makeNode({ nodeNum: 100 });
    // subject is adjacent to cluster member 1 (inferred edge is fine — B6
    // checks ctx.graph.adjacency, which includes inferred edges).
    const graph = makeGraph([directEdge(1, 2), makeEdge({ a: 1, b: 100, direct: false, evidenceClasses: ['gatewayCoReception'] })]);
    const ctx = makeCtx({
      nodes: nodeMap([r1, r2, subject]),
      graph,
      hopHorizon: new Map([[100, hopStats({ totalPackets: 20, exhaustedPackets: 15 })]]),
    });

    const findings = evaluateB6(ctx);

    expect(findings[0].evidence.behindRouterCluster).toBe(true);
    expect(findings[0].recommendation).toContain('router cluster');
    expect((findings[0].evidence.clusterMembers as number[]).sort()).toEqual([1]);
    // clusterMembersTotal is the pre-cap length (#4964 Phase 3 WP3 §4.2).
    expect(findings[0].evidence.clusterMembersTruncated).toBe(false);
    expect(findings[0].evidence.clusterMembersTotal).toBe(1);
  });

  it('recommendation never contains "promote" or suggests bare ROUTER', () => {
    const ctx = makeCtx({ hopHorizon: new Map([[100, hopStats({ totalPackets: 20, exhaustedPackets: 11 })]]) });
    const findings = evaluateB6(ctx);
    expect(findings[0].recommendation.toLowerCase()).not.toContain('promote');
    expect(findings[0].recommendation).not.toMatch(/\bROUTER\b/);
  });
});

// ---------------------------------------------------------------------------
// B7 — Coverage shadow
// ---------------------------------------------------------------------------

describe('evaluateB7 — coverage shadow', () => {
  function buildRouterWithNeighbors(neighborOffsetsKm: number[]) {
    const router = makeNode({ nodeNum: 700, role: DeviceRole.ROUTER, latitude: 10.0, longitude: 20.0 });
    // ~1 deg latitude ~= 111km; offset by small deltas for controllable km distances.
    const neighbors = neighborOffsetsKm.map((km, i) =>
      makeNode({ nodeNum: 800 + i, latitude: 10.0 + km / 111, longitude: 20.0 }),
    );
    const edges = neighbors.map((n) => directEdge(router.nodeNum, n.nodeNum));
    return { router, neighbors, edges };
  }

  it('fires for an MQTT-only node inside the router observed range', () => {
    expect(COVERAGE_SHADOW_MIN_RANGE_SAMPLES).toBe(3);
    const { router, neighbors, edges } = buildRouterWithNeighbors([1, 2, 3]); // max range ~3km
    const candidate = makeNode({
      nodeNum: 900,
      latitude: 10.0 + 1.5 / 111,
      longitude: 20.0,
      sourceIds: ['mqtt-src'],
    });
    const ctx = makeCtx({
      nodes: nodeMap([router, ...neighbors, candidate]),
      graph: makeGraph(edges),
      mqttSourceIds: new Set(['mqtt-src']),
    });

    const findings = evaluateB7(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].nodeNum).toBe(900);
    expect(findings[0].severity).toBe('info');
    expect(findings[0].evidence.nearestRouterNodeNum).toBe(700);
    expect(findings[0].evidence.rangeCappedAtCeiling).toBe(false);
  });

  it('never fires for a node with any direct edge', () => {
    const { router, neighbors, edges } = buildRouterWithNeighbors([1, 2, 3]);
    const candidate = makeNode({ nodeNum: 900, latitude: 10.0 + 1.5 / 111, longitude: 20.0, sourceIds: ['mqtt-src'] });
    const graph = makeGraph([...edges, directEdge(900, 999)]);
    const ctx = makeCtx({
      nodes: nodeMap([router, ...neighbors, candidate, makeNode({ nodeNum: 999 })]),
      graph,
      mqttSourceIds: new Set(['mqtt-src']),
    });

    expect(evaluateB7(ctx)).toEqual([]);
  });

  it('never fires for a node with a non-MQTT sourceId', () => {
    const { router, neighbors, edges } = buildRouterWithNeighbors([1, 2, 3]);
    const candidate = makeNode({
      nodeNum: 900,
      latitude: 10.0 + 1.5 / 111,
      longitude: 20.0,
      sourceIds: ['tcp-src'],
    });
    const ctx = makeCtx({
      nodes: nodeMap([router, ...neighbors, candidate]),
      graph: makeGraph(edges),
      mqttSourceIds: new Set(['mqtt-src']),
    });

    expect(evaluateB7(ctx)).toEqual([]);
  });

  it('skips a candidate with precision below MOBILE_MIN_PRECISION_BITS', () => {
    const { router, neighbors, edges } = buildRouterWithNeighbors([1, 2, 3]);
    const candidate = makeNode({
      nodeNum: 900,
      latitude: 10.0 + 1.5 / 111,
      longitude: 20.0,
      sourceIds: ['mqtt-src'],
      positionPrecisionBits: MOBILE_MIN_PRECISION_BITS - 1,
    });
    const ctx = makeCtx({
      nodes: nodeMap([router, ...neighbors, candidate]),
      graph: makeGraph(edges),
      mqttSourceIds: new Set(['mqtt-src']),
    });

    expect(evaluateB7(ctx)).toEqual([]);
  });

  it('does not fire with only 2 positioned direct neighbours', () => {
    const { router, neighbors, edges } = buildRouterWithNeighbors([1, 2]);
    const candidate = makeNode({ nodeNum: 900, latitude: 10.0 + 1.0 / 111, longitude: 20.0, sourceIds: ['mqtt-src'] });
    const ctx = makeCtx({
      nodes: nodeMap([router, ...neighbors, candidate]),
      graph: makeGraph(edges),
      mqttSourceIds: new Set(['mqtt-src']),
    });

    expect(evaluateB7(ctx)).toEqual([]);
  });

  it('clamps the range ceiling and sets rangeCappedAtCeiling', () => {
    expect(COVERAGE_SHADOW_MAX_RANGE_M).toBe(25_000);
    // A far outlier neighbour (~40km) pushes the raw max range past the 25km ceiling.
    const { router, neighbors, edges } = buildRouterWithNeighbors([1, 2, 40]);
    const candidate = makeNode({
      nodeNum: 900,
      latitude: 10.0 + 20.0 / 111, // 20km — inside the CAPPED 25km range, outside the raw uncapped-irrelevant check
      longitude: 20.0,
      sourceIds: ['mqtt-src'],
    });
    const ctx = makeCtx({
      nodes: nodeMap([router, ...neighbors, candidate]),
      graph: makeGraph(edges),
      mqttSourceIds: new Set(['mqtt-src']),
    });

    const findings = evaluateB7(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.rangeCappedAtCeiling).toBe(true);
    expect(findings[0].evidence.routerObservedRangeM).toBe(COVERAGE_SHADOW_MAX_RANGE_M);
  });

  it('geometry sanity: observed range matches the max direct-neighbour distance via calculateDistance', () => {
    const { router, neighbors, edges } = buildRouterWithNeighbors([1, 2, 5]);
    const candidate = makeNode({ nodeNum: 900, latitude: 10.0 + 4.9 / 111, longitude: 20.0, sourceIds: ['mqtt-src'] });
    const ctx = makeCtx({
      nodes: nodeMap([router, ...neighbors, candidate]),
      graph: makeGraph(edges),
      mqttSourceIds: new Set(['mqtt-src']),
    });

    const findings = evaluateB7(ctx);
    const expectedRangeM = calculateDistance(10.0, 20.0, 10.0 + 5 / 111, 20.0) * 1000;
    expect(findings[0].evidence.routerObservedRangeM).toBeCloseTo(expectedRangeM, 0);
  });

  it('recommendation never contains "promote" or suggests bare ROUTER', () => {
    const { router, neighbors, edges } = buildRouterWithNeighbors([1, 2, 3]);
    const candidate = makeNode({ nodeNum: 900, latitude: 10.0 + 1.5 / 111, longitude: 20.0, sourceIds: ['mqtt-src'] });
    const ctx = makeCtx({
      nodes: nodeMap([router, ...neighbors, candidate]),
      graph: makeGraph(edges),
      mqttSourceIds: new Set(['mqtt-src']),
    });
    const findings = evaluateB7(ctx);
    expect(findings[0].recommendation.toLowerCase()).not.toContain('promote');
    expect(findings[0].recommendation).not.toMatch(/\bROUTER\b/);
  });
});

// ---------------------------------------------------------------------------
// Shared participation index cross-check against tracerouteParticipationKind
// ---------------------------------------------------------------------------

describe('participation index vs. tracerouteParticipationKind semantics', () => {
  it('a node acting purely as an intermediate hop is classified "hop" by both the rule fixture and the reference predicate', () => {
    const hopNode = 555;
    const from = 900;
    const to = 901;
    const row = { fromNodeNum: from, toNodeNum: to, route: JSON.stringify([hopNode]), routeBack: null };
    expect(tracerouteParticipationKind(row, hopNode)).toBe('hop');
    expect(tracerouteParticipationKind(row, from)).toBe('endpoint');
  });
});

// ---------------------------------------------------------------------------
// evaluateAllTierB — isolation, ordering, and tierBSkips coverage
// ---------------------------------------------------------------------------

describe('evaluateAllTierB', () => {
  it('isolates a rule that throws: the others still run and contribute findings', () => {
    const r1 = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER });
    const r2 = makeNode({ nodeNum: 2, role: DeviceRole.ROUTER });
    const ctx = makeCtx({ nodes: nodeMap([r1, r2]), graph: makeGraph([directEdge(1, 2)]) });
    // Corrupt hopHorizon so ONLY B6 throws (`.entries` is not a function on
    // a plain object) — every other rule reads unrelated fields of ctx.
    const badCtx: TierBRuleContext = { ...ctx, hopHorizon: {} as unknown as Map<number, HopHorizonStats> };

    const findings = evaluateAllTierB(badCtx);

    expect(findings.some((f) => f.issueType === MESH_ISSUE_TYPES.B1_ROUTER_CLUSTER)).toBe(true);
    expect(findings.some((f) => f.issueType === MESH_ISSUE_TYPES.B6_HOP_HORIZON)).toBe(false);
  });

  it('shared participation/cluster indices are built once for the whole run (500-sample timing sanity)', () => {
    // Not a precise measurement (per spec §5 WP4 acceptance) — a smoke test
    // that a per-rule O(n) rebuild hasn't crept back in. See the module
    // header's "SHARED INDICES" comment for the actual complexity guarantee.
    const nodes: PooledNode[] = [];
    for (let i = 0; i < 60; i++) {
      nodes.push(
        makeNode({
          nodeNum: 1000 + i,
          role: i % 5 === 0 ? DeviceRole.ROUTER : DeviceRole.CLIENT,
          latitude: 10 + (i % 10) * 0.001,
          longitude: 20 + (i % 10) * 0.001,
        }),
      );
    }
    const edges: RfEdge[] = [];
    for (let i = 0; i < 59; i++) edges.push(directEdge(1000 + i, 1000 + i + 1));
    const samples: TracerouteSample[] = [];
    for (let i = 0; i < 500; i++) {
      const hopIdx = 1000 + (i % 60);
      samples.push(sample({ fromNodeNum: 1000 + ((i + 1) % 60), toNodeNum: 1000 + ((i + 2) % 60), routeHops: [hopIdx] }));
    }
    const ctx = makeCtx({ nodes: nodeMap(nodes), graph: makeGraph(edges), samples });

    const start = Date.now();
    evaluateAllTierB(ctx);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(3000);
  });

  it('B7 is absent from the evaluated set when ctx.thresholds.b7Enabled is false (#4964 Phase 3 WP1)', () => {
    const router = makeNode({ nodeNum: 700, role: DeviceRole.ROUTER, latitude: 10.0, longitude: 20.0 });
    const neighbors = [1, 2, 3].map((km, i) =>
      makeNode({ nodeNum: 800 + i, latitude: 10.0 + km / 111, longitude: 20.0 }),
    );
    const candidate = makeNode({
      nodeNum: 900,
      latitude: 10.0 + 1.5 / 111,
      longitude: 20.0,
      sourceIds: ['mqtt-src'],
    });
    const edges = neighbors.map((n) => directEdge(router.nodeNum, n.nodeNum));
    const nodes = nodeMap([router, ...neighbors, candidate]);
    const graph = makeGraph(edges);
    const mqttSourceIds = new Set(['mqtt-src']);

    const enabledCtx = makeCtx({ nodes, graph, mqttSourceIds });
    expect(evaluateAllTierB(enabledCtx).some((f) => f.issueType === MESH_ISSUE_TYPES.B7_COVERAGE_SHADOW)).toBe(true);

    const disabledCtx = makeCtx({
      nodes,
      graph,
      mqttSourceIds,
      thresholds: { ...DEFAULT_MESH_ISSUE_THRESHOLDS, b7Enabled: false },
    });
    expect(evaluateAllTierB(disabledCtx).some((f) => f.issueType === MESH_ISSUE_TYPES.B7_COVERAGE_SHADOW)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// tierBSkips
// ---------------------------------------------------------------------------

describe('tierBSkips', () => {
  it('reports B2 when there is no direct RF adjacency data', () => {
    const ctx = makeCtx({ graph: makeGraph([]) });
    expect(tierBSkips(ctx)).toContainEqual({ rule: 'B2', reason: 'no direct RF adjacency data' });
  });

  it('reports B6 when hopHorizon is empty', () => {
    const ctx = makeCtx({ hopHorizon: new Map() });
    expect(tierBSkips(ctx)).toContainEqual({ rule: 'B6', reason: 'no packet log enabled' });
  });

  it('reports nothing when both evidence classes are available', () => {
    const n1 = makeNode({ nodeNum: 1 });
    const n2 = makeNode({ nodeNum: 2 });
    const ctx = makeCtx({
      nodes: nodeMap([n1, n2]),
      graph: makeGraph([directEdge(1, 2)]),
      hopHorizon: new Map([[1, hopStats({ totalPackets: 20, exhaustedPackets: 11 })]]),
    });
    expect(tierBSkips(ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-rule assertions (mirrors rules.test.ts's Tier A pattern)
// ---------------------------------------------------------------------------

describe('cross-rule guardrails', () => {
  function buildFullFixture(): TierBRuleContext {
    // B1: 2 routers, direct.
    const b1a = makeNode({ nodeNum: 1, role: DeviceRole.ROUTER, longName: 'B1-A' });
    const b1b = makeNode({ nodeNum: 2, role: DeviceRole.ROUTER, longName: 'B1-B' });

    // B2: redundant router pair.
    const shared = Array.from({ length: 9 }, (_, i) => 1100 + i);
    const b2a = makeNode({ nodeNum: 10, role: DeviceRole.ROUTER });
    const b2b = makeNode({ nodeNum: 11, role: DeviceRole.ROUTER });
    const b2Edges = [
      ...shared.map((s) => directEdge(10, s)),
      directEdge(10, 1200),
      ...shared.map((s) => directEdge(11, s)),
      directEdge(11, 1300),
      directEdge(11, 1301),
    ];
    const b2SharedNodes = shared.map((s) => makeNode({ nodeNum: s }));

    // B3: asymmetric link.
    const b3a = makeNode({ nodeNum: 20, role: DeviceRole.ROUTER });
    const b3b = makeNode({ nodeNum: 21, role: null });
    const b3Edge = makeEdge({ a: 20, b: 21, snrToA: snr(3, 0), snrToB: snr(3, 10) });

    // B4: idle router + busy peer, same area.
    const b4r = makeNode({ nodeNum: 30, role: DeviceRole.ROUTER, latitude: 50.0, longitude: 60.0 });
    const b4p = makeNode({ nodeNum: 31, role: DeviceRole.ROUTER, latitude: 50.001, longitude: 60.001 });
    const b4Edges = [directEdge(30, 900), directEdge(31, 901)];
    const b4Samples: TracerouteSample[] = [];
    for (let i = 0; i < 20; i++) {
      b4Samples.push(sample({ fromNodeNum: 950, toNodeNum: b4r.nodeNum, routeHops: i < 3 ? [b4p.nodeNum] : [] }));
    }

    // B5: load-bearing client.
    const b5s = makeNode({ nodeNum: 40, role: DeviceRole.CLIENT, latitude: 70.0, longitude: 80.0, batteryLevel: 50 });
    const b5Samples: TracerouteSample[] = [];
    for (let i = 0; i < 10; i++) {
      b5Samples.push(sample({ fromNodeNum: 960, toNodeNum: 961, routeHops: [b5s.nodeNum] }));
    }

    // B6: hop horizon behind the B1 cluster.
    const b6subject = makeNode({ nodeNum: 50 });
    const b6Edge = makeEdge({ a: 1, b: 50, direct: false, evidenceClasses: ['gatewayCoReception'] });

    // B7: coverage shadow.
    const b7router = makeNode({ nodeNum: 60, role: DeviceRole.ROUTER, latitude: 90.0 - 1, longitude: 0.0 });
    const b7Neighbors = [1, 2, 3].map((km, i) =>
      makeNode({ nodeNum: 970 + i, latitude: 90.0 - 1 + km / 111, longitude: 0.0 }),
    );
    const b7Edges = b7Neighbors.map((n) => directEdge(b7router.nodeNum, n.nodeNum));
    const b7candidate = makeNode({
      nodeNum: 980,
      latitude: 90.0 - 1 + 1.5 / 111,
      longitude: 0.0,
      sourceIds: ['mqtt-src'],
    });

    const allNodes = [
      b1a,
      b1b,
      b2a,
      b2b,
      ...b2SharedNodes,
      makeNode({ nodeNum: 1200 }),
      makeNode({ nodeNum: 1300 }),
      makeNode({ nodeNum: 1301 }),
      b3a,
      b3b,
      b4r,
      b4p,
      makeNode({ nodeNum: 900 }),
      makeNode({ nodeNum: 901 }),
      b5s,
      b6subject,
      b7router,
      ...b7Neighbors,
      b7candidate,
    ];
    const allEdges = [
      directEdge(1, 2),
      ...b2Edges,
      b3Edge,
      ...b4Edges,
      b6Edge,
      ...b7Edges,
    ];

    return makeCtx({
      nodes: nodeMap(allNodes),
      graph: makeGraph(allEdges),
      samples: [...b4Samples, ...b5Samples],
      hopHorizon: new Map([[50, hopStats({ totalPackets: 20, exhaustedPackets: 15 })]]),
      mqttSourceIds: new Set(['mqtt-src']),
    });
  }

  it('every rule fires at least once, no recommendation promotes to ROUTER, every sourceIds is non-empty, every key is bounded, every list respects the cap', () => {
    const ctx = buildFullFixture();
    const findings = evaluateAllTierB(ctx);

    const issueTypes = new Set(findings.map((f) => f.issueType));
    expect(issueTypes).toEqual(
      new Set([
        MESH_ISSUE_TYPES.B1_ROUTER_CLUSTER,
        MESH_ISSUE_TYPES.B2_REDUNDANT_ROUTER,
        MESH_ISSUE_TYPES.B3_ASYMMETRIC_LINK,
        MESH_ISSUE_TYPES.B4_IDLE_ROUTER,
        MESH_ISSUE_TYPES.B5_LOAD_BEARING_CLIENT,
        MESH_ISSUE_TYPES.B6_HOP_HORIZON,
        MESH_ISSUE_TYPES.B7_COVERAGE_SHADOW,
      ]),
    );

    for (const f of findings) {
      expect(f.recommendation.toLowerCase()).not.toContain('promote');
      expect(f.recommendation).not.toMatch(/\bROUTER\b/);
      expect(f.sourceIds.length).toBeGreaterThan(0);
      expect(f.subjectKey.length).toBeLessThanOrEqual(128);
      expect(f.issueType.length).toBeLessThanOrEqual(64);

      for (const [key, value] of Object.entries(f.evidence)) {
        if (Array.isArray(value) && /members|edges|shared|other|cluster/i.test(key)) {
          expect(value.length).toBeLessThanOrEqual(EVIDENCE_MEMBER_LIST_CAP);
        }
      }
    }
  });
});
