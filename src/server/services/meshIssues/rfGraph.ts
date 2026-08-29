/**
 * RF adjacency graph builder for Mesh Issues Analysis Tier B (#4964, Phase 2
 * WP3). Builds an in-memory graph from three passive RF evidence classes:
 *
 *   1. `neighbor_info` — a node reported hearing another (DIRECT).
 *   2. Traceroute adjacent-hop links — an observed RF hop on a path (DIRECT).
 *   3. MQTT gateway receptions — a gateway heard a node at 0 hops
 *      (`gatewayDirect`, DIRECT, real SNR) and, derived from that, two nodes
 *      both direct at the same gateway (`gatewayCoReception`, INFERRED, no
 *      SNR — co-location in one gateway's cell is weaker than an observed
 *      link; two nodes on opposite edges of a gateway's coverage need not
 *      hear each other).
 *
 * Pure, dependency-free — no `databaseService` import, no I/O. Every input is
 * already-loaded, already-parsed data; every SNR value is already de-scaled
 * by the caller (traceroute links via `buildLegHopLinks`, `neighbor_info`/
 * gateway values verbatim — see the field docs below, do not re-derive the
 * `/4` traceroute scaling here).
 *
 * Deterministic: `buildRfGraph` sorts every accumulation key and every
 * output array before returning, so two calls over the same (possibly
 * differently-ordered) input produce byte-identical `JSON.stringify` output
 * per edge — required so `upsertFinding` doesn't churn `updatedAt` on a run
 * that observed the same evidence in a different order.
 */
import type { TracerouteSample } from './tracerouteCorpus.js';
import {
  buildLegHopLinks,
  hasRouteData,
  hasReturnPath,
  isValidRouteNode,
  type TracerouteHopLink,
} from '../../../utils/tracerouteSegments.js';
import {
  GATEWAY_DIRECT_MIN_RECEPTIONS,
  GATEWAY_CELL_MAX_NODES,
  GATEWAY_SNR_SAMPLE_CAP,
  ASYMMETRY_MIN_SAMPLES_PER_DIRECTION,
} from './thresholds.js';

export type RfEvidenceClass =
  | 'neighborInfo' // DIRECT — a node reported hearing another
  | 'traceroute' // DIRECT — an adjacent hop pair on an RF path
  | 'gatewayDirect' // DIRECT — an MQTT gateway heard a node at 0 hops
  | 'gatewayCoReception'; // INFERRED — two nodes both direct at one gateway

/** Classes that assert an OBSERVED radio link. `gatewayCoReception` only
 *  asserts co-location in one gateway's cell, which is weaker: two nodes on
 *  opposite sides of a gateway's coverage need not hear each other. */
export const DIRECT_EVIDENCE_CLASSES: ReadonlySet<RfEvidenceClass> = new Set([
  'neighborInfo',
  'traceroute',
  'gatewayDirect',
]);

export interface DirectionalSnr {
  count: number;
  meanDb: number | null;
  minDb: number | null;
  maxDb: number | null;
}

export interface RfEdge {
  /** a < b, always. */
  a: number;
  b: number;
  /** `${a}-${b}`. */
  key: string;
  evidenceClasses: RfEvidenceClass[]; // sorted
  /** True when at least one DIRECT class is present. */
  direct: boolean;
  neighborInfoCount: number;
  /** Distinct corpus samples carrying this hop pair. */
  tracerouteSampleCount: number;
  /** Distinct `sample.pairKey`s — the epic's "distinct pairs, not raw samples". */
  tracerouteDistinctPairCount: number;
  gatewayDirectCount: number;
  /** Gateway nodeNums that witnessed co-reception of a and b. Sorted. */
  coReceptionGateways: number[];
  /** Total observation weight: neighborInfoCount + tracerouteDistinctPairCount
   *  + gatewayDirectCount + coReceptionGateways.length. */
  observationCount: number;
  /** SNR measured AT `a` (i.e. b -> a). */
  snrToA: DirectionalSnr;
  /** SNR measured AT `b` (i.e. a -> b). */
  snrToB: DirectionalSnr;
  sourceIds: string[]; // sorted, deduped
  firstSeenMs: number | null;
  lastSeenMs: number | null;
}

export interface RfEvidenceAvailability {
  /** neighbor_info is always queried; false only when the query threw. */
  neighborInfo: boolean;
  /** Corpus had >=1 sample. */
  traceroute: boolean;
  /** mqtt_packet_log_enabled AND >=1 MQTT source resolved. */
  mqttGateway: boolean;
  /** packet_log_enabled. Not a graph input — carried for B6/coverage. */
  packetLog: boolean;
}

