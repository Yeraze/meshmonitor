# Statistical Route Visualization — Phase 1 Implementation Spec

**Epic:** `docs/internal/dev-notes/STATISTICAL_ROUTE_EPIC.md`
**Phase goal:** pure utilities only. No React, no API, no DB, no schema change, no
new dependency, no visible product change.
**Branch:** `feature/statistical-route-phase1`
**Predecessor spec:** `docs/internal/dev-notes/TRACEROUTE_VISUAL_STRIP_SPEC.md`
(§3.4 lane/column algorithm, §3.5 edges/labels, §3.6 layout). Read §3.4.7
(invariants I1–I6) before touching anything here.

Everything in §2 (Design decisions) is binding. Where this spec deviates from a
rule the strip spec set, it says so and gives the reason.

---

## 1. Reuse inventory (mandatory)

Everything below already exists. **The implementation MUST use these. It must
not re-parse, re-filter, or re-derive any of them.** Anything not on this list
is justified in §1.3.

### 1.1 Must reuse — already exported

| What | Path:line | How Phase 1 uses it |
|---|---|---|
| `parseHopArray(json)` | `src/utils/tracerouteSegments.ts:261` | The only JSON array parser. Tolerates `null` / `'null'` / `''`. |
| `hasRouteData(route)` | `src/utils/tracerouteSegments.ts:273` | Gates the forward leg. |
| `hasReturnPath(routeBack, snrBack)` | `src/utils/tracerouteSegments.ts:198` | Gates the return leg (#2051/#3622). |
| `isValidRouteNode(nodeNum)` | `src/utils/tracerouteSegments.ts:73` | Reserved/invalid hop predicate. |
| `BROADCAST_ADDR` (`4294967295`) | `src/utils/tracerouteSegments.ts:62` | The unknown-hop placeholder. Re-exported by `tracerouteStrip.ts:58`. |
| `filterHops(hops)` | `src/utils/tracerouteStrip.ts:177` (**private today — WP1 exports it**) | §3.3 hop-filter policy: endpoints never filtered, `BROADCAST_ADDR` kept and flagged `isUnknown`, other invalid hops dropped. |
| `StripNode` / `StripEdge` / `StripLane` / `StripLeg` / `StripPoint` / `StripLayout` / `StripLayoutOptions` / `TracerouteStripGraph` | `src/utils/tracerouteStrip.ts:80,107,78,71,619,624,586,120` | The union types extend these. The layout returns a plain `StripLayout`. |
| `DEFAULT_LAYOUT_OPTIONS` | `src/utils/tracerouteStrip.ts:610` (**private today — WP1 exports it**) | Same pitch, glyph size, and bands as the single-route strip. |
| `pullToward(from, to, dist)` | `src/utils/tracerouteStrip.ts:639` (**private — WP1 exports**) | Rim pull-in for edge endpoints. |
| `canonicalPerpendicular(a, b)` | `src/utils/tracerouteStrip.ts:732` (**private — WP1 exports**) | Direction-stable perpendicular; supplies `laneDir` to the router. |
| `routeAroundGlyphs(path, obstacles, clearance, laneDir)` | `src/utils/tracerouteStrip.ts:835` (**private — WP1 exports**) | #4428 glyph-collision routing. Reused verbatim; the union layout adds nothing to it. |
| `pickLabelX(path, anchorY, glyphCenters, radius)` | `src/utils/tracerouteStrip.ts:944` (**private — WP1 exports**) | Label/tooltip anchor X sampled from the final routed path. |
| `edgeClearance(o)` / `labelClearRadius(o)` / `labelOffset(o)` / `minBand(o)` / `minRowHeight(o)` | `src/utils/tracerouteStrip.ts:794,930,678,684,694` (**private — WP1 exports**) | The clearance arithmetic. Never re-derive a radius or a floor. |
| `EDGE_RIM_MARGIN` / `GEOM_EPS` | `src/utils/tracerouteStrip.ts:760,788` (**private — WP1 exports**) | Rim margin for the 2-point/vertical path; epsilon for clearance assertions in tests. |
| `paddedHexId(nodeNum)` | `src/utils/tracerouteStrip.ts:66` | Not used by Phase 1 code, but the renderer already has it for Phase 2. No copy. |

### 1.2 Consulted, deliberately NOT reused

| What | Why not |
|---|---|
| `decomposeTraceroute` (`src/utils/tracerouteSegments.ts`) | Needs a `resolvePosition` callback and **drops every hop without a position**. The union graph must keep every hop. Same reasoning the strip spec gave in its §1.2. |
| `buildTracerouteStripGraph` (`src/utils/tracerouteStrip.ts:560`) | Builds one row's spine graph with SNR-paired edges. The union graph has no spine, no per-leg lanes, and no SNR. Reusing it would mean discarding most of its output and then merging N graphs — more work than walking the filtered legs directly. Phase 1 reuses its *filter* (`filterHops`) and its *geometry*, which is where the real duplication risk sits. |
| `formatTracerouteRoute` (`src/utils/traceroute.tsx:143`) | The third parse path the strip spec §1.3 already ruled against. It compacts the SNR array while filtering. Do not touch it, do not import it. |
| `useTracerouteAnalysis.ts` local `parseNumArray` | Fourth parse path. Same ruling. |

### 1.3 New modules, justified against the closest existing one

| New file | Closest existing | Why new |
|---|---|---|
| `src/utils/tracerouteAggregate.ts` | `src/utils/tracerouteStrip.ts` (`buildTracerouteStripGraph`) | `tracerouteStrip.ts` is documented as "the one graph shape the strip renders" for **one** traceroute, with SNR-paired directed edges and a spine. Aggregation is a different question — count occurrences across N rows, undirected, SNR-free — and its output is a counting model, not a render model. Folding it in would double that module's size and give it two unrelated public entry points. It reuses `filterHops` and every parser, so no rule is duplicated. |
| `src/utils/tracerouteUnionLayout.ts` | `layoutTracerouteStrip` (`src/utils/tracerouteStrip.ts:978`) | `layoutTracerouteStrip` takes a `TracerouteStripGraph` whose `col`/`row` are **already assigned** by the spine builder; it only turns cells into pixels. The union graph arrives with no cells at all — assigning them is the hard part and has no analogue in the strip. The pixel half is pure reuse: this module calls the same exported helpers and returns the same `StripLayout`, so the two layouts cannot drift. |

### 1.4 Files WP1 modifies, and the rule for doing it

`src/utils/tracerouteStrip.ts` gets **export-only** changes plus one widened
optional property. No logic moves, no behavior changes. The existing
`src/utils/tracerouteStrip.test.ts` (50 cases) passing unchanged is the
acceptance gate for WP1.

---

## 2. Design decisions

### D1 — Orientation: every leg runs local → peer

The `/api/traceroutes/history/:from/:to` endpoint is bidirectional, so a row's
`fromNodeNum`/`toNodeNum` may be `(local, peer)` **or** `(peer, local)`. A
row's return leg always runs the opposite way from its forward leg. Both
problems collapse into one rule:

> Build each leg's hop sequence in its own traversal order, then **reverse it
> if `sequence[0] !== localNodeNum`**.

Every leg starts and ends at the two endpoints (they are never filtered, strip
spec §3.3), so this always yields a sequence that starts at `localNodeNum` and
ends at `peerNodeNum`. No other orientation logic exists anywhere in Phase 1.

Rows whose endpoint pair is not `{localNodeNum, peerNodeNum}` are skipped and
counted in `mismatchedRoutes`. The endpoint is pair-scoped, so this should be
zero in production; the counter exists so a bug shows up as a number rather
than as silently missing data.

`localNodeNum === peerNodeNum` returns an empty union (`isEmpty: true`). A
self-pair has no two-endpoint axis to lay out.

### D2 — Row inclusion, and the denominator

A row is **included** when its endpoints match the pair **and** it yields at
least one drawable leg:

```
hasForward = hasRouteData(row.route)
hasReturn  = hasReturnPath(parseHopArray(row.routeBack), row.snrBack)
included   = hasForward || hasReturn
```

This is exactly the map's skip rule (`useTraceroutePaths.tsx:886-898`) and the
strip's (`tracerouteStrip.ts:560-572`). A row with neither leg is a failed
traceroute; it is excluded and counted in `excludedRoutes`.

`totalRoutes` = the count of **included** rows. Every `share` divides by it, so
a failed traceroute never dilutes a share.

Note `hasReturnPath` reads `snrBack`. A row with an empty `routeBack` but a
non-empty `snrBack` therefore contributes a real zero-hop return leg
(`[peer, local]` → after orientation `[local, peer]`). That is correct: the
return really did travel direct.

### D3 — Counting: once per traceroute, for both nodes and edges

* **Node count.** A node counts **once per included row in which it appears in
  any leg**, not once per occurrence. A node in both legs of one row counts
  once. A node twice in one leg (a loop) counts once.
* **Edge count.** An edge between `A` and `B` counts **once per included row in
  which `A` and `B` were adjacent in any leg**. Adjacent in both legs of one
  row still counts once. Adjacent twice within one leg still counts once.
* **Undirected.** `A→B` and `B→A` are the same edge. The canonical key sorts
  the two node ids, so the direction of traversal never reaches the output.

Consequence, and the reason for the rule: `share = count / totalRoutes` then
lands in `(0, 1]` and reads as a plain English sentence — "seen in 12 of 15
routes (80%)", which is exactly the tooltip the epic committed to. Counting
occurrences instead would let a share exceed 1 and would make a node that a
single route visits twice look more reliable than one that ten routes visit
once.

Both counters are implemented with a per-row `Set` of ids seen, flushed into
the running totals at the end of each row.

**Self-adjacency is dropped.** When `sequence[k]` and `sequence[k+1]` resolve
to the same id (a node repeated back-to-back), no edge is emitted. A self-loop
has no renderable geometry in the strip.

### D4 — Anonymous hop identity: keyed by hop depth (a scoped relaxation of I6)

`BROADCAST_ADDR` is not a node identity. The firmware writes it when
`insertUnknownHops()` backfills a gap — "a hop happened here and nobody
recorded who" (strip spec §1.4). Two unknown hops in two different traceroutes
may or may not be the same radio, and nothing in the data can tell you.

Three candidate rules were considered:

1. **Never merge.** Every unknown hop in every leg of every row is its own
   node. Rejected: a 15-route history with one unknown hop each produces 15
   distinct unknown nodes, each with `share = 1/15`, each pinned at the opacity
   floor. The picture gets worse the more data you have, which inverts the
   whole point of the view.
2. **Merge by anchoring neighbours** (identity = the pair of real nodes on
   either side). Rejected: it fragments as soon as a neighbour is itself
   unknown, it is not defined for an unknown adjacent to another unknown, and
   its determinism argument is far harder to write than to test.
3. **Merge by hop depth.** Chosen.

> **Rule.** An unknown hop's identity is `u:${depth}`, where `depth` is its
> index in the **filtered, oriented (local → peer)** sequence. Real nodes keep
> the identity `n:${nodeNum}` regardless of depth.

Depth is measured after filtering and after orientation, so it is the same
quantity in both legs of a row and in every row: hops away from the local node.

**What the merged node claims.** It claims "in P% of routes there was an
unrecorded hop at position *k* on the path". That statement is true, useful,
and makes no claim about which device it was. The glyph stays the neutral
Unknown placeholder and Phase 2's tooltip must say "unrecorded hop" — never a
node name.

**Why this does not violate strip invariant I6.** I6 exists because the
single-route strip draws a *shared spine node*, which asserts "the forward and
return legs both went through this same device". The union strip has no spine
and asserts no device identity for an unknown node at all. The relaxation is
scoped to `tracerouteAggregate.ts`; `tracerouteStrip.ts` keeps I6 untouched.

Ids are prefixed (`n:` / `u:`), so a real node and an unknown hop can never
collide.

### D5 — Column assignment: lower-median depth, grouped, endpoints pinned

A node can sit at depth 1 in one route and depth 3 in another. It gets one
column.

```
depthKey(node) = depthSamples[floor((depthSamples.length - 1) / 2)]
```

with `depthSamples` sorted ascending — the **lower median**. Integer in,
integer out. The lower median biases left, so one rare long detour cannot drag
a node rightward; and it is a single array index, so its determinism needs no
argument beyond "the array is sorted".

`depthSamples` holds one entry per **(row, leg, occurrence)**, not one per row.
A row contributing both legs weights that node twice, which is the right
weighting — it is two independent observations of where the node sat. This is
deliberately a different granularity from `count`, and the type doc says so;
`depthSamples.length` is not `count`.

**Grouping.** Intermediates are partitioned by `depthKey`. The distinct keys,
sorted ascending, become dense column indices. Then:

* the local endpoint is pinned to column `0`, alone;
* the peer endpoint is pinned to column `columns - 1`, alone.

So `columns = 2 + (number of distinct intermediate depthKeys)`, and columns `0`
and `columns - 1` each hold exactly one node. Endpoints bracket the graph even
when a stray route makes some intermediate's median larger than the peer's.

Every intermediate has `depthKey >= 1` — depth 0 is the local node by
construction — so an intermediate can never land in the local column.

### D6 — Row assignment: alternating offsets around a dominant line

Within a column group, order nodes by `(share desc, id asc)`. `id` is unique,
so this is a total order. Then assign a signed offset by index:

| index | 0 | 1 | 2 | 3 | 4 | … |
|---|---|---|---|---|---|---|
| offset | 0 | +1 | −1 | +2 | −2 | … |

(index `i`: `i === 0 ? 0 : (i % 2 === 1 ? (i+1)/2 : -(i/2))`.)

Then shift globally so the smallest offset is row 0:

```
row(node) = offset(node) - min(all offsets)
rowCount  = max(all offsets) - min(all offsets) + 1
```

**The property this buys.** The most frequent node in *every* column sits at
offset 0, so it always lands on the same row. The dominant path renders as one
straight horizontal line, and variants fan out above and below it. That is the
union graph's counterpart to the single-route strip's spine, and it falls out
of the arithmetic rather than needing its own pass.

Consequences worth knowing:

* A history with one repeated path gives every group exactly one node, every
  offset 0, one row — visually the plain strip.
* Alternation starts **downward** (`+1` before `−1`), so a two-way fan puts the
  dominant node on the top row and the variant below it. This reads better than
  the reverse for the common "one usual path, one occasional detour" case.

### D7 — Same-column edges use the vertical 2-point form

Two nodes with the same `depthKey` can be adjacent. Example: `route1 = L,A,B,P`
and `route2 = L,B,A,P` gives both `A` and `B` a lower median of 1, so both land
in column 1, and they are adjacent. This is real data, not a contrived case.

`layoutTracerouteStrip`'s row-crossing branch would break here: its elbow is
`{ x: (c0.x + c1.x) / 2, y: max(c0.y, c1.y) }`, which for a vertical chord
equals the lower endpoint's centre, so `pullToward(c1, mid, pullIn)` divides by
a zero-length vector and returns `c1` itself — a line ending inside the glyph.

> **Rule.** Branch on **column**, not on row. `col(a) === col(b)` → 2-point
> path (`pullToward` both ways). `col(a) !== col(b) && row(a) !== row(b)` →
> 3-point dog-leg, same elbow as the strip. Otherwise → 2-point path.

**Deferred, on purpose.** A nicer fix is to split a column group so adjacent
nodes never share a column. That is graph colouring; any greedy heuristic needs
its own determinism proof and its own test matrix, and the vertical edge above
renders correctly and legibly without one. Recorded as a Phase-3 candidate, not
a Phase-1 gap.

### D8 — No lane offset, no arrowheads, no SNR

The epic settled on combined-undirected edges rendered in a single neutral
lane. So:

* The union layout applies **no** `LANE_OFFSET` translation. There is no
  competing leg to separate from.
* It still calls `edgeClearance(o)`, which includes one `LANE_OFFSET` of
  headroom. Keeping the same clearance radius as the strip costs 5px of
  generosity and keeps one definition of "how close may a line pass a glyph".
* `UnionStripEdge.snr` is always `null` and `snrUnknown` always `false`. SNR is
  not aggregated. There is no defensible single SNR for an adjacency observed
  across a dozen routes at different times, and the epic rules out numeric
  labels anyway. Do not add a mean.
* `UnionStripEdge.leg` is fixed to `'forward'`. It is a required field on
  `StripEdge`, and `'forward'` is the value the renderer's solid-line CSS hook
  keys on. **Phase 2 must branch on `graph.mode === 'statistical'` to suppress
  arrowheads and SNR labels — it must not read `leg` as a direction claim.**

### D9 — Opacity floor: `MIN_STAT_OPACITY = 0.28`

```
statOpacity(share) = round3(MIN_STAT_OPACITY + (1 - MIN_STAT_OPACITY) * clamp01(share))
```

`round3(x) = Math.round(x * 1000) / 1000`.

* One constant serves both nodes and edges. Two floors would invite them to
  drift apart for no gain.
* `0.28`: below roughly `0.2` a 32px glyph stops being discernible against the
  strip background in either theme, and a rare-but-real relay must stay
  visible and hoverable — that is the whole reason the epic asked for a floor.
  `0.28` clears that with margin while still leaving a 0.28 → 1.00 ramp, so the
  encoding keeps most of its dynamic range.
* `share === 1` maps to exactly `1`. `share` near 0 maps to `0.28`.
* Rounding to three decimals keeps float noise out of deep-equality assertions.

The constant and the function live in `tracerouteAggregate.ts`, next to
`share`. Opacity is a pure function of the count model, not of geometry.

### D10 — Output shape maps onto the strip's, by extension

| Union type | Extends | Added fields |
|---|---|---|
| `UnionStripNode` | `StripNode` | `count`, `share`, `opacity`, `isEndpoint` |
| `UnionStripEdge` | `StripEdge` | `aId`, `bId`, `count`, `share`, `opacity` |
| `UnionStripGraph` | `TracerouteStripGraph` | `mode: 'statistical'`, `totalRoutes` |

Because they extend, a `UnionStripGraph` is assignable to
`TracerouteStripGraph` and `layoutTracerouteUnion` returns a plain
`StripLayout`. Phase 2's renderer changes are: a `mode` branch that reads
`opacity` and suppresses arrowheads/SNR labels, and a tooltip that reads
`count`/`share`/`totalRoutes`.

Inherited fields on a union node are pinned:

* `lane: 'spine'` — one neutral band; keeps the renderer's existing lane class
  hook working.
* `legs: []`, `shared: false` — the union graph has no leg semantics. Phase 2
  must not read either field in statistical mode.
* `id` — reused verbatim from the aggregate (`n:…` / `u:…`), so
  `layout.centers` keys match `StatNode.id` and Phase 2 can cross-reference the
  count model without a second map.
* `hasForward: false`, `hasReturn: false` — no single leg produced this graph.

Edge id is `stat:${aId}|${bId}` with `aId < bId`.

### D11 — Determinism

No `Date.now`, no `Math.random`, no `localeCompare` (locale-dependent ordering
is not determinism), no object-iteration order dependence.

*Aggregation.* One pass over rows. All state in `Map`s keyed by string. Output
arrays sorted by `id` with a plain `<` / `>` comparator; ids are unique, so the
order is total. `depthSamples` is sorted ascending before it leaves the module.
Counts are integers; `share` is integer ÷ integer.

**Stronger than determinism: the union graph is invariant under permutation of
the input rows.** Counts are sums, `depthSamples` is sorted, and the output
arrays are id-sorted. Nothing carries row order. This is a named test.

*Layout.* `depthKey` is an index into a sorted integer array. Group order is
sorted distinct integers. Within-group order is `(share desc, id asc)` with
unique `id`. Offsets come from an index. Geometry is arithmetic.
`routeAroundGlyphs` is documented bounded and deterministic
(`tracerouteStrip.ts:768-788, 862-889`). Therefore identical input gives
deep-equal output, and the layout is permutation-invariant too, since its input
is.

---

## 3. File-by-file changes

### 3.1 `src/utils/tracerouteStrip.ts` — MODIFY (WP1)

Export-only. No logic moves. No behavior changes.

Add `export` to each of these existing declarations, each with a one-line
`@internal` note naming `tracerouteUnionLayout.ts` / `tracerouteAggregate.ts`
as the consumer:

```ts
export interface RawHop { nodeNum: number; snr?: number; }   // widened: snr was `number | undefined`
export interface InternalLegHop { nodeNum: number; snr: number | undefined; isUnknown: boolean; }

export function filterHops(hops: RawHop[]): InternalLegHop[];

export const DEFAULT_LAYOUT_OPTIONS: StripLayoutOptions;
export const EDGE_RIM_MARGIN: number;
export const GEOM_EPS: number;

export function pullToward(from: StripPoint, to: StripPoint, dist: number): StripPoint;
export function canonicalPerpendicular(a: StripPoint, b: StripPoint): StripPoint;
export function labelOffset(o: StripLayoutOptions): number;
export function minBand(o: StripLayoutOptions): number;
export function minRowHeight(o: StripLayoutOptions): number;
export function edgeClearance(o: StripLayoutOptions): number;
export function labelClearRadius(o: StripLayoutOptions): number;
export function routeAroundGlyphs(
  path: StripPoint[], obstacles: StripPoint[], clearance: number, laneDir: StripPoint,
): StripPoint[];
export function pickLabelX(
  path: StripPoint[], anchorY: number, glyphCenters: StripPoint[], radius: number,
): number;
```

Only one signature changes: `RawHop.snr` becomes optional so the aggregate can
pass `{ nodeNum }` without a meaningless `snr: undefined`. Every existing caller
already supplies `snr` explicitly, and `filterHops` reads it as
`number | undefined` either way.

Add a short banner paragraph under the existing module banner: this module is
now also the geometry and hop-filter home for the statistical union layout, and
the `@internal` exports exist so the two layouts cannot drift.

### 3.2 `src/utils/tracerouteAggregate.ts` — CREATE (WP2)

```ts
/** BROADCAST_ADDR unknown hops are keyed `u:<depth>`; real nodes `n:<nodeNum>`. */
export const REAL_NODE_ID_PREFIX = 'n';
export const UNKNOWN_HOP_ID_PREFIX = 'u';

/** Minimum rendered opacity for a node or edge, whatever its share (D9). */
export const MIN_STAT_OPACITY = 0.28;

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

export function buildTracerouteUnion(
  rows: readonly AggregateTracerouteRow[],
  localNodeNum: number,
  peerNodeNum: number,
): TracerouteUnionGraph;

/** Linear ramp from MIN_STAT_OPACITY at share→0 to 1 at share=1, rounded to
 *  three decimals. Clamps out-of-range input. */
export function statOpacity(share: number): number;
```

Internal, not exported:

```ts
interface OrientedLeg { ids: string[]; nodeNums: number[]; isUnknown: boolean[]; }
function orientedLegs(row, localNodeNum, peerNodeNum): OrientedLeg[]  // 0, 1, or 2 legs
```

Algorithm, per row:

1. Endpoint check → `mismatchedRoutes`, skip.
2. Forward raw hops = `[from, ...parseHopArray(route), to]`; return raw hops =
   `[to, ...parseHopArray(routeBack), from]`. Gate each with
   `hasRouteData` / `hasReturnPath`.
3. `filterHops` each present leg.
4. Reverse the leg if `hops[0].nodeNum !== localNodeNum` (D1).
5. Map hop `k` to an id: `isUnknown ? u:${k} : n:${nodeNum}`.
6. Per-row `Set<string>` of node ids, per-row `Set<string>` of edge ids. Record
   `depthSamples` per occurrence.
7. Flush both sets into the running counters; `totalRoutes += 1`.

Then compute shares, sort `depthSamples`, sort `nodes` and `edges` by `id`.

`isEmpty` is `totalRoutes === 0`.

### 3.3 `src/utils/tracerouteUnionLayout.ts` — CREATE (WP3)

```ts
import type { StripLayout, StripLayoutOptions, StripNode, StripEdge,
              TracerouteStripGraph } from './tracerouteStrip';
import type { AggregateTracerouteRow, TracerouteUnionGraph } from './tracerouteAggregate';
// value imports: statOpacity, buildTracerouteUnion from './tracerouteAggregate';
// value imports: DEFAULT_LAYOUT_OPTIONS, EDGE_RIM_MARGIN, pullToward,
//   canonicalPerpendicular, labelOffset, minBand, minRowHeight, edgeClearance,
//   labelClearRadius, routeAroundGlyphs, pickLabelX from './tracerouteStrip';

export interface UnionStripNode extends StripNode {
  /** Included routes containing this node. */
  count: number;
  share: number;
  /** statOpacity(share). Precomputed so the renderer maps nothing. */
  opacity: number;
  isEndpoint: boolean;
}

export interface UnionStripEdge extends StripEdge {
  aId: string;
  bId: string;
  count: number;
  share: number;
  opacity: number;
}

export interface UnionStripGraph extends TracerouteStripGraph {
  /** Discriminant. Phase 2's renderer branches on this, never on `leg`. */
  mode: 'statistical';
  totalRoutes: number;
  nodes: UnionStripNode[];
  edges: UnionStripEdge[];
}

/** Assign columns (D5), rows (D6), and ids, and attach counts/opacity. Pure. */
export function buildUnionStripGraph(union: TracerouteUnionGraph): UnionStripGraph;

/** Cells -> pixels. Same arithmetic, floors, clearance, and glyph routing as
 *  `layoutTracerouteStrip`, via the helpers that module now exports. */
export function layoutTracerouteUnion(
  graph: UnionStripGraph,
  opts?: Partial<StripLayoutOptions>,
): StripLayout;

/** One-shot seam for Phase 2. */
export function buildStatisticalStrip(
  rows: readonly AggregateTracerouteRow[],
  localNodeNum: number,
  peerNodeNum: number,
  opts?: Partial<StripLayoutOptions>,
): { union: TracerouteUnionGraph; graph: UnionStripGraph; layout: StripLayout };
```

`buildUnionStripGraph` steps:

1. Empty union → `{ mode:'statistical', totalRoutes:0, nodes:[], edges:[],
   columns:0, hasForward:false, hasReturn:false, isEmpty:true }`.
2. `depthKey` per node (D5). Partition intermediates; sort distinct keys
   ascending; pin local to column 0 and peer to the last column.
3. Per column, order by `(share desc, id asc)`; assign offsets (D6); shift to
   dense rows.
4. Emit `UnionStripNode`s with `lane:'spine'`, `legs:[]`, `shared:false`,
   `opacity: statOpacity(share)`; sort by `(row asc, col asc)` to match the
   strip's node ordering contract.
5. Emit `UnionStripEdge`s in `union.edges` order (already id-sorted), with
   `leg:'forward'`, `snr:null`, `snrUnknown:false`,
   `fromId:aId`, `toId:bId`, `id: 'stat:' + aId + '|' + bId`.

`layoutTracerouteUnion` steps — mirroring `layoutTracerouteStrip:978-1076`:

1. `o = { ...DEFAULT_LAYOUT_OPTIONS, ...opts }`; floor `topBand`/`bottomBand`
   at `minBand(o)` and `rowHeight` at `minRowHeight(o)`.
2. `centers[id] = { x: col*colWidth + colWidth/2,
   y: topBand + row*rowHeight + glyphSize/2 }`.
   `width = columns * colWidth`;
   `height = topBand + (maxRow+1)*rowHeight + bottomBand`.
   An empty graph gives `width 0` and a one-row height, matching the strip.
3. Per edge: choose the path form by **column** (D7). `pullIn =
   glyphSize/2 + EDGE_RIM_MARGIN`. **No lane translation.**
4. Obstacles = every node centre except the edge's own two.
   `laneDir = canonicalPerpendicular(c0, c1)` (the "up" side; an arbitrary but
   fixed tie-break, used only when a vertex lands exactly on a glyph centre).
   `path = routeAroundGlyphs(path, obstacles, edgeClearance(o), laneDir)`.
5. `labelAnchors` — computed even though statistical mode renders no SNR label,
   so the return value is a complete `StripLayout` and Phase 2 gets a
   ready-made tooltip anchor. `anchorY = sameRow ? c0.y - labelOffset(o)
   : (c0.y + c1.y) / 2`; `anchorX = pickLabelX(path, anchorY, allCenters,
   labelClearRadius(o))`.

---

## 4. Test plan

Vitest, default node environment (all three modules are pure). New `*.test.ts`
files next to the modules. No standalone scripts, no snapshot files.

### 4.1 `src/utils/tracerouteStrip.test.ts` — ADD to existing (WP1)

New `describe('exported internals (statistical route Phase 1)')`:

1. `filterHops` keeps both endpoints even when their node numbers are reserved.
2. `filterHops` keeps `BROADCAST_ADDR` intermediates and flags `isUnknown`.
3. `filterHops` drops invalid intermediates and does not re-index survivors'
   SNR samples.
4. `filterHops` accepts a `RawHop` with `snr` omitted.
5. `minBand`/`minRowHeight`/`labelOffset`/`edgeClearance`/`labelClearRadius`
   return the documented values for `DEFAULT_LAYOUT_OPTIONS`.
6. `routeAroundGlyphs` returns the input path unchanged when `obstacles` is
   empty.
7. **All 50 existing cases still pass unchanged** — the WP1 gate.

### 4.2 `src/utils/tracerouteAggregate.test.ts` — CREATE (WP2)

*Counting rules*

1. Node counted once per row when it appears in both legs of that row.
2. Node counted once per row when it appears twice in one leg (a loop).
3. Edge counted once per row when the pair is adjacent in both legs.
4. Edge counted once per row when the pair is adjacent twice in one leg.
5. `A→B` in one row and `B→A` in another produce **one** edge with `count: 2`.
6. Endpoints have `count === totalRoutes` and `share === 1`.
7. `share` equals `count / totalRoutes` for every node and edge.
8. Self-adjacency (`sequence[k] === sequence[k+1]`) emits no edge.

*Direction and normalization*

9. A row stored `(peer, local)` produces the same union as the same route
   stored `(local, peer)`.
10. A mixed history of both orientations merges into one graph, not two.
11. The return leg is oriented local→peer, so its hop depths count from local.
12. `localNodeNum === peerNodeNum` returns an empty union.
13. A row whose endpoints are neither local nor peer increments
    `mismatchedRoutes` and is excluded from `totalRoutes`.

*Row exclusion*

14. `route: null, routeBack: null` → `excludedRoutes: 1`, `totalRoutes: 0`.
15. `route: 'null'` and `routeBack: ''` → excluded (the string forms).
16. Forward-only row is included.
17. Return-only row (empty `routeBack`, non-empty `snrBack`) is included and
    yields a direct local–peer edge.
18. A failed row mixed into a good history does not change any share.
19. Malformed JSON (`route: '{'`) parses to `[]` via `parseHopArray`; the row
    still counts as a direct forward leg.

*Unknown hops*

20. Two routes, each with one unknown at depth 1, merge to a single `u:1` node
    with `count: 2`.
21. Unknowns at different depths stay distinct (`u:1` and `u:2`).
22. An unknown never merges with a real node at the same depth.
23. `unknownDepth` is set exactly when `isUnknown` is true (U7).
24. An unknown in the forward leg and one at the same depth in the return leg
    of the **same** row merge and still count once.
25. `nodeNum === BROADCAST_ADDR` on every unknown node.

*Hop filtering (delegated, asserted once)*

26. A reserved intermediate (`nodeNum: 2`) is dropped from the union.
27. Reserved values at the endpoints are kept (endpoints are never filtered).

*Degenerate and structural*

28. Empty `rows` → `isEmpty: true`, `totalRoutes: 0`, no nodes, no edges.
29. Single route → every share is 1, node count is path length.
30. Two disjoint routes (no shared intermediates) → union contains both paths,
    each intermediate at `share: 0.5`, endpoints at 1.
31. Two routes sharing a prefix → the shared prefix nodes carry the higher
    share, the diverging tails 0.5 each.
32. A node visited at different depths in two routes yields
    `depthSamples: [d1, d2]` sorted ascending.
33. `depthSamples.length` may exceed `count` (documented granularity).

*Invariants and determinism*

34. U1: every `share` is in `(0, 1]`.
35. U3: node ids unique; edge ids unique.
36. U4: every edge's `aId`/`bId` resolves to a node in `nodes`.
37. U5: `aId < bId` for every edge.
38. U6: permuting `rows` yields a deep-equal union graph.
39. Two calls with the same input yield deep-equal output.
40. Node and edge arrays are sorted by `id` ascending.

*Opacity*

41. `statOpacity(1) === 1`.
42. `statOpacity(0)` and `statOpacity(1/50)` are both `>= MIN_STAT_OPACITY`.
43. `statOpacity` is monotone non-decreasing across a swept range.
44. Out-of-range input (`-1`, `2`) clamps to `MIN_STAT_OPACITY` / `1`.

### 4.3 `src/utils/tracerouteUnionLayout.test.ts` — CREATE (WP3)

*Columns*

1. Local at column 0, peer at column `columns - 1`.
2. Columns 0 and `columns - 1` hold exactly one node each.
3. A node at depth 1 in one route and depth 3 in another gets the lower median
   (column derived from key 1).
4. Even-count `depthSamples` take the **lower** median.
5. Direct-only history → `columns === 2`, one row.
6. Two routes of different length → dense column indices, no gaps.

*Rows*

7. Single repeated path → every node on one row.
8. Two parallel paths → two rows; the more frequent node sits on the dominant
   row.
9. The dominant node of every column shares one row index (D6's property).
10. Offsets alternate `0, +1, -1, +2, -2` for a four-way fan in one column.
11. No two nodes in one column share a row.

*Edges and geometry*

12. Same-column adjacency renders a 2-point vertical path, both endpoints
    pulled in, neither point equal to a glyph centre (D7).
13. Same-row, different-column adjacency renders a 2-point path.
14. Different-row, different-column adjacency renders a 3-point dog-leg with
    the elbow at the lower row.
15. An edge spanning non-adjacent columns bends around the intervening glyph:
    no path vertex and no sampled point on any segment lies closer than
    `edgeClearance(o) - GEOM_EPS` to an unrelated node centre.
16. Every `graph.nodes` id has a `layout.centers` entry (L1).
17. `width === columns * colWidth`; `height` matches the floored band formula.
18. Custom `opts` below the floors are raised to `minBand` / `minRowHeight`.
19. Every `edgePaths` entry has at least 2 points.
20. Every edge has a `labelAnchors` entry, and its `y` clears every node centre
    by at least `labelOffset(o)` on a same-row edge.

*Graph shape*

21. Every node has `lane: 'spine'`, `legs: []`, `shared: false`.
22. Every edge has `leg: 'forward'`, `snr: null`, `snrUnknown: false`.
23. `mode === 'statistical'`; `hasForward`/`hasReturn` are false.
24. `opacity === statOpacity(share)` on every node and edge.
25. Node ids are carried over verbatim from the aggregate.
26. Empty union → empty graph, `columns: 0`, `width: 0`, and a layout that does
    not throw.

*Determinism*

27. Two runs of `buildStatisticalStrip` on the same rows deep-equal, including
    every `Map` (compare via `[...map.entries()]`).
28. Permuting the input rows yields a deep-equal layout.
29. No `Date`/`Math.random` reachable: assert stability with a frozen clock is
    unnecessary — instead assert case 27 twice with `Math.random` stubbed to a
    throwing spy.

*Integration with fixtures*

30. A realistic 15-row fixture (mixed orientations, one failed row, two
    unknowns, one loop) produces a graph satisfying L1–L4 and every clearance
    assertion.

---

## 5. Work packages

Three packages. **WP1 and WP2 are independent and touch disjoint files, so they
run in parallel.** WP3 needs both.

```
WP1 ─┐
     ├─> WP3
WP2 ─┘
```

### WP1 — Export the strip's geometry and hop filter

**Files (exclusive):** `src/utils/tracerouteStrip.ts`,
`src/utils/tracerouteStrip.test.ts`

**Scope:** §3.1 and §4.1. Add `export` to the listed declarations, widen
`RawHop.snr` to optional, add the banner paragraph and the `@internal` notes,
add the new test block.

**Acceptance:**
- `npx tsc --noEmit` clean.
- All 50 existing `tracerouteStrip.test.ts` cases pass **unchanged** — no test
  edited, no expectation moved.
- The six new cases in §4.1 pass.
- `git diff` contains no change to any function body in `tracerouteStrip.ts`
  other than the `RawHop` interface line. A reviewer must be able to confirm
  "export-only" by reading the diff.
- `npm run lint:ci` shows no in-repo `FAIL`.

### WP2 — Aggregation module

**Files (exclusive):** `src/utils/tracerouteAggregate.ts`,
`src/utils/tracerouteAggregate.test.ts`

**Scope:** §3.2 and §4.2. Implements D1–D4, D9, and the aggregation half of
D11.

**Dependency note:** WP2 does **not** import from `tracerouteStrip.ts`. It
would like `filterHops`, but WP1 may not have landed. Implement against
`isValidRouteNode` + `BROADCAST_ADDR` from `tracerouteSegments.ts` behind a
local `filterLegHops` helper with the identical policy, and leave a
`// TODO(WP3): replace with filterHops from tracerouteStrip once WP1 lands`
marker. **WP3 performs that swap and deletes the local helper** — this is the
one duplication the phase tolerates, and it exists only so the two packages can
run at the same time. If WP1 has already merged when WP2 starts, import
`filterHops` directly and skip the marker.

**Acceptance:**
- All 44 cases in §4.2 pass.
- `npx tsc --noEmit` clean; no `any`; strict mode.
- No import from React, an API module, a DB module, or `tracerouteStrip.ts`
  (unless WP1 landed first).
- Case 38 (row-permutation invariance) passes — this is the package's headline
  property.
- `npm run lint:ci` shows no in-repo `FAIL`.

### WP3 — Union layout module

**Files (exclusive):** `src/utils/tracerouteUnionLayout.ts`,
`src/utils/tracerouteUnionLayout.test.ts`
**Files touched for the WP2 swap:** `src/utils/tracerouteAggregate.ts` (delete
the local hop filter, import `filterHops`).

**Depends on:** WP1 (the exports) and WP2 (the aggregate types).

**Scope:** §3.3 and §4.3. Implements D5–D8, D10, and the layout half of D11.

**Acceptance:**
- All 30 cases in §4.3 pass.
- `layoutTracerouteUnion` contains **no** copy of a formula that
  `tracerouteStrip.ts` exports. Reviewer check: the module's only geometry
  arithmetic is the centre/width/height formulas of §3.3 step 2; every radius,
  floor, and routing call is an import.
- Case 12 (same-column vertical edge) passes — it is the case a naive port of
  `layoutTracerouteStrip` gets wrong.
- Case 15 (glyph clearance on a column-spanning edge) passes.
- `tracerouteAggregate.ts` no longer defines a local hop filter.
- Full Vitest suite green (`success: true` in the JSON reporter, not just a
  green summary line — see CLAUDE.md).
- `npx tsc --noEmit` clean; no `any`.
- `npm run lint:ci` shows no in-repo `FAIL`.

### Phase exit

Typecheck clean, full suite green, `lint:ci` clean, three modules exported and
tested, **no UI or behavior change shipped**. The orchestrator records D1–D11 in
`STATISTICAL_ROUTE_EPIC.md` and ticks Phase 1.
