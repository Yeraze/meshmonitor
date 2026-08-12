/**
 * Traceroute statistical union — pure counting model (Statistical Route epic,
 * Phase 1 WP2).
 *
 * Pure, React-free, API-free, DB-free — safe to import from a node-environment
 * test or from any presentation layer. This module answers a different
 * question than `tracerouteStrip.ts`: given N traceroute rows between the
 * SAME two endpoints, how often did each node and each adjacency appear? The
 * output is a counting model (`TracerouteUnionGraph`), not a render model —
 * undirected, SNR-free, with no column/row placement. `tracerouteUnionLayout.ts`
 * (WP3) turns this into a `UnionStripGraph` for the strip renderer.
 *
 * See `docs/internal/dev-notes/SR_PHASE1_SPEC.md` §2 (design decisions
 * D1–D4, D9, D11) and §3.2 for the full design. This file implements that
 * section exactly.
 *
 * ONE parse path, reused verbatim, never re-derived:
 *   - `parseHopArray`/`hasRouteData`/`hasReturnPath` from `tracerouteSegments.ts`
 *     (the single home for traceroute JSON parsing).
 *   - `filterHops` from `tracerouteStrip.ts` (§3.3 hop-filter policy: endpoints
 *     never filtered, `BROADCAST_ADDR` kept and flagged `isUnknown`, other
 *     invalid hops dropped).
 *
 * ORIENTATION (D1). The history endpoint is bidirectional, so a row's
 * `fromNodeNum`/`toNodeNum` may be `(local, peer)` or `(peer, local)`, and a
 * row's return leg always runs the opposite way from its forward leg. Both
 * problems collapse into one rule: build each leg's hop sequence in its own
 * traversal order, then reverse it if `sequence[0] !== localNodeNum`. Every
 * leg starts and ends at the two endpoints (never filtered), so this always
 * yields a sequence that starts at `localNodeNum` and ends at `peerNodeNum`.
 *
 * IDENTITY (D4). A real node's identity is `n:<nodeNum>` regardless of hop
 * depth — two occurrences of the same physical node anywhere merge onto one
 * `StatNode`. An unknown (`BROADCAST_ADDR`) hop's identity is `u:<depth>`,
 * where `depth` is its index in the filtered, ORIENTED (local -> peer)
 * sequence — merging unknown hops by depth, not by never merging them or by
 * anchoring neighbours, is what keeps a large history's unknown-hop count
 * from fragmenting into one useless node per traceroute (see D4's rejected
 * alternatives).
 *
 * COUNTING (D3). A node counts once per INCLUDED ROW in which it appears in
 * any leg — not once per occurrence, so a loop or a node shared by both legs
 * of one row still counts once. An edge between A and B counts once per
 * included row in which they were adjacent in any leg, undirected (the
 * canonical key sorts the two node ids, so `A→B` and `B→A` are the same
 * edge). Self-adjacency (`sequence[k] === sequence[k+1]`) never emits an
 * edge — a self-loop has no renderable geometry in the strip.
 *
 * DETERMINISM (D11). One pass over rows; all running state lives in `Map`s
 * keyed by string id. Output arrays are sorted by `id` with a plain `<`/`>`
 * comparator (ids are unique, so the order is total); `depthSamples` is
 * sorted ascending before it leaves the module. The union graph is invariant
 * under permutation of the input rows: counts are sums, `depthSamples` is
 * sorted, and the output arrays are id-sorted — nothing carries row order.
 */

import { parseHopArray, hasRouteData, hasReturnPath } from './tracerouteSegments.js';
import { filterHops, type RawHop, type InternalLegHop } from './tracerouteStrip.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Real-node id prefix. A real node's identity is `n:<nodeNum>`, regardless
 *  of the hop depth(s) it was observed at (D4). */
export const REAL_NODE_ID_PREFIX = 'n';

/** Unknown-hop id prefix. `BROADCAST_ADDR` hops are keyed `u:<depth>`, where
 *  `depth` is the hop's index in the filtered, oriented (local -> peer)
 *  sequence — a scoped relaxation of the single-route strip's I6 (D4). */
export const UNKNOWN_HOP_ID_PREFIX = 'u';

