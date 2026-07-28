/**
 * Traceroute Visual Strip — pure graph + layout util (issue #4381 WP2).
 *
 * Pure, React-free, Leaflet-free, `DeviceInfo`-free — safe to import from a
 * node-environment test or from any presentation layer. This module owns the
 * one graph shape the strip renders: a deduplicated, single-column-axis,
 * two-row DAG built from a traceroute's forward + return legs, plus a fixed
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
 * Cross-leg dedup rule: a node number appearing in both legs is drawn once.
 * The main row (row 0) is built by walking the "primary" leg (forward if
 * present, else return) in order; the FIRST occurrence of each node number
 * in that walk claims the main-row column other legs anchor to
 * (`mainNodeFirst`, "first-occurrence-wins"). A later repeat of the same
 * node number within the SAME leg (a loop) still gets its own separate
 * `StripNode` and column — only cross-leg matching dedups.
 */

import {
  parseHopArray,
  hasRouteData,
  hasReturnPath,
  isValidRouteNode,
  isUnknownSnr,
  BROADCAST_ADDR,
} from './tracerouteSegments';

export { BROADCAST_ADDR };

/** Which leg of the traceroute an edge/node belongs to. */
export type StripLeg = 'forward' | 'return';

export interface StripNode {
  /** Stable, unique within one graph: `${row}-${col}-${nodeNum}`. Assigned
   *  only after row/column placement is fully finalized. */
  id: string;
  nodeNum: number;
  /** 0 = main row, 1 = return-only branch sub-row. */
  row: 0 | 1;
  /** 0-based column index; the SAME column axis is shared by both rows. */
  col: number;
  /** Legs this node participates in. Length 2 => it is the shared overlap. */
  legs: StripLeg[];
  /** Convenience: `legs.length === 2`. */
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
  /** Ordered: row 0 left→right, then row 1 left→right. */
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
 *  the BROADCAST_ADDR placeholder. */
interface InternalLegHop {
  nodeNum: number;
  snr: number | undefined;
  isUnknown: boolean;
}

interface InternalLegInput {
  leg: StripLeg;
  /** Ordered, already filtered per §3.3. Endpoints included. */
  hops: InternalLegHop[];
}

/** One raw hop, paired with its arrival SNR, before validity filtering. */
interface RawHop {
  nodeNum: number;
  snr: number | undefined;
}

/**
 * Apply the §3.3 hop filter to one leg's raw (pre-filter) hop list.
 * Index 0 and the last index are endpoints (`fromNodeNum`/`toNodeNum`) and
 * are never filtered, even if they happen to be invalid/reserved values —
 * they are real device node numbers, not raw route placeholders.
 */
function filterHops(hops: RawHop[]): InternalLegHop[] {
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
// Step 3-5: row/column placement, dedup, divergence, edges — the core that
// operates on already-parsed-and-filtered legs. Exported (in addition to the
// public `buildTracerouteStripGraph` JSON entry point below) purely for
// testability: the "legs share no node" branch (§3.4 "case neither defined")
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
 * Core row/column/edge builder — operates on already-filtered leg hop lists.
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

  const graph = buildGraphCore(primary, secondary);
  return {
    ...graph,
    hasForward: primary.leg === 'forward' || secondary?.leg === 'forward',
    hasReturn: primary.leg === 'return' || secondary?.leg === 'return',
    isEmpty: false,
  };
}

function buildGraphCore(
  primary: InternalLegInput,
  secondary: InternalLegInput | undefined,
): Pick<TracerouteStripGraph, 'nodes' | 'edges' | 'columns'> {
  const allNodes: StripNode[] = [];
  const mainNodeFirst = new Map<number, StripNode>();

  // --- Step 3: main row (row 0) ---
  primary.hops.forEach((hop, i) => {
    const node: StripNode = {
      id: '',
      nodeNum: hop.nodeNum,
      row: 0,
      col: i,
      legs: [primary.leg],
      shared: false,
      isUnknown: hop.isUnknown,
    };
    allNodes.push(node);
    // First-occurrence-wins: a repeat of the same node number later in this
    // same leg (a loop) does NOT overwrite the anchor column other legs
    // resolve against.
    if (!mainNodeFirst.has(hop.nodeNum)) {
      mainNodeFirst.set(hop.nodeNum, node);
    }
  });
  // Snapshot the primary traversal order for edge-building below — taken
  // BEFORE any secondary-leg branch nodes are pushed onto `allNodes`.
  const primarySequence = allNodes.slice();

  const secondarySequence: StripNode[] = [];

  if (secondary) {
    /** Mutates every already-placed node's column: `col > after` shifts by
     *  `+count`. `after = -1` is valid (shifts everything). */
    const insertColumns = (after: number, count: number): void => {
      for (const n of allNodes) {
        if (n.col > after) n.col += count;
      }
    };
    const maxCol = (): number => allNodes.reduce((m, n) => Math.max(m, n.col), -1);
    const makeBranchNode = (hop: InternalLegHop, col: number): StripNode => ({
      id: '',
      nodeNum: hop.nodeNum,
      row: 1,
      col,
      legs: [secondary.leg],
      shared: false,
      isUnknown: hop.isUnknown,
    });

    let prevAnchor: StripNode | undefined;
    let pendingRun: InternalLegHop[] = [];

    const flushRun = (nextAnchor: StripNode | undefined): void => {
      const k = pendingRun.length;
      if (k === 0) return;
      let placed: StripNode[];

      if (prevAnchor && nextAnchor) {
        // Both anchors defined.
        const a = prevAnchor.col;
        const b = nextAnchor.col;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const available = hi - lo - 1;
        if (available < k) {
          const deficit = k - available;
          // `lo` is stable across this call: insertColumns only shifts
          // columns strictly greater than `after`, and `after === lo`.
          insertColumns(lo, deficit);
        }
        const ordered = b < a ? [...pendingRun].reverse() : pendingRun;
        placed = ordered.map((hop, idx) => makeBranchNode(hop, lo + 1 + idx));
      } else if (!prevAnchor && nextAnchor) {
        // Only `b` defined — run leads the leg (structurally unreachable for
        // real traceroute data, since a leg's own first hop is always one of
        // the two shared endpoints; kept for completeness per spec §3.4).
        const bBefore = nextAnchor.col;
        insertColumns(bBefore - 1, k);
        const b = nextAnchor.col; // re-read: insertColumns just shifted it
        placed = pendingRun.map((hop, idx) => makeBranchNode(hop, b - k + idx));
      } else if (prevAnchor && !nextAnchor) {
        // Only `a` defined — run trails the leg.
        const base = maxCol();
        placed = pendingRun.map((hop, idx) => makeBranchNode(hop, base + 1 + idx));
      } else {
        // Neither defined — the two legs share no node at all. Real
        // forward/return legs always share both endpoints, so this only
        // happens with hand-built disjoint input (§3.7 case 21). Place the
        // whole run on row 1 starting at column 0 rather than throwing.
        placed = pendingRun.map((hop, idx) => makeBranchNode(hop, idx));
      }

      for (const n of placed) {
        allNodes.push(n);
        secondarySequence.push(n);
      }
      pendingRun = [];
    };

    for (const hop of secondary.hops) {
      const anchor = mainNodeFirst.get(hop.nodeNum);
      if (anchor) {
        flushRun(anchor);
        if (!anchor.legs.includes(secondary.leg)) {
          anchor.legs.push(secondary.leg);
        }
        anchor.shared = anchor.legs.length === 2;
        secondarySequence.push(anchor);
        prevAnchor = anchor;
      } else {
        pendingRun.push(hop);
      }
    }
    flushRun(undefined);
  }

  // --- Finalize: sort row0-then-row1 (each left-to-right), assign ids ---
  allNodes.sort((x, y) => x.row - y.row || x.col - y.col);
  for (const n of allNodes) {
    n.id = `${n.row}-${n.col}-${n.nodeNum}`;
  }
  const columns = allNodes.reduce((m, n) => Math.max(m, n.col), -1) + 1;

  // --- Step 4/5: edges. Built after ids are finalized (edge ids embed
  // StripNode.id). ---
  const buildLegEdges = (leg: StripLeg, sequence: StripNode[], hops: InternalLegHop[]): StripEdge[] => {
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
  };

  const forwardEdges =
    primary.leg === 'forward'
      ? buildLegEdges('forward', primarySequence, primary.hops)
      : secondary?.leg === 'forward'
        ? buildLegEdges('forward', secondarySequence, secondary.hops)
        : [];
  const returnEdges =
    primary.leg === 'return'
      ? buildLegEdges('return', primarySequence, primary.hops)
      : secondary?.leg === 'return'
        ? buildLegEdges('return', secondarySequence, secondary.hops)
        : [];

  return {
    nodes: allNodes,
    edges: [...forwardEdges, ...returnEdges],
    columns,
  };
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

  const primary: InternalLegInput = hasForward
    ? { leg: 'forward', hops: forwardHops! }
    : { leg: 'return', hops: returnHops! };
  const secondary: InternalLegInput | undefined =
    hasForward && hasReturn ? { leg: 'return', hops: returnHops! } : undefined;

  const core = buildGraphCore(primary, secondary);

  return { ...core, hasForward, hasReturn, isEmpty: false };
}

// ---------------------------------------------------------------------------
// Step 6 (§3.6): pure pixel layout — fixed arithmetic, no DOM measurement.
// ---------------------------------------------------------------------------

export interface StripLayoutOptions {
  /** Column pitch in px. */
  colWidth: number;
  /** Vertical pitch between row 0 and row 1, px. */
  rowHeight: number;
  /** Glyph edge length in px. */
  glyphSize: number;
  /** Height reserved above row 0 for the forward SNR lane + tooltips, px. */
  topBand: number;
  /** Height reserved below the last row for the return SNR lane, px. */
  bottomBand: number;
}

const DEFAULT_LAYOUT_OPTIONS: StripLayoutOptions = {
  colWidth: 64,
  rowHeight: 56,
  glyphSize: 32,
  topBand: 44,
  bottomBand: 26,
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
  /** Per-edge polyline through 2 or 3 points, already offset off the glyph
   *  edges so the arrowhead lands on the rim, not under the icon. */
  edgePaths: Map<string, StripPoint[]>;
  /** Where each edge's SNR label anchors (above for forward, below for return). */
  labelAnchors: Map<string, StripPoint>;
}

function pullToward(from: StripPoint, to: StripPoint, dist: number): StripPoint {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: from.x + (dx / d) * dist, y: from.y + (dy / d) * dist };
}

