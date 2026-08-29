import { describe, it, expect } from 'vitest';
import {
  buildRfGraph,
  edgeKey,
  DIRECT_EVIDENCE_CLASSES,
  type BuildRfGraphOptions,
  type NeighborEdgeInput,
  type GatewayDirectReceptionInput,
  type RfEvidenceAvailability,
  type RfEdge,
} from './rfGraph.js';
import type { TracerouteSample } from './tracerouteCorpus.js';
import {
  GATEWAY_DIRECT_MIN_RECEPTIONS,
  GATEWAY_SNR_SAMPLE_CAP,
  ASYMMETRY_MIN_SAMPLES_PER_DIRECTION,
} from './thresholds.js';

const AVAILABILITY: RfEvidenceAvailability = {
  neighborInfo: true,
  traceroute: true,
  mqttGateway: true,
  packetLog: false,
};

function opts(overrides: Partial<BuildRfGraphOptions> = {}): BuildRfGraphOptions {
  return {
    samples: [],
    neighbors: [],
    gatewayReceptions: [],
    availability: AVAILABILITY,
    ...overrides,
  };
}

function neighborRow(overrides: Partial<NeighborEdgeInput> = {}): NeighborEdgeInput {
  return {
    nodeNum: 100,
    neighborNum: 200,
    snr: null,
    timestamp: 1_000_000,
    sourceId: 'src-a',
    ...overrides,
  };
}

let nextSampleId = 1;

/** Builds a TracerouteSample directly (rfGraph consumes samples, not raw
 *  TracerouteRow — mirrors what buildTracerouteCorpus would hand it). */
function sample(overrides: Partial<TracerouteSample> = {}): TracerouteSample {
  const fromNodeNum = overrides.fromNodeNum ?? 100;
  const toNodeNum = overrides.toNodeNum ?? 200;
  return {
    id: nextSampleId++,
    fromNodeNum,
    toNodeNum,
    sourceId: 'src-a',
    route: '[]',
    routeBack: null,
    snrTowards: '[]',
    snrBack: null,
    timestamp: 1_000_000,
    createdAt: 1_000_000,
    packetId: 1,
    routeHops: [],
    routeBackHops: [],
    snrTowardsValues: [],
    snrBackValues: [],
    pairKey: fromNodeNum <= toNodeNum ? `${fromNodeNum}-${toNodeNum}` : `${toNodeNum}-${fromNodeNum}`,
    bucket: 0,
    ...overrides,
  };
}

function gatewayRow(overrides: Partial<GatewayDirectReceptionInput> = {}): GatewayDirectReceptionInput {
  return {
    gatewayNodeNum: 900,
    fromNode: 901,
    sourceId: 'src-a',
    receptionCount: GATEWAY_DIRECT_MIN_RECEPTIONS,
    meanRxSnr: null,
    firstSeen: 1_000_000,
    lastSeen: 1_000_100,
    ...overrides,
  };
}

function findEdge(edges: Map<string, RfEdge>, a: number, b: number): RfEdge | undefined {
  return edges.get(edgeKey(a, b));
}

describe('edgeKey', () => {
  it('is order-independent', () => {
    expect(edgeKey(100, 200)).toBe('100-200');
    expect(edgeKey(200, 100)).toBe('100-200');
  });
});