/** Minimum rendered opacity for a node or edge, whatever its share (D9). One
 *  constant serves both nodes and edges so the two floors cannot drift apart. */
export const MIN_STAT_OPACITY = 0.28;

/** Baseline stroke-width (px) an edge with `share -> 0` renders at. Matches the
 *  non-statistical `.forwardEdge`/`.returnEdge` weight so a single-route union
 *  reads identical to the classic strip. */
export const MIN_STAT_EDGE_WEIGHT = 2;

/** Peak stroke-width (px) an edge with `share === 1` renders at. Kept modest
 *  so a highly-repeated edge stays legible next to node glyphs (glyphSize/2 is
 *  16px by default). */
export const MAX_STAT_EDGE_WEIGHT = 5;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Structural subset of a `/api/traceroutes/history/:from/:to` row. Matches
 *  `DbTraceroute` (src/db/types.ts:197) and `TracerouteParticipationEntry`
 *  (src/services/api.ts:48) in the fields it reads. */
export interface AggregateTracerouteRow {
  id?: number;
  fromNodeNum: number;
  toNodeNum: number;
  route?: string | null;
  routeBack?: string | null;
  snrBack?: string | null;
  timestamp?: number;
}

export interface StatNode {
  /** `n:<nodeNum>` or `u:<depth>`. Unique within one union graph. */
  id: string;
  /** BROADCAST_ADDR for an unknown hop. */
  nodeNum: number;
  isUnknown: boolean;
  /** The hop depth this identity is keyed on; null for real nodes (D4). */
  unknownDepth: number | null;
  isEndpoint: boolean;
  /** Included rows containing this node in any leg. Never per-occurrence (D3). */
  count: number;
  /** count / totalRoutes, in (0, 1]. */
  share: number;
  /** One entry per (row, leg, occurrence), sorted ascending. NOT `count` —
   *  this is the observation multiset the column algorithm medians (D5). */
  depthSamples: number[];
}

export interface StatEdge {
  /** `${aId}|${bId}` with aId < bId. */
  id: string;
  aId: string;
  bId: string;
  /** Included rows in which the two nodes were adjacent in any leg (D3). */
  count: number;
  share: number;
}