export interface RfGraphStats {
  availability: RfEvidenceAvailability;
  neighborInfoRowCount: number;
  neighborInfoEdgeCount: number;
  tracerouteHopLinkCount: number;
  tracerouteEdgeCount: number;
  /** Hops dropped because their arrival SNR was the unknown sentinel. */
  tracerouteSentinelHopsDropped: number;
  gatewayCount: number;
  gatewayDirectEdgeCount: number;
  gatewayCoReceptionEdgeCount: number;
  /** Gateways whose cell exceeded GATEWAY_CELL_MAX_NODES and was skipped. */
  gatewayCellsSkipped: number;
  totalEdgeCount: number;
  directEdgeCount: number;
  nodeCount: number;
  /** Directions with >= ASYMMETRY_MIN_SAMPLES_PER_DIRECTION samples (B3 fuel). */
  snrDirectionsWithMinSamples: number;
}

export interface RfGraph {
  /** key -> edge. */
  edges: Map<string, RfEdge>;
  /** nodeNum -> neighbours, DIRECT-evidence edges only. */
  directAdjacency: Map<number, Set<number>>;
  /** nodeNum -> neighbours, all edges including inferred. */
  adjacency: Map<number, Set<number>>;
  stats: RfGraphStats;
}

export interface NeighborEdgeInput {
  nodeNum: number | string; // the REPORTING node (receiver)
  neighborNum: number | string; // the node it heard (transmitter)
  snr: number | null; // already dB — neighbor_info.snr is protobuf float
  timestamp: number;
  sourceId: string;
}

export interface GatewayDirectReceptionInput {
  gatewayNodeNum: number;
  fromNode: number;
  sourceId: string;
  receptionCount: number;
  meanRxSnr: number | null; // already dB — mqtt_packet_log.rxSnr is float
  firstSeen: number;
  lastSeen: number;
}

export interface BuildRfGraphOptions {
  samples: TracerouteSample[];
  neighbors: NeighborEdgeInput[];
  gatewayReceptions: GatewayDirectReceptionInput[];
  availability: RfEvidenceAvailability;
  /** Test seam; defaults to GATEWAY_CELL_MAX_NODES. */
  maxGatewayCellSize?: number;
}

/** `${min(a,b)}-${max(a,b)}` — order-independent edge identity. */
export function edgeKey(a: number, b: number): string {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return `${lo}-${hi}`;
}

// ---------------------------------------------------------------------------
// Internal accumulator state
// ---------------------------------------------------------------------------

interface SnrAcc {
  count: number;
  sum: number;
  min: number;
  max: number;
}

function newSnrAcc(): SnrAcc {
  return { count: 0, sum: 0, min: Infinity, max: -Infinity };
}

function finalizeSnr(acc: SnrAcc): DirectionalSnr {
  if (acc.count === 0) return { count: 0, meanDb: null, minDb: null, maxDb: null };
  return { count: acc.count, meanDb: acc.sum / acc.count, minDb: acc.min, maxDb: acc.max };
}

function addSnrSample(acc: SnrAcc, value: number, weight = 1): void {
  acc.count += weight;
  acc.sum += value * weight;
  if (value < acc.min) acc.min = value;
  if (value > acc.max) acc.max = value;
}

interface EdgeAcc {
  a: number;
  b: number;
  key: string;
  evidenceClasses: Set<RfEvidenceClass>;
  neighborInfoCount: number;
  tracerouteSampleIds: Set<number>;
  tracerouteDistinctPairKeys: Set<string>;
  gatewayDirectCount: number;
  coReceptionGateways: Set<number>;
  snrToA: SnrAcc;
  snrToB: SnrAcc;
  sourceIds: Set<string>;
  firstSeenMs: number | null;
  lastSeenMs: number | null;
}

function getOrCreateEdge(map: Map<string, EdgeAcc>, n1: number, n2: number): EdgeAcc {
  const key = edgeKey(n1, n2);
  let acc = map.get(key);
  if (!acc) {
    acc = {
      a: Math.min(n1, n2),
      b: Math.max(n1, n2),
      key,
      evidenceClasses: new Set(),
      neighborInfoCount: 0,
      tracerouteSampleIds: new Set(),
      tracerouteDistinctPairKeys: new Set(),
      gatewayDirectCount: 0,
      coReceptionGateways: new Set(),
      snrToA: newSnrAcc(),
      snrToB: newSnrAcc(),
      sourceIds: new Set(),
      firstSeenMs: null,
      lastSeenMs: null,
    };
    map.set(key, acc);
  }
  return acc;
}

/** Add an SNR sample measured AT `towardNodeNum`, which must be one of the
 *  edge's two endpoints. */
