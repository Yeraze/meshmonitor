/**
 * Traceroute Visual Strip — pure graph + layout util (issue #4381 WP2; spine
 * model rewrite WP-A/WP-B, addendum A of the spec).
 *
 * Pure, React-free, Leaflet-free, `DeviceInfo`-free — safe to import from a
 * node-environment test or from any presentation layer. This module owns the
 * one graph shape the strip renders: a deduplicated, single-column-axis DAG
 * built from a traceroute's forward + return legs, plus a fixed
 * (non-DOM-measured) pixel layout for it.
 *
 * See `docs/internal/dev-notes/TRACEROUTE_VISUAL_STRIP_SPEC.md` §3 for the
 * full design. This file implements that section exactly.
 *
 * ONE parse path: `parseHopArray`/`hasRouteData`/`hasReturnPath`/
 * `isValidRouteNode`/`isUnknownSnr`/`BROADCAST_ADDR` are all re-used from
 * `tracerouteSegments.ts` (the single home for traceroute JSON parsing and
 * hop-validity rules). This module adds no second parser.
 *
 * SNR pairing rule (copied verbatim from `buildLegSegments`): every raw hop,
 * including both leg endpoints, is paired with its own arrival SNR sample
 * BEFORE any filtering. `rawSnr[k]` is the SNR observed arriving AT the hop
 * at position `k`; it is always `undefined` at `k === 0` (nothing "arrives"
 * at the leg's own start). Filtering removes reserved/invalid intermediate
 * hops (and BROADCAST_ADDR, which is instead kept and flagged `isUnknown`)
 * and discards a dropped hop's paired SNR sample along with it, WITHOUT
 * re-indexing the survivors' samples — that index stability is what makes
 * the surviving edges carry correct SNR after hops are removed.
 *
 * THE SPINE MODEL (§3.4 of the spec, replacing the old "primary leg on row 0"
 * design after a live-mesh mis-rendering, #4392 follow-up). The middle band is
 * the SPINE: exactly the nodes present in BOTH legs (first-occurrence-wins
 * per nodeNum, walking the forward leg's own order). Forward-leg-exclusive
 * nodes are raised ABOVE the spine (`lane: 'forward'`); return-leg-exclusive
 * nodes are dropped BELOW it (`lane: 'return'`). A fully symmetric traceroute
 * — an all-shared spine — still renders as one flat row. `BROADCAST_ADDR`
 * hops are excluded from spine construction and can never be spine nodes
 * (see the comment on `buildTwoLegGraph` below); two independent unknown hops
 * in the two legs must never dedup onto one shared node.
 *
 * `row` is a DENSE, non-negative index over whichever of the three lanes
 * (`forward`, `spine`, `return`, in that top-to-bottom order) actually have
 * at least one node — an unoccupied lane costs no vertical space, which is
 * what keeps a symmetric traceroute a single flat row. `StripNode.id` is
 * keyed on `lane`, not `row`, because `row` is derived/dense and would
 * otherwise make ids unstable as lane occupancy changes; `layout.centers`
 * keys off `id`, so that stability matters.
 *
 * This module is also the geometry and hop-filter home for the statistical
 * union layout (Statistical Route epic, Phase 1): several internals below
 * are exported `@internal` for `tracerouteUnionLayout.ts` /
 * `tracerouteAggregate.ts` to reuse verbatim, so the two layouts cannot
 * drift apart on shared arithmetic.
 */

import {
  parseHopArray,
  hasRouteData,
  hasReturnPath,
  isValidRouteNode,
  isUnknownSnr,
  BROADCAST_ADDR,
} from './tracerouteSegments.js';

export { BROADCAST_ADDR };

/** "!a1b2c3d4" fallback node id, padded to 8 hex digits. Shared by
 *  `TracerouteStrip.tsx` (unknown/missing-meta placeholder) and
 *  `tracerouteStripMeta.ts` (its own node-id/short-name fallback) — this
 *  module is the neutral common dependency of both, so it lives here rather
 *  than in either consumer (avoids a cycle: `tracerouteStripMeta.ts` already
 *  imports a type from `TracerouteStrip.tsx`). */
export function paddedHexId(nodeNum: number): string {
  return `!${nodeNum.toString(16).padStart(8, '0')}`;
}

/** Which leg of the traceroute an edge belongs to. */
export type StripLeg = 'forward' | 'return';

/** Which of the three horizontal bands a node sits in.
 *  'spine'   = present in BOTH legs (the true overlap), or the only leg when
 *              just one leg exists.
 *  'forward' = forward-leg-exclusive; raised ABOVE the spine.
 *  'return'  = return-leg-exclusive; dropped BELOW the spine. */
export type StripLane = 'forward' | 'spine' | 'return';

export interface StripNode {
  /** Stable, unique within one graph: `${lane}-${col}-${nodeNum}`.
   *  Keyed on `lane`, NOT `row`, on purpose — `row` is a dense index that
   *  shifts when a lane becomes occupied/unoccupied, and `layout.centers`
   *  keys off `id`. Assigned only after placement is fully finalized. */
  id: string;
  nodeNum: number;
  /** Semantic band. The source of truth for "which leg(s) is this in". */
  lane: StripLane;
  /** DENSE top-to-bottom visual row index: 0 = topmost OCCUPIED lane.
   *  Derived from `lane` + which lanes the graph actually populates, so an
   *  unused lane costs no vertical space. `layoutTracerouteStrip` keys its
   *  geometry off `row`; `lane` is for semantics, tests, and renderer class
   *  hooks. */
  row: number;
  /** 0-based column index; the SAME column axis is shared by all lanes. */
  col: number;
  /** Legs this node participates in. Length 2 => it is the shared overlap. */
  legs: StripLeg[];
  /** Convenience: `legs.length === 2`. In a two-leg graph this is exactly
   *  `lane === 'spine'`. In a SINGLE-leg graph every node is on the spine
   *  lane but `shared` is false — only one leg exists to be shared with. */
  shared: boolean;
  /** True for BROADCAST_ADDR — render the neutral "Unknown" placeholder. */
  isUnknown: boolean;
}