describe('buildRfGraph — neighbor_info evidence in isolation', () => {
  it('produces a single DIRECT edge with the expected classes and counts', () => {
    const graph = buildRfGraph(opts({ neighbors: [neighborRow()] }));
    expect(graph.stats.totalEdgeCount).toBe(1);
    const edge = findEdge(graph.edges, 100, 200)!;
    expect(edge).toBeDefined();
    expect(edge.evidenceClasses).toEqual(['neighborInfo']);
    expect(edge.direct).toBe(true);
    expect(edge.neighborInfoCount).toBe(1);
    expect(graph.stats.neighborInfoEdgeCount).toBe(1);
  });

  it('attributes SNR to the REPORTER (nodeNum), not the neighbour', () => {
    // nodeNum=100 is `a` in edge(100,200) — SNR measured at the reporter goes to snrToA.
    const graphA = buildRfGraph(opts({ neighbors: [neighborRow({ nodeNum: 100, neighborNum: 200, snr: 5 })] }));
    const edgeA = findEdge(graphA.edges, 100, 200)!;
    expect(edgeA.snrToA).toMatchObject({ count: 1, meanDb: 5 });
    expect(edgeA.snrToB.count).toBe(0);

    // nodeNum=200 is `b` — SNR measured at the reporter now goes to snrToB.
    const graphB = buildRfGraph(opts({ neighbors: [neighborRow({ nodeNum: 200, neighborNum: 100, snr: 5 })] }));
    const edgeB = findEdge(graphB.edges, 100, 200)!;
    expect(edgeB.snrToB).toMatchObject({ count: 1, meanDb: 5 });
    expect(edgeB.snrToA.count).toBe(0);
  });

  it('collapses a cross-source duplicate (same nodeNum/neighborNum/timestamp) to one sample but unions both sourceIds', () => {
    const graph = buildRfGraph(
      opts({
        neighbors: [
          neighborRow({ sourceId: 'src-a', snr: 4 }),
          neighborRow({ sourceId: 'src-b', snr: 4 }),
        ],
      }),
    );
    const edge = findEdge(graph.edges, 100, 200)!;
    expect(edge.neighborInfoCount).toBe(1);
    expect(edge.snrToA.count).toBe(1);
    expect(edge.sourceIds).toEqual(['src-a', 'src-b']);
  });

  it('drops a self-loop (nodeNum === neighborNum) and reserved node numbers', () => {
    const graph = buildRfGraph(
      opts({
        neighbors: [
          neighborRow({ nodeNum: 100, neighborNum: 100 }),
          neighborRow({ nodeNum: 1, neighborNum: 200 }), // reserved
        ],
      }),
    );
    expect(graph.stats.totalEdgeCount).toBe(0);
  });
});

describe('buildRfGraph — traceroute hop-link evidence in isolation', () => {
  it('produces a DIRECT edge for a direct (no-intermediate-hop) sample', () => {
    const graph = buildRfGraph(opts({ samples: [sample()] }));
    const edge = findEdge(graph.edges, 100, 200)!;
    expect(edge.evidenceClasses).toEqual(['traceroute']);
    expect(edge.direct).toBe(true);
    expect(edge.tracerouteSampleCount).toBe(1);
    expect(edge.tracerouteDistinctPairCount).toBe(1);
    expect(graph.stats.tracerouteEdgeCount).toBe(1);
  });

  it('drops a hop whose arrival SNR is the sentinel, and counts it', () => {
    // fromNodeNum=100 -> hop 150 -> toNodeNum=200. snrTowardsValues[0] is the
    // arrival SNR at 150 (raw -128 => scaled -32, the sentinel); [1] is the
    // arrival SNR at 200 (raw -30 => scaled -7.5, a real reading).
    const s = sample({
      fromNodeNum: 100,
      toNodeNum: 200,
      routeHops: [150],
      route: JSON.stringify([150]),
      snrTowardsValues: [-128, -30],
      snrTowards: JSON.stringify([-128, -30]),
    });
    const graph = buildRfGraph(opts({ samples: [s] }));

    expect(graph.stats.tracerouteSentinelHopsDropped).toBe(1);
    expect(findEdge(graph.edges, 100, 150)).toBeUndefined();
    const survivingEdge = findEdge(graph.edges, 150, 200)!;
    expect(survivingEdge).toBeDefined();
    expect(survivingEdge.snrToB.meanDb).toBe(-7.5); // toB because 200 === edge.b
  });

  it('tracerouteDistinctPairCount counts distinct pairKeys, not raw samples', () => {
    const s1 = sample({ fromNodeNum: 100, toNodeNum: 200, bucket: 0 });
    const s2 = sample({ fromNodeNum: 100, toNodeNum: 200, bucket: 1 }); // same pair, different bucket
    const graph = buildRfGraph(opts({ samples: [s1, s2] }));
    const edge = findEdge(graph.edges, 100, 200)!;
    expect(edge.tracerouteSampleCount).toBe(2);
    expect(edge.tracerouteDistinctPairCount).toBe(1);
  });

  it('counts a sample once per edge even if it touches the same hop pair twice (forward + return)', () => {
    // hasReturnPath requires routeBack non-empty OR snrBack carrying real data
    // (the literal string '[]' is explicitly excluded by hasReturnPath) — a
    // direct return leg with a real SNR reading satisfies that.
    const s = sample({
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      routeBackHops: [],
      snrBack: JSON.stringify([-30]),
      snrBackValues: [-30],
    });
    const graph = buildRfGraph(opts({ samples: [s] }));
    const edge = findEdge(graph.edges, 100, 200)!;
    // forward leg gives one 100-200 link, return leg gives one 200-100 link
    // (same unordered edge) — the sample must count once, not twice.
    expect(edge.tracerouteSampleCount).toBe(1);
  });
});