function snrToward(acc: EdgeAcc, towardNodeNum: number, value: number, weight = 1): void {
  if (towardNodeNum === acc.a) addSnrSample(acc.snrToA, value, weight);
  else if (towardNodeNum === acc.b) addSnrSample(acc.snrToB, value, weight);
}

function extendSeen(acc: EdgeAcc, ts: number | null | undefined): void {
  if (ts == null || !Number.isFinite(ts)) return;
  if (acc.firstSeenMs === null || ts < acc.firstSeenMs) acc.firstSeenMs = ts;
  if (acc.lastSeenMs === null || ts > acc.lastSeenMs) acc.lastSeenMs = ts;
}

function sortStrings(values: Iterable<string>): string[] {
  return Array.from(values).sort();
}

function sortNumbers(values: Iterable<number>): number[] {
  return Array.from(values).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Evidence class 1 — neighbor_info
// ---------------------------------------------------------------------------

interface NeighborGroup {
  winner: NeighborEdgeInput;
  sourceIds: string[];
}

/**
 * Dedup rows by `(nodeNum, neighborNum, timestamp)` — one NeighborInfo packet
 * arrives via TCP and again via N MQTT gateways, the same cross-source
 * collapse `buildTelemetrySeries` uses. The winner (lowest sourceId after
 * sorting `timestamp asc, sourceId asc` — timestamp is fixed within a group,
 * so this is a deterministic sourceId tiebreak) supplies the SNR sample and
 * count so the same physical observation is never counted twice; ALL
 * sourceIds in the group are still unioned into the caller's edge sourceIds,
 * since every source that relayed the observation genuinely contributed it.
 */
function dedupNeighborRows(rows: NeighborEdgeInput[]): NeighborGroup[] {
  const groups = new Map<string, NeighborEdgeInput[]>();
  for (const row of rows) {
    const nodeNum = Number(row.nodeNum);
    const neighborNum = Number(row.neighborNum);
    const key = `${nodeNum}:${neighborNum}:${row.timestamp}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const result: NeighborGroup[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((x, y) => {
      if (x.timestamp !== y.timestamp) return x.timestamp - y.timestamp;
      return x.sourceId < y.sourceId ? -1 : x.sourceId > y.sourceId ? 1 : 0;
    });
    result.push({ winner: sorted[0], sourceIds: sortStrings(new Set(group.map((r) => r.sourceId))) });
  }

  // Deterministic processing order regardless of input order.
  result.sort((x, y) => {
    const xn = Number(x.winner.nodeNum);
    const yn = Number(y.winner.nodeNum);
    if (xn !== yn) return xn - yn;
    const xm = Number(x.winner.neighborNum);
    const ym = Number(y.winner.neighborNum);
    if (xm !== ym) return xm - ym;
    return x.winner.timestamp - y.winner.timestamp;
  });

  return result;
}

function applyNeighborEvidence(edgeMap: Map<string, EdgeAcc>, neighbors: NeighborEdgeInput[]): void {
  for (const { winner, sourceIds } of dedupNeighborRows(neighbors)) {
    const nodeNum = Number(winner.nodeNum);
    const neighborNum = Number(winner.neighborNum);
    if (nodeNum === neighborNum) continue;
    if (!isValidRouteNode(nodeNum) || !isValidRouteNode(neighborNum)) continue;

    const acc = getOrCreateEdge(edgeMap, nodeNum, neighborNum);
    acc.evidenceClasses.add('neighborInfo');
    acc.neighborInfoCount += 1;
    for (const sid of sourceIds) acc.sourceIds.add(sid);
    extendSeen(acc, winner.timestamp);
    // The reporter (nodeNum) is the receiver — the SNR sample is measured AT it.
    if (winner.snr != null && Number.isFinite(winner.snr)) {
      snrToward(acc, nodeNum, winner.snr);
    }
  }
}

// ---------------------------------------------------------------------------
// Evidence class 2 — traceroute adjacent-hop links
// ---------------------------------------------------------------------------

interface TracerouteEvidenceResult {
  tracerouteHopLinkCount: number;
  tracerouteSentinelHopsDropped: number;
}

function applyTracerouteEvidence(
  edgeMap: Map<string, EdgeAcc>,
  samples: TracerouteSample[],
): TracerouteEvidenceResult {
  let tracerouteHopLinkCount = 0;
  let tracerouteSentinelHopsDropped = 0;

  // Deterministic processing order regardless of input order.
  const sortedSamples = [...samples].sort((a, b) => a.id - b.id);

  for (const sample of sortedSamples) {
    const links: TracerouteHopLink[] = [];
    if (hasRouteData(sample.route)) {
      links.push(
        ...buildLegHopLinks('forward', sample.fromNodeNum, sample.routeHops, sample.toNodeNum, sample.snrTowardsValues),
      );
    }
    if (hasReturnPath(sample.routeBackHops, sample.snrBack)) {
      links.push(
        ...buildLegHopLinks('return', sample.toNodeNum, sample.routeBackHops, sample.fromNodeNum, sample.snrBackValues),
      );
    }

    for (const link of links) {
      tracerouteHopLinkCount += 1;
      if (link.fromNodeNum === link.toNodeNum) continue;
      if (!isValidRouteNode(link.fromNodeNum) || !isValidRouteNode(link.toNodeNum)) continue;
      if (link.snrUnknown) {
        tracerouteSentinelHopsDropped += 1;
        continue;
      }

      const acc = getOrCreateEdge(edgeMap, link.fromNodeNum, link.toNodeNum);
      acc.evidenceClasses.add('traceroute');
      // "count the sample once per edge" — Set membership handles a sample
      // contributing the same edge twice (e.g. forward AND return legs both
      // touching the same hop pair) without double counting.
      acc.tracerouteSampleIds.add(sample.id);
      acc.tracerouteDistinctPairKeys.add(sample.pairKey);
      acc.sourceIds.add(sample.sourceId);
      extendSeen(acc, sample.timestamp);
      if (link.snrDb != null) {
        snrToward(acc, link.toNodeNum, link.snrDb);
      }
    }
  }

  return { tracerouteHopLinkCount, tracerouteSentinelHopsDropped };
}

// ---------------------------------------------------------------------------
// Evidence class 3 — MQTT gateway (direct + co-reception)
// ---------------------------------------------------------------------------

interface GatewayEvidenceResult {
  gatewayCount: number;
  gatewayCellsSkipped: number;
}

function applyGatewayEvidence(
  edgeMap: Map<string, EdgeAcc>,
  gatewayReceptions: GatewayDirectReceptionInput[],
  maxGatewayCellSize: number,
): GatewayEvidenceResult {
  const validRows = gatewayReceptions.filter(
    (row) =>
      row.receptionCount >= GATEWAY_DIRECT_MIN_RECEPTIONS &&
      row.gatewayNodeNum !== row.fromNode &&
      isValidRouteNode(row.gatewayNodeNum) &&
      isValidRouteNode(row.fromNode),
  );

  // Deterministic processing order regardless of input order.
  const sortedRows = [...validRows].sort((x, y) => {
    if (x.gatewayNodeNum !== y.gatewayNodeNum) return x.gatewayNodeNum - y.gatewayNodeNum;
    if (x.fromNode !== y.fromNode) return x.fromNode - y.fromNode;
    return x.sourceId < y.sourceId ? -1 : x.sourceId > y.sourceId ? 1 : 0;
  });

  // 3a — gatewayDirect: DIRECT edge (gateway, fromNode) with real SNR.
  for (const row of sortedRows) {
    const acc = getOrCreateEdge(edgeMap, row.gatewayNodeNum, row.fromNode);
    acc.evidenceClasses.add('gatewayDirect');
    acc.gatewayDirectCount += row.receptionCount;
    acc.sourceIds.add(row.sourceId);
    extendSeen(acc, row.firstSeen);
    extendSeen(acc, row.lastSeen);
    if (row.meanRxSnr != null && Number.isFinite(row.meanRxSnr)) {
      const weight = Math.min(row.receptionCount, GATEWAY_SNR_SAMPLE_CAP);
      snrToward(acc, row.gatewayNodeNum, row.meanRxSnr, weight);
    }
  }

  // 3b — gatewayCoReception: INFERRED edge for every unordered pair of nodes
  // direct at the same gateway, unless the cell is too large to bound the
  // O(k^2) pair expansion.
  const cellMap = new Map<number, Set<number>>();
  for (const row of sortedRows) {
    let set = cellMap.get(row.gatewayNodeNum);
    if (!set) {
      set = new Set();
      cellMap.set(row.gatewayNodeNum, set);
    }
    set.add(row.fromNode);
  }

  let gatewayCellsSkipped = 0;
  const sortedGatewayNums = sortNumbers(cellMap.keys());
  for (const gatewayNodeNum of sortedGatewayNums) {
    const nodes = sortNumbers(cellMap.get(gatewayNodeNum) ?? []);
    if (nodes.length > maxGatewayCellSize) {
      gatewayCellsSkipped += 1;
      continue;
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const acc = getOrCreateEdge(edgeMap, nodes[i], nodes[j]);
        acc.evidenceClasses.add('gatewayCoReception');
        acc.coReceptionGateways.add(gatewayNodeNum);
      }
    }
  }

  return { gatewayCount: sortedGatewayNums.length, gatewayCellsSkipped };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function countEdgesWithClass(edges: Map<string, RfEdge>, cls: RfEvidenceClass): number {
  let count = 0;
  for (const edge of edges.values()) {
    if (edge.evidenceClasses.includes(cls)) count += 1;
  }
  return count;
}

function addAdjacency(map: Map<number, Set<number>>, a: number, b: number): void {
  if (!map.has(a)) map.set(a, new Set());
  if (!map.has(b)) map.set(b, new Set());
  map.get(a)!.add(b);
  map.get(b)!.add(a);
}

export function buildRfGraph(opts: BuildRfGraphOptions): RfGraph {
  const edgeMap = new Map<string, EdgeAcc>();

  applyNeighborEvidence(edgeMap, opts.neighbors);
  const { tracerouteHopLinkCount, tracerouteSentinelHopsDropped } = applyTracerouteEvidence(edgeMap, opts.samples);
  const maxGatewayCellSize = opts.maxGatewayCellSize ?? GATEWAY_CELL_MAX_NODES;
  const { gatewayCount, gatewayCellsSkipped } = applyGatewayEvidence(
    edgeMap,
    opts.gatewayReceptions,
    maxGatewayCellSize,
  );

  // Finalize in sorted key order so the resulting Map's iteration order (and
  // every array field within each edge) is independent of input order.
  const edges = new Map<string, RfEdge>();
  for (const key of Array.from(edgeMap.keys()).sort()) {
    const acc = edgeMap.get(key)!;
    const evidenceClasses = sortStrings(acc.evidenceClasses) as RfEvidenceClass[];
    const direct = evidenceClasses.some((c) => DIRECT_EVIDENCE_CLASSES.has(c));
    const coReceptionGateways = sortNumbers(acc.coReceptionGateways);
    edges.set(key, {
      a: acc.a,
      b: acc.b,
      key: acc.key,
      evidenceClasses,
      direct,
      neighborInfoCount: acc.neighborInfoCount,
      tracerouteSampleCount: acc.tracerouteSampleIds.size,
      tracerouteDistinctPairCount: acc.tracerouteDistinctPairKeys.size,
      gatewayDirectCount: acc.gatewayDirectCount,
      coReceptionGateways,
      observationCount:
        acc.neighborInfoCount + acc.tracerouteDistinctPairKeys.size + acc.gatewayDirectCount + coReceptionGateways.length,
      snrToA: finalizeSnr(acc.snrToA),
      snrToB: finalizeSnr(acc.snrToB),
      sourceIds: sortStrings(acc.sourceIds),
      firstSeenMs: acc.firstSeenMs,
      lastSeenMs: acc.lastSeenMs,
    });
  }

  const directAdjacency = new Map<number, Set<number>>();
  const adjacency = new Map<number, Set<number>>();
  const nodeSet = new Set<number>();
  let snrDirectionsWithMinSamples = 0;
  for (const edge of edges.values()) {
    addAdjacency(adjacency, edge.a, edge.b);
    if (edge.direct) addAdjacency(directAdjacency, edge.a, edge.b);
    nodeSet.add(edge.a);
    nodeSet.add(edge.b);
    if (edge.snrToA.count >= ASYMMETRY_MIN_SAMPLES_PER_DIRECTION) snrDirectionsWithMinSamples += 1;
    if (edge.snrToB.count >= ASYMMETRY_MIN_SAMPLES_PER_DIRECTION) snrDirectionsWithMinSamples += 1;
  }

  const stats: RfGraphStats = {
    availability: opts.availability,
    neighborInfoRowCount: opts.neighbors.length,
    neighborInfoEdgeCount: countEdgesWithClass(edges, 'neighborInfo'),
    tracerouteHopLinkCount,
    tracerouteEdgeCount: countEdgesWithClass(edges, 'traceroute'),
    tracerouteSentinelHopsDropped,
    gatewayCount,
    gatewayDirectEdgeCount: countEdgesWithClass(edges, 'gatewayDirect'),
    gatewayCoReceptionEdgeCount: countEdgesWithClass(edges, 'gatewayCoReception'),
    gatewayCellsSkipped,
    totalEdgeCount: edges.size,
    directEdgeCount: Array.from(edges.values()).filter((e) => e.direct).length,
    nodeCount: nodeSet.size,
    snrDirectionsWithMinSamples,
  };

  return { edges, directAdjacency, adjacency, stats };
}
