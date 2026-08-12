/**
 * Statistical union layout — turns a `TracerouteUnionGraph` (the counting
 * model from `tracerouteAggregate.ts`) into cells (column/row) and then
 * pixels, for the strip renderer (Statistical Route epic, Phase 1 WP3).
 *
 * Pure, React-free, API-free, DB-free — safe to import from a node-
 * environment test or from any presentation layer.
 *
 * See `docs/internal/dev-notes/SR_PHASE1_SPEC.md` §2 (design decisions
 * D5–D8, D10, D11) and §3.3 for the full design. This file implements that
 * section exactly.
 *
 * TWO HALVES, TWO SOURCES OF TRUTH.
 *   - `buildUnionStripGraph` (D5/D6) assigns columns and rows. This is the
 *     hard part, and it has no analogue in `tracerouteStrip.ts` — the union
 *     graph arrives with no cells at all, unlike a `TracerouteStripGraph`
 *     whose spine builder already assigned `col`/`row`.
 *   - `layoutTracerouteUnion` (D7/D8) turns cells into pixels. This is pure
 *     reuse: every radius, floor, and routing call below is an IMPORT from
 *     `tracerouteStrip.ts`, not a re-derivation — `pullToward`,
 *     `canonicalPerpendicular`, `labelOffset`, `minBand`, `minRowHeight`,
 *     `edgeClearance`, `labelClearRadius`, `routeAroundGlyphs`, `pickLabelX`,
 *     `DEFAULT_LAYOUT_OPTIONS`, `EDGE_RIM_MARGIN` are all reused verbatim, so
 *     the two layouts cannot drift apart on shared arithmetic. The only
 *     local geometry arithmetic left is the centre/width/height formulas
 *     (§3.3 step 2) and the two path-form shapes each edge picks between
 *     (§3.3 step 3, D7) — neither is an exported helper of the strip module
 *     either; `layoutTracerouteStrip` computes them inline too.
 *
 * COLUMN ASSIGNMENT (D5). Each intermediate node gets one column, keyed by
 * the LOWER MEDIAN of its `depthSamples` (already sorted ascending by
 * `buildTracerouteUnion`) — a single array index, so no separate sort is
 * needed here. Distinct depth keys, sorted ascending, become dense column
 * indices `1..distinctKeys.length`. The local endpoint is pinned to column
 * `0`, alone; the peer endpoint is pinned to column `columns - 1`, alone.
 *
 * ROW ASSIGNMENT (D6). Within one column's node group, order by
 * `(share desc, id asc)` and assign a signed offset by index:
 * `0, +1, -1, +2, -2, …`. Offsets are then shifted GLOBALLY (across every
 * column, not per column) so the smallest offset becomes row 0. Because
 * index 0 in every group gets offset 0, the most frequent node in EVERY
 * column lands on the same row — the union graph's counterpart to the
 * single-route strip's spine, and it falls out of the arithmetic rather
 * than needing its own pass.
 *
 * EDGE PATH FORM (D7). `layoutTracerouteStrip`'s row-crossing branch keys
 * off ROW: same row -> 2-point, different row -> 3-point dog-leg with the
 * elbow at `{ x: mid, y: max(y0, y1) }`. That elbow formula divides by a
 * zero-length vector when the chord is perfectly VERTICAL — exactly what a
 * same-column, different-row union edge is (two nodes sharing a
 * `depthKey` are real data: `route1 = L,A,B,P` and `route2 = L,B,A,P` gives
 * both A and B a lower median of 1). So this module branches on COLUMN, not
 * row: same column -> 2-point (`pullToward` both ways, exactly the strip's
 * same-row form); different column AND different row -> 3-point dog-leg
 * (the strip's row-crossing form); otherwise (different column, same row)
 * -> 2-point.
 *
 * NO LANE OFFSET, NO SNR, NO ARROWHEAD DIRECTION CLAIM (D8). The epic
 * settled on combined-undirected edges in one neutral lane: no
 * `LANE_OFFSET` translation (there is no competing leg to separate from),
 * `snr`/`snrUnknown` are always `null`/`false`, and `leg` is pinned
 * `'forward'` only because it is a required `StripEdge` field the
 * renderer's solid-line CSS hook keys on — Phase 2 must branch on
 * `graph.mode === 'statistical'` to suppress arrowheads/SNR labels, never
 * read `leg` as a direction claim here.
 *
 * DETERMINISM (D11). `depthKey` is an index into a sorted array. Group
 * order is sorted distinct integers, walked column-by-column (not via `Map`
 * iteration order) so nothing depends on insertion order. Within-group
 * order is `(share desc, id asc)` with unique `id`. Offsets come from an
 * index. Geometry is arithmetic; `routeAroundGlyphs` is itself documented
 * bounded and deterministic. So identical input gives deep-equal output,
 * and — since `tracerouteAggregate.ts`'s output is permutation-invariant —
 * so is this module's.
 */