export interface StripEdge {
  /** `${leg}:${fromId}>${toId}` — unique even when a path loops. */
  id: string;
  leg: StripLeg;
  /** StripNode.id, not nodeNum (a node can appear twice within one leg). */
  fromId: string;
  toId: string;
  /** Scaled dB (raw / 4). null when absent OR when it is the unknown sentinel. */
  snr: number | null;
  /** True when the raw sample was the INT8_MIN unknown-hop sentinel (#2931). */
  snrUnknown: boolean;
}

export interface TracerouteStripGraph {
  /** Ordered by (`row` asc, `col` asc): the topmost occupied lane left→right,
   *  then the next, then the next. */
  nodes: StripNode[];
  /** Forward edges first (source order), then return edges (source order). */
  edges: StripEdge[];
  /** Column count; `max(col) + 1`, or 0 when empty. */
  columns: number;
  /** A forward leg was present in the source data. */
  hasForward: boolean;
  /** A return leg was present AND passed `hasReturnPath`. */
  hasReturn: boolean;
  /** True when neither leg produced anything drawable. */
  isEmpty: boolean;
}

/** Structural subset of the row — mirrors `TracerouteDecomposeInput`. */
export interface TracerouteStripInput {
  fromNodeNum: number;
  toNodeNum: number;
  route?: string | null;
  routeBack?: string | null;
  snrTowards?: string | null;
  snrBack?: string | null;
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

/** One post-filter hop: a real node number to render, paired with its own
 *  arrival SNR sample (raw, dB x4; undefined = no sample) and whether it is
 *  the BROADCAST_ADDR placeholder.
 *  @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts. */
export interface InternalLegHop {
  nodeNum: number;
  snr: number | undefined;
  isUnknown: boolean;
}

interface InternalLegInput {
  leg: StripLeg;
  /** Ordered, already filtered per §3.3. Endpoints included. */
  hops: InternalLegHop[];
}

/** One raw hop, paired with its arrival SNR, before validity filtering.
 *  `snr` widened to optional so `tracerouteAggregate.ts` can pass
 *  `{ nodeNum }` without a meaningless `snr: undefined`.
 *  @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts. */
export interface RawHop {
  nodeNum: number;
  snr?: number;
}

/**
 * Apply the §3.3 hop filter to one leg's raw (pre-filter) hop list.
 * Index 0 and the last index are endpoints (`fromNodeNum`/`toNodeNum`) and
 * are never filtered, even if they happen to be invalid/reserved values —
 * they are real device node numbers, not raw route placeholders.
 * @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts.
 */
export function filterHops(hops: RawHop[]): InternalLegHop[] {
  const result: InternalLegHop[] = [];
  const lastIndex = hops.length - 1;
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i];
    const isEndpoint = i === 0 || i === lastIndex;
    if (isEndpoint) {
      result.push({ nodeNum: h.nodeNum, snr: h.snr, isUnknown: false });
      continue;
    }
    if (h.nodeNum === BROADCAST_ADDR) {
      // Deliberate deviation from isValidRouteNode (see module banner / spec
      // §3.3): keep it, flag isUnknown, so the strip shows "a hop happened
      // here" rather than silently shortening the path.
      result.push({ nodeNum: h.nodeNum, snr: h.snr, isUnknown: true });
    } else if (isValidRouteNode(h.nodeNum)) {
      result.push({ nodeNum: h.nodeNum, snr: h.snr, isUnknown: false });
    }
    // else: dropped, taking its paired snr with it — never re-index.
  }
  return result;
}

function buildForwardRawHops(input: TracerouteStripInput): RawHop[] {
  const route = parseHopArray(input.route);
  const snrTowards = parseHopArray(input.snrTowards);
  return [
    { nodeNum: input.fromNodeNum, snr: undefined },
    ...route.map((nodeNum, i): RawHop => ({
      nodeNum,
      snr: i < snrTowards.length ? snrTowards[i] : undefined,
    })),
    {
      nodeNum: input.toNodeNum,
      snr: route.length < snrTowards.length ? snrTowards[route.length] : undefined,
    },
  ];
}

function buildReturnRawHops(input: TracerouteStripInput, routeBack: number[]): RawHop[] {
  const snrBack = parseHopArray(input.snrBack);
  return [
    { nodeNum: input.toNodeNum, snr: undefined },
    ...routeBack.map((nodeNum, i): RawHop => ({
      nodeNum,
      snr: i < snrBack.length ? snrBack[i] : undefined,
    })),
    {
      nodeNum: input.fromNodeNum,
      snr: routeBack.length < snrBack.length ? snrBack[routeBack.length] : undefined,
    },
  ];
}

// ---------------------------------------------------------------------------
// Step 3-5: spine/lane placement, dedup, divergence, edges — the core that
// operates on already-parsed-and-filtered legs. Exported (in addition to the
// public `buildTracerouteStripGraph` JSON entry point below) purely for
// testability: the "legs share no node at all" shape (§3.4.8 "empty spine")
// is structurally unreachable through the public JSON-parsing entry point —
// forward and return legs generated from one TracerouteStripInput always
// share both fromNodeNum and toNodeNum — so the spec calls for a test with
// hand-built disjoint leg data (§3.7 case 21). This does no JSON parsing.
// ---------------------------------------------------------------------------

/** Loosened input shape for {@link buildStripGraphFromLegs} test callers —
 *  `snr`/`isUnknown` default to `undefined`/`false`. */
export interface StripLegHopInput {
  nodeNum: number;
  snr?: number;
  isUnknown?: boolean;
}

export interface StripLegInput {
  leg: StripLeg;
  hops: StripLegHopInput[];
}

function normalizeLegInput(input: StripLegInput): InternalLegInput {
  return {
    leg: input.leg,
    hops: input.hops.map((h) => ({
      nodeNum: h.nodeNum,
      snr: h.snr,
      isUnknown: h.isUnknown ?? false,
    })),
  };
}

/**
 * Core graph builder — operates on already-filtered leg hop lists.
 * `buildTracerouteStripGraph` is a thin JSON-parsing wrapper around this.
 *
 * @internal exported for the §3.7 case-21 test (hand-built disjoint legs);
 * not part of the documented public API surface.
 */