describe('buildRfGraph — MQTT gateway evidence in isolation', () => {
  it('gatewayDirect creates a DIRECT edge with SNR toward the gateway, capped at GATEWAY_SNR_SAMPLE_CAP', () => {
    const row = gatewayRow({ gatewayNodeNum: 900, fromNode: 901, receptionCount: GATEWAY_SNR_SAMPLE_CAP + 10, meanRxSnr: -6 });
    const graph = buildRfGraph(opts({ gatewayReceptions: [row] }));
    const edge = findEdge(graph.edges, 900, 901)!;
    expect(edge.evidenceClasses).toEqual(['gatewayDirect']);
    expect(edge.direct).toBe(true);
    expect(edge.gatewayDirectCount).toBe(GATEWAY_SNR_SAMPLE_CAP + 10);
    // SNR toward the gateway (900 === edge.a since 900 < 901).
    expect(edge.snrToA.count).toBe(GATEWAY_SNR_SAMPLE_CAP);
    expect(edge.snrToA.meanDb).toBe(-6);
  });

  it('drops rows where gatewayNodeNum === fromNode', () => {
    const graph = buildRfGraph(opts({ gatewayReceptions: [gatewayRow({ gatewayNodeNum: 500, fromNode: 500 })] }));
    expect(graph.stats.totalEdgeCount).toBe(0);
  });

  it('drops rows below GATEWAY_DIRECT_MIN_RECEPTIONS', () => {
    const graph = buildRfGraph(
      opts({ gatewayReceptions: [gatewayRow({ receptionCount: GATEWAY_DIRECT_MIN_RECEPTIONS - 1 })] }),
    );
    expect(graph.stats.totalEdgeCount).toBe(0);
  });

  it('a gateway cell of k nodes yields k*(k-1)/2 inferred co-reception edges', () => {
    const rows = [901, 902, 903, 904].map((fromNode) => gatewayRow({ gatewayNodeNum: 900, fromNode }));
    const graph = buildRfGraph(opts({ gatewayReceptions: rows, maxGatewayCellSize: 10 }));
    expect(graph.stats.gatewayCoReceptionEdgeCount).toBe(6); // C(4,2)
    expect(graph.stats.gatewayCellsSkipped).toBe(0);
    const pairEdge = findEdge(graph.edges, 901, 902)!;
    expect(pairEdge.evidenceClasses).toEqual(['gatewayCoReception']);
    expect(pairEdge.direct).toBe(false);
    expect(pairEdge.coReceptionGateways).toEqual([900]);
    expect(pairEdge.snrToA.count).toBe(0);
    expect(pairEdge.snrToB.count).toBe(0);
  });

  it('a cell above maxGatewayCellSize yields no co-reception edges and bumps gatewayCellsSkipped', () => {
    const rows = [901, 902, 903, 904].map((fromNode) => gatewayRow({ gatewayNodeNum: 900, fromNode }));
    const graph = buildRfGraph(opts({ gatewayReceptions: rows, maxGatewayCellSize: 3 }));
    expect(graph.stats.gatewayCoReceptionEdgeCount).toBe(0);
    expect(graph.stats.gatewayCellsSkipped).toBe(1);
    // gatewayDirect edges to each of the 4 nodes still exist independently.
    expect(graph.stats.gatewayDirectEdgeCount).toBe(4);
  });
});