import type {
  StripLayout,
  StripLayoutOptions,
  StripNode,
  StripEdge,
  StripPoint,
  TracerouteStripGraph,
} from './tracerouteStrip.js';
import {
  DEFAULT_LAYOUT_OPTIONS,
  EDGE_RIM_MARGIN,
  pullToward,
  canonicalPerpendicular,
  labelOffset,
  minBand,
  minRowHeight,
  edgeClearance,
  labelClearRadius,
  routeAroundGlyphs,
  pickLabelX,
} from './tracerouteStrip.js';
import type { AggregateTracerouteRow, StatNode, TracerouteUnionGraph } from './tracerouteAggregate.js';
import { statOpacity, statEdgeWeight, buildTracerouteUnion } from './tracerouteAggregate.js';

// ---------------------------------------------------------------------------
// Public types (D10)
// ---------------------------------------------------------------------------

export interface UnionStripNode extends StripNode {
  /** Included routes containing this node (`StatNode.count`, D3). */
  count: number;
  /** `count / totalRoutes` (D3). */
  share: number;
  /** `statOpacity(share)` — precomputed so the renderer maps nothing (D9). */
  opacity: number;
  /** True for the local/peer node this union was built between. */
  isEndpoint: boolean;
}

export interface UnionStripEdge extends StripEdge {
  aId: string;
  bId: string;
  /** Included routes in which the two nodes were adjacent (`StatEdge.count`, D3). */
  count: number;
  share: number;
  opacity: number;
  /** `statEdgeWeight(share)` — stroke-width in px. Repeated adjacencies read
   *  heavier; the counting model owns this scalar (issue #4566). */
  weight: number;
}

export interface UnionStripGraph extends TracerouteStripGraph {
  /** Discriminant. Phase 2's renderer branches on this, never on `leg`. */
  mode: 'statistical';
  totalRoutes: number;
  nodes: UnionStripNode[];
  edges: UnionStripEdge[];
}

/**
 * Narrow a strip graph to the statistical union (D10/D12). `TracerouteStripGraph`
 * has no `mode` field, so the property read needs a structural cast — the same
 * shape the source-manager predicates use (`src/server/sourceManagerTypes.ts`).
 * Renderers MUST narrow through this, never through `leg` (D8) and never through
 * `instanceof` or `any`.
 */
export function isUnionStripGraph(graph: TracerouteStripGraph): graph is UnionStripGraph {
  return (graph as { mode?: unknown }).mode === 'statistical';
}

// ---------------------------------------------------------------------------
// Column/row assignment (D5/D6)
// ---------------------------------------------------------------------------

/** Lower median of `node.depthSamples` (D5). `depthSamples` is already
 *  sorted ascending by `buildTracerouteUnion` — this is a single array
 *  index, no sort needed here. Only meaningful for an intermediate; an
 *  endpoint's column is pinned directly and never consults this. */
function depthKey(node: StatNode): number {
  return node.depthSamples[Math.floor((node.depthSamples.length - 1) / 2)];
}