export function buildStripGraphFromLegs(
  primaryInput: StripLegInput,
  secondaryInput?: StripLegInput,
): TracerouteStripGraph {
  const primary = normalizeLegInput(primaryInput);
  const secondary = secondaryInput ? normalizeLegInput(secondaryInput) : undefined;

  const forward = primary.leg === 'forward' ? primary : secondary?.leg === 'forward' ? secondary : undefined;
  const ret = primary.leg === 'return' ? primary : secondary?.leg === 'return' ? secondary : undefined;

  const graph = buildGraphCore(forward, ret);
  return {
    ...graph,
    hasForward: !!forward,
    hasReturn: !!ret,
    isEmpty: false,
  };
}

/** Build the edges for one leg from its finalized StripNode sequence — one
 *  element per filtered hop (§3.4's 1:1 correspondence), so `hops[k]`'s SNR
 *  sample still lines up with `sequence[k]` regardless of lane placement. */
function buildLegEdges(leg: StripLeg, sequence: StripNode[], hops: InternalLegHop[]): StripEdge[] {
  const edges: StripEdge[] = [];
  for (let k = 1; k < sequence.length; k++) {
    const raw = hops[k]?.snr;
    const scaled = raw === undefined ? undefined : raw / 4;
    const snrUnknown = scaled !== undefined && isUnknownSnr(scaled);
    const snr = scaled === undefined || snrUnknown ? null : scaled;
    const from = sequence[k - 1];
    const to = sequence[k];
    edges.push({
      id: `${leg}:${from.id}>${to.id}`,
      leg,
      fromId: from.id,
      toId: to.id,
      snr,
      snrUnknown,
    });
  }
  return edges;
}

/** §3.4.8 single-leg case: "that leg IS the spine" — every hop becomes a
 *  `lane: 'spine'` node at its own ordinal column, one row, no anchor map,
 *  no run machinery. Byte-for-byte today's (pre-spine-model) single-leg
 *  behavior, including a loop within the leg getting its own spine column
 *  per occurrence (a loop only becomes a *branch* once a second leg exists
 *  to define a spine to branch off of). */
function buildSingleLegGraph(leg: InternalLegInput): Pick<TracerouteStripGraph, 'nodes' | 'edges' | 'columns'> {
  const nodes: StripNode[] = leg.hops.map((hop, i) => ({
    id: '',
    nodeNum: hop.nodeNum,
    lane: 'spine',
    row: 0,
    col: i,
    legs: [leg.leg],
    shared: false,
    isUnknown: hop.isUnknown,
  }));
  for (const n of nodes) n.id = `${n.lane}-${n.col}-${n.nodeNum}`;
  const columns = nodes.reduce((m, n) => Math.max(m, n.col), -1) + 1;
  const edges = buildLegEdges(leg.leg, nodes, leg.hops);
  return { nodes, edges, columns };
}

/**
 * §3.4.1–§3.4.8 two-leg spine builder. Both legs are present.
 *
 * Step 1 (§3.4.3): the spine is exactly the nodes shared by both legs,
 * walked in the FORWARD leg's own order (first-occurrence-wins per
 * nodeNum) — §3.4.2's orientation rule: the spine's left-to-right order is
 * the forward leg's traversal order, and the return leg travels right to
 * left across the same axis.
 *
 * UNKNOWN HOPS CAN NEVER BE SPINE NODES (I6, load-bearing — see spec §3.3 /
 * §1.4 and case 22/27). `BROADCAST_ADDR` is not a node identity; it is the
 * firmware's "a hop happened here and nobody recorded who" placeholder
 * (`TraceRouteModule::insertUnknownHops()`), independently backfilled on
 * each leg. Two independent unknowns must never dedup onto one shared
 * StripNode — that would draw a shared node that does not exist. Both the
 * `sharedNums` set below and the per-leg walk exclude `isUnknown` hops from
 * ever resolving to (or becoming) a spine anchor.
 *
 * Step 2 (§3.4.4/§3.4.5): each leg is then walked, forward first (order
 * fixed here purely for column-packing determinism), against the spine.
 * Each hop either lands on its shared spine node (first-occurrence-wins
 * PER LEG — a later revisit of an already-anchored node within the SAME
 * leg, e.g. a loop, is treated as unanchored and gets its own branch node)
 * or accumulates into a maximal run that gets placed on that leg's own lane
 * once the run's bounding anchors (if any) are known.
 */