describe('buildRfGraph — direct vs inferred adjacency', () => {
  it('directAdjacency excludes inferred-only (co-reception) edges; adjacency includes them', () => {
    const rows = [901, 902].map((fromNode) => gatewayRow({ gatewayNodeNum: 900, fromNode }));
    const graph = buildRfGraph(opts({ gatewayReceptions: rows, maxGatewayCellSize: 10 }));

    // 901-902 is inferred-only (co-reception).
    expect(graph.adjacency.get(901)?.has(902)).toBe(true);
    expect(graph.directAdjacency.get(901)?.has(902) ?? false).toBe(false);

    // 900-901 and 900-902 are DIRECT (gatewayDirect).
    expect(graph.directAdjacency.get(900)?.has(901)).toBe(true);
    expect(graph.directAdjacency.get(900)?.has(902)).toBe(true);
  });
});

describe('buildRfGraph — evidence union across all four classes', () => {
  it('an edge attested by all four classes carries all four (sorted), merged SNR and unioned sourceIds', () => {
    const graph = buildRfGraph(
      opts({
        neighbors: [neighborRow({ nodeNum: 100, neighborNum: 200, snr: 3, sourceId: 'src-neighbor' })],
        samples: [sample({ fromNodeNum: 100, toNodeNum: 200, sourceId: 'src-tr' })],
        gatewayReceptions: [
          // gatewayDirect: gateway=100 heard fromNode=200 directly -> edge(100,200).
          gatewayRow({ gatewayNodeNum: 100, fromNode: 200, sourceId: 'src-gw-direct', meanRxSnr: -4 }),
          // gatewayCoReception: a third gateway 950 hears both 100 and 200 directly -> edge(100,200) too.
          gatewayRow({ gatewayNodeNum: 950, fromNode: 100, sourceId: 'src-gw-a' }),
          gatewayRow({ gatewayNodeNum: 950, fromNode: 200, sourceId: 'src-gw-b' }),
        ],
        maxGatewayCellSize: 10,
      }),
    );

    const edge = findEdge(graph.edges, 100, 200)!;
    expect(edge.evidenceClasses).toEqual(
      Array.from(new Set(['neighborInfo', 'traceroute', 'gatewayDirect', 'gatewayCoReception'])).sort(),
    );
    expect(edge.direct).toBe(true);
    expect(edge.coReceptionGateways).toEqual([950]);
    expect(edge.sourceIds).toEqual(['src-gw-direct', 'src-neighbor', 'src-tr'].sort());
    // SNR from neighborInfo (1 sample) and gatewayDirect (weight = min(receptionCount,
    // GATEWAY_SNR_SAMPLE_CAP) = GATEWAY_DIRECT_MIN_RECEPTIONS here) both land in
    // snrToA, since both the reporter (100) and the gateway (100) are edge.a.
    expect(edge.snrToA.count).toBe(1 + GATEWAY_DIRECT_MIN_RECEPTIONS);
  });
});