export interface TracerouteUnionGraph {
  localNodeNum: number;
  peerNodeNum: number;
  /** Included rows — the denominator of every share. */
  totalRoutes: number;
  /** Rows with no parseable leg at all (failed traceroutes). */
  excludedRoutes: number;
  /** Rows whose endpoint pair was not {local, peer}. Expected 0. */
  mismatchedRoutes: number;
  /** Sorted by `id` ascending. */
  nodes: StatNode[];
  /** Sorted by `id` ascending. */
  edges: StatEdge[];
  isEmpty: boolean;
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

/** One leg's hop sequence, already filtered and oriented local -> peer. */
interface OrientedLeg {
  ids: string[];
  nodeNums: number[];
  isUnknown: boolean[];
}

/** Mutable per-node running total, keyed by id. Flushed into `StatNode`s
 *  (with `share` computed and `depthSamples` sorted) once `totalRoutes` is
 *  final. */
interface NodeAgg {
  id: string;
  nodeNum: number;
  isUnknown: boolean;
  unknownDepth: number | null;
  isEndpoint: boolean;
  count: number;
  depthSamples: number[];
}

/** Mutable per-edge running total, keyed by the canonical `aId|bId`. */
interface EdgeAgg {
  id: string;
  aId: string;
  bId: string;
  count: number;
}

function idFor(hop: InternalLegHop, depth: number): string {
  return hop.isUnknown ? `${UNKNOWN_HOP_ID_PREFIX}:${depth}` : `${REAL_NODE_ID_PREFIX}:${hop.nodeNum}`;
}

/**
 * Build one leg's filtered, oriented hop sequence, or `null` when the leg is
 * absent for this row.
 *
 * `startNum`/`endNum` are the leg's own raw traversal endpoints (forward:
 * `row.fromNodeNum` -> `row.toNodeNum`; return: `row.toNodeNum` ->
 * `row.fromNodeNum`) — orientation is applied AFTER filtering, per D1, by
 * reversing the filtered sequence when it doesn't already start at
 * `localNodeNum`.
 */
function buildOrientedLeg(
  startNum: number,
  intermediates: number[],
  endNum: number,
  localNodeNum: number,
): OrientedLeg {
  const rawHops: RawHop[] = [
    { nodeNum: startNum },
    ...intermediates.map((nodeNum): RawHop => ({ nodeNum })),
    { nodeNum: endNum },
  ];
  let filtered = filterHops(rawHops);
  if (filtered.length > 0 && filtered[0].nodeNum !== localNodeNum) {
    filtered = [...filtered].reverse();
  }

  const ids: string[] = [];
  const nodeNums: number[] = [];
  const isUnknown: boolean[] = [];
  filtered.forEach((hop, depth) => {
    ids.push(idFor(hop, depth));
    nodeNums.push(hop.nodeNum);
    isUnknown.push(hop.isUnknown);
  });
  return { ids, nodeNums, isUnknown };
}

/**
 * Build 0, 1, or 2 oriented legs for one already-endpoint-matched row.
 * `localNodeNum`/`peerNodeNum` are the union's fixed pair; `row.fromNodeNum`/
 * `row.toNodeNum` may equal either order (D1).
 */
function orientedLegs(
  row: AggregateTracerouteRow,
  localNodeNum: number,
): { legs: OrientedLeg[]; included: boolean } {
  const hasForward = hasRouteData(row.route);
  const routeBack = parseHopArray(row.routeBack);
  const hasReturn = hasReturnPath(routeBack, row.snrBack);
  const included = hasForward || hasReturn;
  if (!included) return { legs: [], included: false };

  const legs: OrientedLeg[] = [];
  if (hasForward) {
    const route = parseHopArray(row.route);
    legs.push(buildOrientedLeg(row.fromNodeNum, route, row.toNodeNum, localNodeNum));
  }
  if (hasReturn) {
    legs.push(buildOrientedLeg(row.toNodeNum, routeBack, row.fromNodeNum, localNodeNum));
  }
  return { legs, included: true };
}

/**
 * Fold one leg's oriented sequence into the row-scoped node/edge id sets
 * (D3's per-row dedup) and push every occurrence's depth onto the running
 * `NodeAgg.depthSamples` (D5's observation multiset — NOT deduped per row).
 */
function foldLeg(
  leg: OrientedLeg,
  localNodeNum: number,
  peerNodeNum: number,
  nodeAgg: Map<string, NodeAgg>,
  rowNodeIds: Set<string>,
  rowEdgeKeys: Map<string, { aId: string; bId: string }>,
): void {
  for (let depth = 0; depth < leg.ids.length; depth++) {
    const id = leg.ids[depth];
    const nodeNum = leg.nodeNums[depth];
    const isUnknown = leg.isUnknown[depth];
    rowNodeIds.add(id);

    let agg = nodeAgg.get(id);
    if (!agg) {
      agg = {
        id,
        nodeNum,
        isUnknown,
        unknownDepth: isUnknown ? depth : null,
        isEndpoint: !isUnknown && (nodeNum === localNodeNum || nodeNum === peerNodeNum),
        count: 0,
        depthSamples: [],
      };
      nodeAgg.set(id, agg);
    }
    agg.depthSamples.push(depth);
  }

  for (let k = 1; k < leg.ids.length; k++) {
    const a = leg.ids[k - 1];
    const b = leg.ids[k];
    if (a === b) continue; // self-adjacency: no renderable geometry (D3).
    const aId = a < b ? a : b;
    const bId = a < b ? b : a;
    rowEdgeKeys.set(`${aId}|${bId}`, { aId, bId });
  }
}

function compareById(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the statistical union graph for every traceroute row between
 * `localNodeNum` and `peerNodeNum`. See the module banner for the counting,
 * identity, orientation, and determinism rules; see §3.2 of the spec for the
 * per-row algorithm this implements verbatim.
 */
export function buildTracerouteUnion(
  rows: readonly AggregateTracerouteRow[],
  localNodeNum: number,
  peerNodeNum: number,
): TracerouteUnionGraph {
  if (localNodeNum === peerNodeNum) {
    // A self-pair has no two-endpoint axis to lay out (D1).
    return {
      localNodeNum,
      peerNodeNum,
      totalRoutes: 0,
      excludedRoutes: 0,
      mismatchedRoutes: 0,
      nodes: [],
      edges: [],
      isEmpty: true,
    };
  }

  const nodeAgg = new Map<string, NodeAgg>();
  const edgeAgg = new Map<string, EdgeAgg>();
  let totalRoutes = 0;
  let excludedRoutes = 0;
  let mismatchedRoutes = 0;

  for (const row of rows) {
    const isForwardOrient = row.fromNodeNum === localNodeNum && row.toNodeNum === peerNodeNum;
    const isReverseOrient = row.fromNodeNum === peerNodeNum && row.toNodeNum === localNodeNum;
    if (!isForwardOrient && !isReverseOrient) {
      mismatchedRoutes++;
      continue;
    }

    const { legs, included } = orientedLegs(row, localNodeNum);
    if (!included) {
      excludedRoutes++;
      continue;
    }

    totalRoutes++;
    const rowNodeIds = new Set<string>();
    const rowEdgeKeys = new Map<string, { aId: string; bId: string }>();
    for (const leg of legs) {
      foldLeg(leg, localNodeNum, peerNodeNum, nodeAgg, rowNodeIds, rowEdgeKeys);
    }

    for (const id of rowNodeIds) {
      nodeAgg.get(id)!.count++;
    }
    for (const { aId, bId } of rowEdgeKeys.values()) {
      const key = `${aId}|${bId}`;
      let agg = edgeAgg.get(key);
      if (!agg) {
        agg = { id: key, aId, bId, count: 0 };
        edgeAgg.set(key, agg);
      }
      agg.count++;
    }
  }

  const nodes: StatNode[] = Array.from(nodeAgg.values())
    .map((agg): StatNode => ({
      id: agg.id,
      nodeNum: agg.nodeNum,
      isUnknown: agg.isUnknown,
      unknownDepth: agg.unknownDepth,
      isEndpoint: agg.isEndpoint,
      count: agg.count,
      share: totalRoutes > 0 ? agg.count / totalRoutes : 0,
      depthSamples: [...agg.depthSamples].sort((a, b) => a - b),
    }))
    .sort(compareById);

  const edges: StatEdge[] = Array.from(edgeAgg.values())
    .map((agg): StatEdge => ({
      id: agg.id,
      aId: agg.aId,
      bId: agg.bId,
      count: agg.count,
      share: totalRoutes > 0 ? agg.count / totalRoutes : 0,
    }))
    .sort(compareById);

  return {
    localNodeNum,
    peerNodeNum,
    totalRoutes,
    excludedRoutes,
    mismatchedRoutes,
    nodes,
    edges,
    isEmpty: totalRoutes === 0,
  };
}

/** `round3(x) = Math.round(x * 1000) / 1000` — keeps float noise out of
 *  deep-equality assertions (D9). */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Linear ramp from `MIN_STAT_OPACITY` at `share -> 0` to `1` at `share = 1`,
 * rounded to three decimals. Clamps out-of-range input (D9).
 */
export function statOpacity(share: number): number {
  const clamped = Math.min(1, Math.max(0, share));
  return round3(MIN_STAT_OPACITY + (1 - MIN_STAT_OPACITY) * clamped);
}

/**
 * Linear ramp from `MIN_STAT_EDGE_WEIGHT` at `share -> 0` to `MAX_STAT_EDGE_WEIGHT`
 * at `share === 1`, rounded to two decimals. Clamps out-of-range input.
 *
 * This is what tells the reader "this A-B adjacency showed up in most of the
 * routes I stored" — a merged StatEdge with share=1 renders as the thickest
 * stroke, share≈1/N as the thinnest. Kept in this module (not the layout
 * module) so the counting model owns every scalar mapping off `share`.
 */
export function statEdgeWeight(share: number): number {
  const clamped = Math.min(1, Math.max(0, share));
  return round2(MIN_STAT_EDGE_WEIGHT + (MAX_STAT_EDGE_WEIGHT - MIN_STAT_EDGE_WEIGHT) * clamped);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