function buildTwoLegGraph(
  forward: InternalLegInput,
  ret: InternalLegInput,
): Pick<TracerouteStripGraph, 'nodes' | 'edges' | 'columns'> {
  // --- Step 1: spine construction (§3.4.3) ---
  const returnNums = new Set(ret.hops.filter((h) => !h.isUnknown).map((h) => h.nodeNum));

  const allNodes: StripNode[] = [];
  const spineAnchor = new Map<number, StripNode>();

  for (const hop of forward.hops) {
    if (hop.isUnknown) continue; // I6: never a spine candidate.
    if (!returnNums.has(hop.nodeNum)) continue; // forward-exclusive; not spine.
    if (spineAnchor.has(hop.nodeNum)) continue; // first-occurrence-wins.
    const node: StripNode = {
      id: '',
      nodeNum: hop.nodeNum,
      lane: 'spine',
      row: 0, // placeholder; assigned below once lane occupancy is known
      col: spineAnchor.size,
      legs: ['forward', 'return'],
      shared: true,
      isUnknown: false,
    };
    allNodes.push(node);
    spineAnchor.set(hop.nodeNum, node);
  }

  // --- Column-placement machinery, shared by both legs' runs (§3.4.5) ---

  /** Mutates every already-placed node's column: `col > after` shifts by
   *  `+count`. `after = -1` is valid (shifts everything). The column axis
   *  is shared across all three lanes, so this touches every lane. */
  const insertColumns = (after: number, count: number): void => {
    for (const n of allNodes) if (n.col > after) n.col += count;
  };
  const maxCol = (): number => allNodes.reduce((m, n) => Math.max(m, n.col), -1);
  /** Occupancy is checked PER LANE (§3.4.5's `freeCols` refinement): a
   *  forward-lane node and a return-lane node may legitimately share a
   *  column (different rows), but two nodes of the SAME lane never may —
   *  that would collide their ids (`${lane}-${col}-${nodeNum}`). */
  const occupiedCols = (lane: StripLane): Set<number> =>
    new Set(allNodes.filter((n) => n.lane === lane).map((n) => n.col));
  const freeCols = (lane: StripLane, lo: number, hi: number): number[] => {
    const occ = occupiedCols(lane);
    const out: number[] = [];
    for (let c = lo + 1; c < hi; c++) if (!occ.has(c)) out.push(c);
    return out;
  };

  /**
   * Walk one leg against the spine (§3.4.4), placing its branch nodes on
   * `lane` as runs are flushed against their bounding spine anchors
   * (§3.4.5). Returns the leg's own StripNode sequence — spine nodes and
   * this leg's branch nodes only (never the other leg's lane, invariant
   * I1) — 1:1 with `leg.hops` for SNR pairing.
   */
  const walkLeg = (leg: InternalLegInput, lane: 'forward' | 'return'): StripNode[] => {
    const sequence: StripNode[] = [];
    const usedThisLeg = new Set<number>();
    let prevAnchor: StripNode | undefined;
    let pendingRun: InternalLegHop[] = [];

    const makeBranchNode = (hop: InternalLegHop, col: number): StripNode => ({
      id: '',
      nodeNum: hop.nodeNum,
      lane,
      row: 0,
      col,
      legs: [leg.leg],
      shared: false,
      isUnknown: hop.isUnknown,
    });

    const flushRun = (nextAnchor: StripNode | undefined): void => {
      const k = pendingRun.length;
      if (k === 0) return;
      let placed: StripNode[];

      if (prevAnchor && nextAnchor) {
        // Both anchors defined.
        const a = prevAnchor.col;
        const b = nextAnchor.col;
        const lo = Math.min(a, b);
        let hi = Math.max(a, b);
        let free = freeCols(lane, lo, hi);
        if (free.length < k) {
          const deficit = k - free.length;
          // `lo` is stable across this call: insertColumns only shifts
          // columns strictly greater than `after`, and `after === lo`.
          insertColumns(lo, deficit);
          hi = Math.max(prevAnchor.col, nextAnchor.col); // re-read: one of them just shifted
          free = freeCols(lane, lo, hi);
        }
        const target = free.slice(0, k);
        // `order`/`target` determine which COLUMN each hop gets (reversed
        // when the run is walked right-to-left), but `placed` — and hence
        // `sequence` — must stay in the leg's own hop-encounter order: the
        // hop<->sequence 1:1 correspondence (§3.4's SNR pairing, and correct
        // edge topology) depends on it, independent of fill direction. Map
        // hop -> column via the (possibly reversed) `order`, then re-walk
        // `pendingRun` in its original order to build `placed`.
        const order = b < a ? [...pendingRun].reverse() : pendingRun;
        const colForHop = new Map<InternalLegHop, number>();
        order.forEach((hop, idx) => colForHop.set(hop, target[idx]));
        placed = pendingRun.map((hop) => makeBranchNode(hop, colForHop.get(hop)!));
      } else if (!prevAnchor && nextAnchor) {
        // Only `b` defined — run leads the leg (structurally unreachable for
        // real traceroute data, since a leg's own first hop is always one of
        // the two shared endpoints; kept for completeness per spec §3.4.5).
        const bBefore = nextAnchor.col;
        insertColumns(bBefore - 1, k);
        const b = nextAnchor.col; // re-read: insertColumns just shifted it
        placed = pendingRun.map((hop, idx) => makeBranchNode(hop, b - k + idx));
      } else if (prevAnchor && !nextAnchor) {
        // Only `a` defined — run trails the leg.
        const base = maxCol();
        placed = pendingRun.map((hop, idx) => makeBranchNode(hop, base + 1 + idx));
      } else {
        // Neither defined — the two legs share no node at all (§3.4.8 empty
        // spine). Real forward/return legs always share both endpoints, so
        // this only happens with hand-built disjoint input (§3.7 case 21).
        // Place the whole run in lane `lane` starting at column 0, in source
        // order, rather than throwing.
        placed = pendingRun.map((hop, idx) => makeBranchNode(hop, idx));
      }

      for (const n of placed) allNodes.push(n);
      sequence.push(...placed);
      pendingRun = [];
    };

    for (const hop of leg.hops) {
      // An unknown (BROADCAST_ADDR) hop must never resolve to an existing
      // spine anchor (I6), and a nodeNum this leg has already anchored once
      // (a loop) is treated as unanchored on its later occurrences —
      // first-occurrence-wins PER LEG, which keeps this leg's own column
      // sequence monotone even when the physical route doubles back.
      const anchor = hop.isUnknown || usedThisLeg.has(hop.nodeNum) ? undefined : spineAnchor.get(hop.nodeNum);
      if (anchor) {
        flushRun(anchor);
        usedThisLeg.add(hop.nodeNum);
        sequence.push(anchor);
        prevAnchor = anchor;
      } else {
        pendingRun.push(hop);
      }
    }
    flushRun(undefined);
    return sequence;
  };

  // Forward first, then return — order matters only for column-packing
  // determinism (spec §3.4.4).
  const forwardSequence = walkLeg(forward, 'forward');
  const returnSequence = walkLeg(ret, 'return');

  // --- §3.4.6: lane occupancy -> the dense `row` index ---
  const laneOrder: StripLane[] = ['forward', 'spine', 'return'];
  const occupiedLanes = laneOrder.filter((lane) => allNodes.some((n) => n.lane === lane));
  const rowOfLane = new Map<StripLane, number>(occupiedLanes.map((lane, idx) => [lane, idx]));
  for (const n of allNodes) n.row = rowOfLane.get(n.lane)!;

  // --- Finalize: sort by (row, col), assign ids ---
  allNodes.sort((x, y) => x.row - y.row || x.col - y.col);
  for (const n of allNodes) n.id = `${n.lane}-${n.col}-${n.nodeNum}`;
  const columns = allNodes.reduce((m, n) => Math.max(m, n.col), -1) + 1;

  // --- Step 4/5: edges. Built after ids are finalized (edge ids embed
  // StripNode.id). ---
  const forwardEdges = buildLegEdges('forward', forwardSequence, forward.hops);
  const returnEdges = buildLegEdges('return', returnSequence, ret.hops);

  return {
    nodes: allNodes,
    edges: [...forwardEdges, ...returnEdges],
    columns,
  };
}