/** `(share desc, id asc)` — `id` is unique, so this is a total order (D6). */
function compareForRowOrder(a: StatNode, b: StatNode): number {
  if (a.share !== b.share) return b.share - a.share;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Signed offset for a node's index within its column group's
 *  `(share desc, id asc)` order: `0, +1, -1, +2, -2, …` (D6). */
function offsetForIndex(i: number): number {
  if (i === 0) return 0;
  return i % 2 === 1 ? (i + 1) / 2 : -(i / 2);
}

/**
 * Assign columns (D5), rows (D6), and ids, and attach counts/opacity. Pure.
 * See the module banner for the full algorithm; this is §3.3's `buildUnionStripGraph`.
 */
export function buildUnionStripGraph(union: TracerouteUnionGraph): UnionStripGraph {
  if (union.isEmpty) {
    return {
      mode: 'statistical',
      totalRoutes: 0,
      nodes: [],
      edges: [],
      columns: 0,
      hasForward: false,
      hasReturn: false,
      isEmpty: true,
    };
  }

  // --- Step 2 (D5): column assignment ---
  // A row is only included (D2) when its two-endpoint axis is drawable, so
  // both the local and peer StatNode are guaranteed present whenever
  // `union.isEmpty` is false — every included row's oriented sequence starts
  // at `localNodeNum` and ends at `peerNodeNum` (D1).
  const localNode = union.nodes.find((nd) => nd.isEndpoint && nd.nodeNum === union.localNodeNum)!;
  const peerNode = union.nodes.find((nd) => nd.isEndpoint && nd.nodeNum === union.peerNodeNum)!;
  const intermediates = union.nodes.filter((nd) => nd.id !== localNode.id && nd.id !== peerNode.id);

  const distinctKeys = Array.from(new Set(intermediates.map(depthKey))).sort((a, b) => a - b);
  const colOfDepthKey = new Map<number, number>(distinctKeys.map((key, i) => [key, i + 1]));
  const columns = 2 + distinctKeys.length;

  const colOf = new Map<string, number>();
  colOf.set(localNode.id, 0);
  colOf.set(peerNode.id, columns - 1);
  for (const nd of intermediates) colOf.set(nd.id, colOfDepthKey.get(depthKey(nd))!);

  // --- Step 3 (D6): row assignment, per column group, then a global shift ---
  // Walked by explicit column index (0..columns-1), not `Map` iteration
  // order, so group processing order never depends on insertion order (D11).
  const groups: StatNode[][] = Array.from({ length: columns }, () => []);
  groups[0].push(localNode);
  groups[columns - 1].push(peerNode);
  for (const nd of intermediates) groups[colOf.get(nd.id)!].push(nd);

  const offsetOf = new Map<string, number>();
  for (const group of groups) {
    const ordered = [...group].sort(compareForRowOrder);
    ordered.forEach((nd, i) => offsetOf.set(nd.id, offsetForIndex(i)));
  }
  const minOffset = Math.min(...union.nodes.map((nd) => offsetOf.get(nd.id)!));
  const rowOf = new Map<string, number>();
  for (const nd of union.nodes) rowOf.set(nd.id, offsetOf.get(nd.id)! - minOffset);

  // --- Step 4: emit UnionStripNodes, sorted (row asc, col asc) to match the
  // strip's node-ordering contract ---
  const nodes: UnionStripNode[] = union.nodes
    .map(
      (nd): UnionStripNode => ({
        // D10: id is reused verbatim from the aggregate (n:… / u:…), not
        // the strip's `${lane}-${col}-${nodeNum}` scheme — layout.centers
        // keys off it, so Phase 2 can cross-reference the count model
        // without a second map.
        id: nd.id,
        nodeNum: nd.nodeNum,
        lane: 'spine',
        row: rowOf.get(nd.id)!,
        col: colOf.get(nd.id)!,
        legs: [],
        shared: false,
        isUnknown: nd.isUnknown,
        count: nd.count,
        share: nd.share,
        opacity: statOpacity(nd.share),
        isEndpoint: nd.isEndpoint,
      }),
    )
    .sort((a, b) => a.row - b.row || a.col - b.col);

  // --- Step 5: emit UnionStripEdges. `union.edges` is already id-sorted
  // (aId < bId, D11) — no re-sort needed. ---
  const edges: UnionStripEdge[] = union.edges.map(
    (e): UnionStripEdge => ({
      id: `stat:${e.aId}|${e.bId}`,
      leg: 'forward',
      fromId: e.aId,
      toId: e.bId,
      snr: null,
      snrUnknown: false,
      aId: e.aId,
      bId: e.bId,
      count: e.count,
      share: e.share,
      opacity: statOpacity(e.share),
      weight: statEdgeWeight(e.share),
    }),
  );

  return {
    mode: 'statistical',
    totalRoutes: union.totalRoutes,
    nodes,
    edges,
    columns,
    hasForward: false,
    hasReturn: false,
    isEmpty: false,
  };
}

// ---------------------------------------------------------------------------
// Cells -> pixels (D7/D8), mirroring `layoutTracerouteStrip`
// ---------------------------------------------------------------------------

/**
 * Cells -> pixels. Same arithmetic, floors, clearance, and glyph routing as
 * `layoutTracerouteStrip`, via the helpers that module exports — see the
 * module banner for why every radius/floor/routing call here is an import
 * rather than a re-derivation.
 */
export function layoutTracerouteUnion(
  graph: UnionStripGraph,
  opts?: Partial<StripLayoutOptions>,
): StripLayout {
  const o: StripLayoutOptions = { ...DEFAULT_LAYOUT_OPTIONS, ...opts };
  // Defensive floors, same as the strip: guarantee the label-clearance
  // invariants even if a caller passes custom bands/rowHeight too small for
  // its glyphSize/nameHeight.
  const topBand = Math.max(o.topBand, minBand(o));
  const bottomBand = Math.max(o.bottomBand, minBand(o));
  const rowHeight = Math.max(o.rowHeight, minRowHeight(o));

  // §3.3 step 2 — the one piece of geometry arithmetic this module owns:
  // it has no exported-helper equivalent in tracerouteStrip.ts (that
  // module inlines the identical formula in `layoutTracerouteStrip`).
  const centers = new Map<string, StripPoint>();
  let maxRow = 0;
  for (const n of graph.nodes) {
    maxRow = Math.max(maxRow, n.row);
    centers.set(n.id, {
      x: n.col * o.colWidth + o.colWidth / 2,
      y: topBand + n.row * rowHeight + o.glyphSize / 2,
    });
  }

  // An empty graph (columns 0, no nodes) gives width 0 and a one-row
  // height, matching the strip's empty-graph shape.
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

    // D7: branch on COLUMN, not row — see the module banner for why the
    // strip's row-crossing elbow breaks on a same-column (vertical) chord.
    const sameCol = fromNode.col === toNode.col;
    const sameRow = fromNode.row === toNode.row;
    let path: StripPoint[];
    if (!sameCol && !sameRow) {
      // Different column, different row: 3-point dog-leg, the strip's own
      // row-crossing elbow shape (not an exported helper either).
      const mid: StripPoint = { x: (c0.x + c1.x) / 2, y: Math.max(c0.y, c1.y) };
      const start = pullToward(c0, mid, pullIn);
      const end = pullToward(c1, mid, pullIn);
      path = [start, mid, end];
    } else {
      // Same column (D7's vertical case), or same row/different column:
      // both are the strip's same-row 2-point form.
      const start = pullToward(c0, c1, pullIn);
      const end = pullToward(c1, c0, pullIn);
      path = [start, end];
    }

    // D8: no lane translation — there is no competing leg to separate from.

    // #4428 glyph-collision routing, reused verbatim (D7/D8 add nothing to
    // it): obstacles are every OTHER node's centre.
    const obstacles: StripPoint[] = [];
    for (const n of graph.nodes) {
      if (n.id === e.fromId || n.id === e.toId) continue;
      obstacles.push(centers.get(n.id)!);
    }
    // "Up" side; an arbitrary but fixed tie-break, used only when a pushed
    // vertex lands exactly on a glyph centre.
    const laneDir = canonicalPerpendicular(c0, c1);
    path = routeAroundGlyphs(path, obstacles, clearance, laneDir);

    edgePaths.set(e.id, path);

    // §3.3 step 5: computed even though statistical mode renders no SNR
    // label, so the return value is a complete StripLayout and Phase 2 gets
    // a ready-made tooltip anchor. No forward/return sign here (D8) — the
    // union graph has no leg semantics to pick "above" vs "below" from.
    const anchorY = sameRow ? c0.y - labelOffset(o) : (c0.y + c1.y) / 2;
    const anchorX = pickLabelX(path, anchorY, allGlyphCenters, labelRadius);
    labelAnchors.set(e.id, { x: anchorX, y: anchorY });
  }

  return { width, height, centers, edgePaths, labelAnchors };
}

/** One-shot seam for Phase 2: rows -> counting model -> cells -> pixels. */
export function buildStatisticalStrip(
  rows: readonly AggregateTracerouteRow[],
  localNodeNum: number,
  peerNodeNum: number,
  opts?: Partial<StripLayoutOptions>,
): { union: TracerouteUnionGraph; graph: UnionStripGraph; layout: StripLayout } {
  const union = buildTracerouteUnion(rows, localNodeNum, peerNodeNum);
  const graph = buildUnionStripGraph(union);
  const layout = layoutTracerouteUnion(graph, opts);
  return { union, graph, layout };
}