export function layoutTracerouteStrip(
  graph: TracerouteStripGraph,
  opts?: Partial<StripLayoutOptions>,
): StripLayout {
  const o: StripLayoutOptions = { ...DEFAULT_LAYOUT_OPTIONS, ...opts };

  const centers = new Map<string, StripPoint>();
  let maxRow = 0;
  for (const n of graph.nodes) {
    maxRow = Math.max(maxRow, n.row);
    centers.set(n.id, {
      x: n.col * o.colWidth + o.colWidth / 2,
      y: o.topBand + n.row * o.rowHeight + o.glyphSize / 2,
    });
  }

  const width = graph.columns * o.colWidth;
  const height = o.topBand + (maxRow + 1) * o.rowHeight + o.bottomBand;

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const edgePaths = new Map<string, StripPoint[]>();
  const labelAnchors = new Map<string, StripPoint>();
  const pullIn = o.glyphSize / 2 + 3;

  for (const e of graph.edges) {
    const c0 = centers.get(e.fromId);
    const c1 = centers.get(e.toId);
    const fromNode = nodeById.get(e.fromId);
    const toNode = nodeById.get(e.toId);
    if (!c0 || !c1 || !fromNode || !toNode) continue; // defensive; should not happen

    let path: StripPoint[];
    if (fromNode.row === toNode.row) {
      const start = pullToward(c0, c1, pullIn);
      const end = pullToward(c1, c0, pullIn);
      path = [start, end];
    } else {
      const mid: StripPoint = { x: (c0.x + c1.x) / 2, y: Math.max(c0.y, c1.y) };
      const start = pullToward(c0, mid, pullIn);
      const end = pullToward(c1, mid, pullIn);
      path = [start, mid, end];
    }
    edgePaths.set(e.id, path);

    const first = path[0];
    const last = path[path.length - 1];
    const midX = (first.x + last.x) / 2;
    const midY = (first.y + last.y) / 2;
    const offset = e.leg === 'forward' ? -14 : 14;
    labelAnchors.set(e.id, { x: midX, y: midY + offset });
  }

  return { width, height, centers, edgePaths, labelAnchors };
}