function buildGraphCore(
  forward: InternalLegInput | undefined,
  ret: InternalLegInput | undefined,
): Pick<TracerouteStripGraph, 'nodes' | 'edges' | 'columns'> {
  if (forward && ret) return buildTwoLegGraph(forward, ret);
  const only = forward ?? ret;
  if (!only) return { nodes: [], edges: [], columns: 0 };
  return buildSingleLegGraph(only);
}

// ---------------------------------------------------------------------------
// Public entry point: parse + filter a traceroute row's route/SNR JSON, then
// delegate to the core builder above.
// ---------------------------------------------------------------------------

export function buildTracerouteStripGraph(input: TracerouteStripInput): TracerouteStripGraph {
  const forwardHops = hasRouteData(input.route) ? filterHops(buildForwardRawHops(input)) : null;

  const routeBack = parseHopArray(input.routeBack);
  const returnPresent = hasReturnPath(routeBack, input.snrBack);
  const returnHops = returnPresent ? filterHops(buildReturnRawHops(input, routeBack)) : null;

  const hasForward = forwardHops !== null;
  const hasReturn = returnHops !== null;

  if (!hasForward && !hasReturn) {
    return { nodes: [], edges: [], columns: 0, hasForward: false, hasReturn: false, isEmpty: true };
  }

  const forward: InternalLegInput | undefined = hasForward ? { leg: 'forward', hops: forwardHops! } : undefined;
  const ret: InternalLegInput | undefined = hasReturn ? { leg: 'return', hops: returnHops! } : undefined;

  const core = buildGraphCore(forward, ret);

  return { ...core, hasForward, hasReturn, isEmpty: false };
}

// ---------------------------------------------------------------------------
// Step 6 (§3.6): pure pixel layout — fixed arithmetic, no DOM measurement.
// ---------------------------------------------------------------------------

export interface StripLayoutOptions {
  /** Column pitch in px. */
  colWidth: number;
  /** Vertical pitch between adjacent OCCUPIED rows, px.
   *  Floored at `2 * labelOffset(o)` — see §3.5.2 C3 / `minRowHeight()`. */
  rowHeight: number;
  /** Glyph edge length in px. */
  glyphSize: number;
  /** Height reserved for the short-name line rendered below each glyph, px.
   *  Needed because the DOM centers the glyph AND the short name TOGETHER on
   *  a node's `center` point (one flex column via `transform: translate(-50%,
   *  -50%)`) — a node's real on-screen footprint is `glyphSize + gap +
   *  nameHeight` tall, not just `glyphSize`. See `labelOffset()` below: this
   *  is what an SNR label must clear on both sides (#4381 follow-up — the
   *  original fixed +/-14px offset put labels inside the glyph/name because
   *  it only ever accounted for `glyphSize`). */
  nameHeight: number;
  /** Height reserved above the TOPMOST occupied row for its SNR lane +
   *  tooltips, px. Floored at `minBand()`. */
  topBand: number;
  /** Height reserved below the BOTTOMMOST occupied row, px. Floored likewise. */
  bottomBand: number;
}

/** @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts. */
export const DEFAULT_LAYOUT_OPTIONS: StripLayoutOptions = {
  colWidth: 64,
  rowHeight: 76, // was 56 before the spine model — see §3.5.2 C3.
  glyphSize: 32,
  nameHeight: 14,
  topBand: 44,
  bottomBand: 44,
};

export interface StripPoint {
  x: number;
  y: number;
}

export interface StripLayout {
  width: number;
  height: number;
  /** StripNode.id -> glyph CENTER, in the container's coordinate space. */
  centers: Map<string, StripPoint>;
  /** Per-edge polyline through 2+ points, already offset off the glyph
   *  edges so the arrowhead lands on the rim, not under the icon, and
   *  translated into its leg's lane. Base shape is 2 points (same-row) or 3
   *  (row-crossing dog-leg); extra bend points appear where the path had to
   *  route around an unrelated node's glyph (#4428). */
  edgePaths: Map<string, StripPoint[]>;
  /** Where each edge's SNR label anchors (§3.5.1). */
  labelAnchors: Map<string, StripPoint>;
}

/** @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts. */
export function pullToward(from: StripPoint, to: StripPoint, dist: number): StripPoint {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: from.x + (dx / d) * dist, y: from.y + (dy / d) * dist };
}

// ---------------------------------------------------------------------------
// SNR-label collision avoidance (#4381 follow-up, caught in live deployment —
// no unit test can see real DOM layout, so this shipped once with a flat
// +/-14px offset that only accounted for `glyphSize`. `.node`'s CSS centers
// the glyph AND the short name together as one flex column via `transform:
// translate(-50%, -50%)` on `centers.get(node.id)`, so a node's real
// on-screen footprint extends `nodeHalfHeight()` on EITHER side of that
// point — through the glyph above, through the short name below — not just
// `glyphSize / 2`. Getting this wrong put the forward label inside the glyph
// and the return label on top of the short name text.
// ---------------------------------------------------------------------------

/** Mirrors the `gap: 2px` in TracerouteStrip.module.css's `.node` rule —
 *  duplicated here for the same reason `pullIn`'s `+3` below duplicates glyph
 *  geometry: this module has no access to the CSS it's laid out for. */
const NODE_NAME_GAP = 2;
/** Half the rendered height of a single-line SNR label (~0.7rem/0.6rem text)
 *  plus a fixed breathing-room margin between the label's edge and the
 *  node's edge. jsdom can't measure real font metrics, so these are
 *  deliberately generous — a few unused px beats a real overlap. */
const LABEL_HALF_HEIGHT = 8;
const LABEL_CLEARANCE = 4;

/** Half of a node's total on-screen height: glyph + gap + short name. */
function nodeHalfHeight(o: StripLayoutOptions): number {
  return (o.glyphSize + NODE_NAME_GAP + o.nameHeight) / 2;
}

/** Distance from a node's center to an SNR label's center (above OR below —
 *  symmetric, since the glyph above and the short name below both sit
 *  `nodeHalfHeight` from center), guaranteeing the label's far edge clears
 *  the node's near edge by at least `LABEL_CLEARANCE`. */
/** @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts. */
export function labelOffset(o: StripLayoutOptions): number {
  return nodeHalfHeight(o) + LABEL_HALF_HEIGHT + LABEL_CLEARANCE;
}

/** Minimum topBand/bottomBand that keeps a label's OWN far edge inside the
 *  canvas once it sits `labelOffset` away from the outermost row's center.
 *  @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts. */