describe('buildRfGraph — coverage counters', () => {
  it('snrDirectionsWithMinSamples counts directions meeting ASYMMETRY_MIN_SAMPLES_PER_DIRECTION', () => {
    const row = gatewayRow({
      gatewayNodeNum: 900,
      fromNode: 901,
      receptionCount: ASYMMETRY_MIN_SAMPLES_PER_DIRECTION,
      meanRxSnr: -5,
    });
    const graph = buildRfGraph(opts({ gatewayReceptions: [row] }));
    expect(graph.stats.snrDirectionsWithMinSamples).toBe(1);
    expect(graph.stats.totalEdgeCount).toBe(1);
    expect(graph.stats.directEdgeCount).toBe(1);
    expect(graph.stats.nodeCount).toBe(2);
  });

  it('carries the availability flags through unchanged', () => {
    const graph = buildRfGraph(opts());
    expect(graph.stats.availability).toEqual(AVAILABILITY);
  });

  it('DIRECT_EVIDENCE_CLASSES excludes gatewayCoReception', () => {
    expect(DIRECT_EVIDENCE_CLASSES.has('gatewayCoReception')).toBe(false);
    expect(DIRECT_EVIDENCE_CLASSES.has('neighborInfo')).toBe(true);
    expect(DIRECT_EVIDENCE_CLASSES.has('traceroute')).toBe(true);
    expect(DIRECT_EVIDENCE_CLASSES.has('gatewayDirect')).toBe(true);
  });
});

describe('buildRfGraph — determinism', () => {
  it('produces byte-identical edge JSON regardless of input order', () => {
    const neighbors: NeighborEdgeInput[] = [
      neighborRow({ nodeNum: 100, neighborNum: 200, snr: 3, sourceId: 'src-a' }),
      neighborRow({ nodeNum: 200, neighborNum: 300, snr: 2, sourceId: 'src-b', timestamp: 1_000_500 }),
    ];
    const samples: TracerouteSample[] = [
      sample({ fromNodeNum: 100, toNodeNum: 300, sourceId: 'src-c' }),
      sample({ fromNodeNum: 200, toNodeNum: 300, sourceId: 'src-d', timestamp: 1_000_200 }),
    ];
    const gatewayReceptions: GatewayDirectReceptionInput[] = [
      gatewayRow({ gatewayNodeNum: 900, fromNode: 100, meanRxSnr: -4 }),
      gatewayRow({ gatewayNodeNum: 900, fromNode: 200, meanRxSnr: -5 }),
      gatewayRow({ gatewayNodeNum: 900, fromNode: 300, meanRxSnr: -6 }),
    ];

    const forward = buildRfGraph(opts({ neighbors, samples, gatewayReceptions, maxGatewayCellSize: 10 }));
    const shuffled = buildRfGraph(
      opts({
        neighbors: [...neighbors].reverse(),
        samples: [...samples].reverse(),
        gatewayReceptions: [...gatewayReceptions].reverse(),
        maxGatewayCellSize: 10,
      }),
    );

    const serialize = (edges: Map<string, RfEdge>) => JSON.stringify(Array.from(edges.entries()));
    expect(serialize(forward.edges)).toBe(serialize(shuffled.edges));
  });
});

describe('buildRfGraph — empty and degraded input', () => {
  it('never throws and returns a correctly-shaped empty graph', () => {
    expect(() => buildRfGraph(opts())).not.toThrow();
    const graph = buildRfGraph(opts());
    expect(graph.edges.size).toBe(0);
    expect(graph.adjacency.size).toBe(0);
    expect(graph.directAdjacency.size).toBe(0);
    expect(graph.stats).toMatchObject({
      neighborInfoRowCount: 0,
      neighborInfoEdgeCount: 0,
      tracerouteHopLinkCount: 0,
      tracerouteEdgeCount: 0,
      tracerouteSentinelHopsDropped: 0,
      gatewayCount: 0,
      gatewayDirectEdgeCount: 0,
      gatewayCoReceptionEdgeCount: 0,
      gatewayCellsSkipped: 0,
      totalEdgeCount: 0,
      directEdgeCount: 0,
      nodeCount: 0,
      snrDirectionsWithMinSamples: 0,
    });
  });
});