export function minBand(o: StripLayoutOptions): number {
  return labelOffset(o) + LABEL_HALF_HEIGHT;
}

/** Minimum rowHeight (§3.5.2 C3): a same-row label sits `labelOffset` off
 *  its own row's center and must still clear the ADJACENT row by the same
 *  margin (`rowHeight - labelOffset >= labelOffset`); a crossing edge's
 *  label sits at the gap midpoint, `rowHeight / 2` from each endpoint row,
 *  which needs the same floor. Below this floor a forward label on the
 *  spine row could land inside the raised row above it.
 *  @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts. */
export function minRowHeight(o: StripLayoutOptions): number {
  return 2 * labelOffset(o);
}

// ---------------------------------------------------------------------------
// Per-leg edge lanes (#4381 follow-up #2, caught in live deployment). When a
// return leg exactly reverses the forward leg between the same two nodes —
// the single most common traceroute outcome, and exactly the case dedup
// collapses onto one row — both edges connected the identical two rim
// points, just walked in opposite directions. Rendered on top of each other,
// the dashed return line overlaid the solid forward line and the two
// arrowheads sat at opposite ends of one segment: a single muddy
// double-headed blob instead of two readable arrows.
//
// Deliberate choice: the offset applies unconditionally, by `e.leg` alone —
// a forward-only or return-only graph (no competing leg to collide with)
// still renders its single line off-center (forward up / return down) rather
// than centered. This keeps the rule uniform (no `hasForward`/`hasReturn`
// branching here) and matches the SNR-label convention, which already labels
// a lone return leg "below" even though nothing else occupies "above" (spec
// §3.4). A future reader should not "fix" a single-leg strip's slightly
// off-center line — it's intentional.
// ---------------------------------------------------------------------------

/** Perpendicular separation between the forward and return lanes, px. */
const LANE_OFFSET = 5;

/**
 * Unit vector perpendicular to the chord from `a` to `b`, canonicalized so
 * the SAME physical chord yields the SAME vector regardless of which
 * direction a given edge happens to traverse it — forward and return
 * routinely traverse the identical chord in opposite directions (a return
 * leg walks right-to-left across the row forward walked left-to-right), and
 * lane assignment must be by leg identity, not by direction (the same rule
 * `labelOffset`'s sign already follows). "Up" is defined as `y <= 0`: for a
 * same-row (horizontal) chord this is straight up the screen, matching the
 * forward-label-above / return-label-below convention already in place.
 * @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts.
 */
export function canonicalPerpendicular(a: StripPoint, b: StripPoint): StripPoint {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (dx < 0 || (dx === 0 && dy < 0)) {
    dx = -dx;
    dy = -dy;
  }
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return { x: uy, y: -ux }; // 90° rotation; canonical dx>=0 => y<=0 ("up")
}

// ---------------------------------------------------------------------------
// Edge/label glyph collision avoidance (#4428). The straight/dog-leg paths
// above only consider an edge's OWN two endpoints, so an edge spanning
// non-adjacent columns (or a dog-leg whose elbow lands near a glyph) used to
// render straight through unrelated nodes, and the SNR label — whose X was
// the raw endpoint midpoint — could sit exactly on the glyph/bend it should
// avoid. `routeAroundGlyphs` bends the path around every other node's
// clearance circle; `pickLabelX` then samples the label X from the FINAL
// routed path. Both are pure, bounded, and deterministic — same graph in,
// same geometry out.
// ---------------------------------------------------------------------------

/** Rim margin between a glyph's edge and where an edge line starts/ends —
 *  the historical inline `+3` in `pullIn`, named because `edgeClearance`
 *  reuses it (#4428).
 *  @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts. */
export const EDGE_RIM_MARGIN = 3;

/** How far past a clearance circle a detour bend is placed. A bend exactly
 *  ON the circle's rim would let its two adjacent segments graze back
 *  inside; the same breathing room LABEL_CLEARANCE gives labels is enough
 *  slack here. */
const BEND_MARGIN = LABEL_CLEARANCE;

/** Passes of phase 1 (interior-vertex push-out) in `routeAroundGlyphs`.
 *
 *  Why ONE pass suffices for geometry the builder + floored options produce:
 *  a pushed vertex lands exactly `detour` from the offending node's center,
 *  so it can only fall inside a SECOND node's circle when the two centers
 *  sit closer than `clearance + detour` (24 + 28 = 52px at defaults). Grid
 *  centers are at least min(colWidth, rowHeight) apart — 64px columns and
 *  the 72px `minRowHeight` floor at defaults — so a pushed vertex can never
 *  enter another circle, and the second pass verifies quiescence and breaks.
 *  The remaining passes only absorb push chains under custom options that
 *  pack columns tighter than `clearance + detour`.
 *
 *  If the cap is exhausted anyway (unreachable from produced geometry), a
 *  vertex stays inside some circle; phase 2 deliberately skips segments
 *  whose endpoint sits in-circle, so that one elbow renders on the glyph —
 *  the pre-#4428 appearance for that edge — and the loop still terminates.
 *  Degraded looks, never a hang or crash. */
const VERTEX_PUSH_PASSES = 4;

/** Numeric slack for "already clear" comparisons.
 *  @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts. */
export const GEOM_EPS = 1e-6;

/** Radius around an UNRELATED node's center that no edge segment may enter
 *  (#4428): the same rim the edge's own endpoints respect (`pullIn` =
 *  glyphSize/2 + EDGE_RIM_MARGIN) plus one LANE_OFFSET, so both legs'
 *  lane-translated parallels still clear the glyph by the full rim margin.
 *  @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts. */
export function edgeClearance(o: StripLayoutOptions): number {
  return o.glyphSize / 2 + EDGE_RIM_MARGIN + LANE_OFFSET;
}

function dist(a: StripPoint, b: StripPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Closest point to `c` on the segment `a`->`b`, plus its parameter t∈[0,1]. */
function closestPointOnSegment(
  a: StripPoint,
  b: StripPoint,
  c: StripPoint,
): { point: StripPoint; t: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < GEOM_EPS) return { point: { x: a.x, y: a.y }, t: 0 };
  const t = Math.max(0, Math.min(1, ((c.x - a.x) * abx + (c.y - a.y) * aby) / len2));
  return { point: { x: a.x + t * abx, y: a.y + t * aby }, t };
}

/**
 * Bend an (already lane-translated) polyline around every obstacle's
 * clearance circle. Two phases, both deterministic and bounded:
 *
 * 1. Interior vertices (the dog-leg elbow) inside a circle are pushed
 *    radially out past it — radially, so the vertex leaves on the side the
 *    path already favors; a vertex exactly ON a center falls back to
 *    `laneDir` (the leg's own lane-offset direction), which is what keeps
 *    forward detours above and return detours below.
 * 2. The segments are walked in order; wherever one cuts a circle, a bend is
 *    inserted just past the rim at the deepest point (same radial /
 *    `laneDir` side rule), and the shortened segment is re-checked before
 *    advancing. A segment whose own endpoint sits inside a circle is left
 *    alone — bending cannot fix it, and after phase 1 only a rim endpoint of
 *    a pathologically tight custom layout can hit that.
 *
 * The result is still a plain polyline (the strip renders `<polyline>`),
 * just with 0+ extra bend points.
 * @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts.
 */
export function routeAroundGlyphs(
  path: StripPoint[],
  obstacles: StripPoint[],
  clearance: number,
  laneDir: StripPoint,
): StripPoint[] {
  if (obstacles.length === 0) return path;
  const detour = clearance + BEND_MARGIN;
  const pts = path.slice();

  // Phase 1: push interior vertices out of every clearance circle.
  for (let pass = 0; pass < VERTEX_PUSH_PASSES; pass++) {
    let moved = false;
    for (let i = 1; i < pts.length - 1; i++) {
      for (const c of obstacles) {
        const d = dist(pts[i], c);
        if (d >= clearance - GEOM_EPS) continue;
        const dir = d > GEOM_EPS
          ? { x: (pts[i].x - c.x) / d, y: (pts[i].y - c.y) / d }
          : laneDir;
        pts[i] = { x: c.x + dir.x * detour, y: c.y + dir.y * detour };
        moved = true;
      }
    }
    if (!moved) break;
  }

  // Phase 2: insert bends where a segment cuts a clearance circle.
  //
  // Why 2N+4 cannot be hit by geometry the strip actually produces. First,
  // termination never depends on the cap: every loop iteration either
  // inserts a bend (counted against the cap) or advances `i`, and `pts`
  // grows only by insertions — so the walk always ends. The cap only bounds
  // how many bends we are willing to spend. Per obstacle, a bend is inserted
  // only for a segment whose BOTH endpoints lie outside that obstacle's
  // clearance circle (in-circle endpoints are skipped above). Such a chord
  // with both endpoints at distance >= `detour` and central wrap angle θ has
  // minimum distance >= detour·cos(θ/2), so it still cuts the circle only
  // when θ > 2·acos(clearance/detour) — about 62° at defaults (24/28).
  // Inserting the bend at the deepest point splits the wrap roughly in half,
  // so one bend resolves any wrap up to ~124°, and even the absolute worst
  // case — a near-diameter crossing, θ -> 180°, which the builder's grid
  // cannot produce because every path is a lane-offset row line or a
  // rim-pulled dog-leg — resolves after two splits, i.e. 3 bends. Produced
  // paths cut shallowly (the lane offset is 5px against a 24px radius) and
  // take exactly 1 bend per cut obstacle; 2 per obstacle plus 4 spare is
  // therefore beyond anything reachable (the #4428 tests sweep every §3.7
  // fixture plus the repro graphs and never exceed 1 per obstacle).
  //
  // If the cap were exhausted anyway (conceivable only with extreme custom
  // StripLayoutOptions, e.g. colWidth far below glyphSize so circles swallow
  // whole segments), `best` stays null, the walk runs to the end, and the
  // remaining cuts simply render through the glyph — the pre-#4428 look for
  // that edge, never an infinite loop or a crash.
  const maxBends = 2 * obstacles.length + 4;
  let inserted = 0;
  let i = 0;
  while (i < pts.length - 1) {
    const p = pts[i];
    const q = pts[i + 1];
    let best: { w: StripPoint; t: number } | null = null;
    if (inserted < maxBends) {
      for (const c of obstacles) {
        if (dist(p, c) < clearance - GEOM_EPS || dist(q, c) < clearance - GEOM_EPS) continue;
        const { point: f, t } = closestPointOnSegment(p, q, c);
        const d = dist(f, c);
        if (d >= clearance - GEOM_EPS) continue;
        const dir = d > GEOM_EPS
          ? { x: (f.x - c.x) / d, y: (f.y - c.y) / d }
          : laneDir;
        const w = { x: c.x + dir.x * detour, y: c.y + dir.y * detour };
        // A bend coinciding with an endpoint can't make progress — skip it.
        if (dist(w, p) < GEOM_EPS || dist(w, q) < GEOM_EPS) continue;
        // Deepest-first would also work; earliest-along-the-segment keeps
        // the left-to-right walk orderly. Ties keep the first obstacle in
        // node order — deterministic either way.
        if (!best || t < best.t) best = { w, t };
      }
    }
    if (best) {
      pts.splice(i + 1, 0, best.w);
      inserted++;
      // Re-check p -> bend before advancing.
    } else {
      i++;
    }
  }
  return pts;
}

/** Approximate a rendered SNR label by a circle around its anchor: half its
 *  height plus the same breathing room the vertical rule uses. Width is NOT
 *  modeled — the C1 row-band rule (`labelOffset`) already keeps anchors
 *  vertically clear of every node footprint; this radius only guards the
 *  horizontal pick/nudge in `pickLabelX`. */
/** @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts. */
export function labelClearRadius(o: StripLayoutOptions): number {
  return o.glyphSize / 2 + LABEL_HALF_HEIGHT + LABEL_CLEARANCE;
}

/**
 * #4428: choose the label's X from the FINAL routed path. Candidates are the
 * path's segment midpoints, longest segment first (ties -> the earlier
 * segment, so the pick is deterministic); the first whose anchor point
 * clears every glyph circle wins. If none clears (only reachable with tiny
 * custom layouts), fall back to the longest segment's midpoint and push it
 * horizontally clear of each offender in turn — horizontal ONLY, so the
 * forward-above/return-below lane semantics and the C1 row-band invariant
 * survive untouched.
 * @internal exported for tracerouteUnionLayout.ts / tracerouteAggregate.ts.
 */
export function pickLabelX(
  path: StripPoint[],
  anchorY: number,
  glyphCenters: StripPoint[],
  radius: number,
): number {
  const candidates: { x: number; len: number; idx: number }[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    candidates.push({
      x: (path[i].x + path[i + 1].x) / 2,
      len: dist(path[i], path[i + 1]),
      idx: i,
    });
  }
  candidates.sort((a, b) => b.len - a.len || a.idx - b.idx);
  const clears = (x: number): boolean =>
    glyphCenters.every((c) => dist({ x, y: anchorY }, c) >= radius - GEOM_EPS);
  for (const cand of candidates) {
    if (clears(cand.x)) return cand.x;
  }
  let x = candidates[0].x;
  for (let pass = 0; pass <= glyphCenters.length; pass++) {
    const offender = glyphCenters.find(
      (c) => dist({ x, y: anchorY }, c) < radius - GEOM_EPS,
    );
    if (!offender) break;
    const dy = anchorY - offender.y;
    const reach = Math.sqrt(Math.max(0, radius * radius - dy * dy));
    // Push just past the offender's circle, away from it (ties push right).
    x = offender.x + (x >= offender.x ? 1 : -1) * (reach + LABEL_CLEARANCE);
  }
  return x;
}

export function layoutTracerouteStrip(
  graph: TracerouteStripGraph,
  opts?: Partial<StripLayoutOptions>,
): StripLayout {
  const o: StripLayoutOptions = { ...DEFAULT_LAYOUT_OPTIONS, ...opts };
  // Defensive floors: guarantee the label-clearance invariants even if a
  // caller passes custom bands/rowHeight too small for its glyphSize/
  // nameHeight (§3.5.2 C2/C3).
  const topBand = Math.max(o.topBand, minBand(o));
  const bottomBand = Math.max(o.bottomBand, minBand(o));
  const rowHeight = Math.max(o.rowHeight, minRowHeight(o));
  const offset = labelOffset(o);

  const centers = new Map<string, StripPoint>();
  let maxRow = 0;
  for (const n of graph.nodes) {
    maxRow = Math.max(maxRow, n.row);
    centers.set(n.id, {
      x: n.col * o.colWidth + o.colWidth / 2,
      y: topBand + n.row * rowHeight + o.glyphSize / 2,
    });
  }

  const width = graph.columns * o.colWidth;
  const height = topBand + (maxRow + 1) * rowHeight + bottomBand;

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const edgePaths = new Map<string, StripPoint[]>();
  const labelAnchors = new Map<string, StripPoint>();
  const pullIn = o.glyphSize / 2 + EDGE_RIM_MARGIN;
  const clearance = edgeClearance(o);
  const labelRadius = labelClearRadius(o);
  const allGlyphCenters = graph.nodes.map((n) => centers.get(n.id)!);

  for (const e of graph.edges) {
    const c0 = centers.get(e.fromId);
    const c1 = centers.get(e.toId);
    const fromNode = nodeById.get(e.fromId);
    const toNode = nodeById.get(e.toId);
    if (!c0 || !c1 || !fromNode || !toNode) continue; // defensive; should not happen

    const sameRow = fromNode.row === toNode.row;
    let path: StripPoint[];
    if (sameRow) {
      const start = pullToward(c0, c1, pullIn);
      const end = pullToward(c1, c0, pullIn);
      path = [start, end];
    } else {
      const mid: StripPoint = { x: (c0.x + c1.x) / 2, y: Math.max(c0.y, c1.y) };
      const start = pullToward(c0, mid, pullIn);
      const end = pullToward(c1, mid, pullIn);
      path = [start, mid, end];
    }

    // Give each leg its own lane: translate the WHOLE path (2 or 3 points)
    // by a small perpendicular vector, computed from the true endpoint
    // centers (not the rim-pulled points) so the offset direction is stable
    // regardless of pull-in. A pure translation can't distort the
    // row-crossing dog-leg's shape or push it into either glyph — it just
    // slides the same line sideways by a few px.
    const perpUp = canonicalPerpendicular(c0, c1);
    const laneSign = e.leg === 'forward' ? 1 : -1; // forward=up, return=down
    const laneDx = perpUp.x * LANE_OFFSET * laneSign;
    const laneDy = perpUp.y * LANE_OFFSET * laneSign;
    path = path.map((p) => ({ x: p.x + laneDx, y: p.y + laneDy }));

    // #4428: bend the lane-translated path around every OTHER node's
    // clearance circle — an edge spanning non-adjacent columns (or a dog-leg
    // grazing a glyph) must not render through nodes it doesn't terminate at.
    const obstacles: StripPoint[] = [];
    for (const n of graph.nodes) {
      if (n.id === e.fromId || n.id === e.toId) continue;
      obstacles.push(centers.get(n.id)!);
    }
    const laneDir = { x: perpUp.x * laneSign, y: perpUp.y * laneSign };
    path = routeAroundGlyphs(path, obstacles, clearance, laneDir);

    edgePaths.set(e.id, path);

    // §3.5.1: the label's Y anchors off ROW CENTERS, not the (lane-offset-
    // translated) path — otherwise, with three possible rows, a flat +/-
    // offset from the path can land inside the wrong lane's node footprint.
    // That row-band rule is also what guarantees C1 (|anchor.y - center.y|
    // >= labelOffset for EVERY node), so #4428 never moves a label
    // vertically. X samples the FINAL routed path via `pickLabelX` — before
    // #4428 it was the raw endpoint midpoint, which could sit exactly on a
    // detour bend or on the column of the glyph the path just routed around.
    // For an un-detoured same-row edge the longest (only) segment's midpoint
    // IS the endpoint midpoint, so plain strips are pixel-identical.
    const laneYSign = e.leg === 'forward' ? -1 : 1; // forward=up, return=down
    const anchorY = sameRow
      ? c0.y + laneYSign * offset // same-row: offset off this row's center
      : (c0.y + c1.y) / 2; // crossing: middle of the inter-row gap
    const anchorX = pickLabelX(path, anchorY, allGlyphCenters, labelRadius);
    labelAnchors.set(e.id, { x: anchorX, y: anchorY });
  }

  return { width, height, centers, edgePaths, labelAnchors };
}
