# Traceroute Visual Strip — Implementation Spec (issue #4381)

**Branch:** `feature/4381-traceroute-visual-strip`
**Scope:** ONE PR. Node Details page only (`src/components/MessagesTab.tsx`, the
`traceroute-info` block at ~L1917–1985).
**Status:** spec only — no implementation code exists yet.

Replace the two plain-text route lines in the Node Details traceroute box with a
single left-to-right strip of Node-Map node icons, arrowed for direction, SNR
labelled, deduplicated across the forward and return legs, with a branch
sub-row where the two legs diverge.

---

## 0. Confirmed decisions (settled with the user — do not re-litigate)

1. **Icons reuse the existing Node Map icon system.** Role glyph family from
   `categoryGlyphFamily`/`roleGlyphInnerSvg`, colored by hop count via
   `getHopColor` exactly as the map does, plus the unmessagable capability
   badge. **No new role→color map. No legend.** (This overrides the "role
   colors" wording in issue #4381.)
2. **Layout:** single row, left to right. Arrows between nodes carry real
   arrowheads. Forward path renders first with its SNR labels **above** the
   row; return path labels **below**. Label = the SNR value for that hop.
3. **Dedup:** a node in both legs is drawn **once**. Showing the overlap is the
   point of the feature.
4. **Divergence:** shared nodes stay on the main row; return-only nodes drop to
   a lower sub-row with the return arrow routed through them.
5. **Node labels:** shortName under each icon + a hover/focus tooltip revealing
   long name, role name, and node ID.
6. **Out of scope, must not be touched:** `TracerouteBody` (map popups),
   `TracerouteHistoryModal`, `RouteSegmentTraceroutesModal`, `TracerouteWidget`.
   They keep using `formatTracerouteRoute`.
7. **Preserve:** the `traceroute('write')` permission gate, the "last traced X
   ago" line, the pending/failed badges for null routes, and i18n.

---

## 1. Reuse Inventory

Everything below already exists. **The implementation MUST use these; it must
not re-derive, re-parse, or re-draw any of them.** Anything not on this list is
justified in §1.2.

### 1.1 Must reuse

| What | Path | How it is used |
|---|---|---|
| `roleGlyphInnerSvg(category, color)` | `src/components/map/markerIcons.ts:46` | Inner glyph markup. Pure string fn, already Leaflet-independent. |
| `roleGlyphMarkerSvg(category, color, size)` | `src/components/map/markerIcons.ts:97` | Complete `<svg>` glyph-over-white-disc. Returns `''` for the `standard` family — the strip's fallback branch keys off that. |
| `unmessageableBadgeSvg(size)` | `src/components/map/markerIcons.ts:38` (currently **private**) | The `Ban` capability badge. WP1 exports it. |
| `getHopColor(hops, hopColors?)` | `src/components/map/markerIcons.ts:121` | The ONLY source of node color. Never invent a palette. |
| `getNodeTypeCategory(node)` / `categoryGlyphFamily` / `NODE_TYPE_CATEGORY_META` | `src/utils/nodeTypeCategory.ts` | Node → glyph category, and the role display label. |
| `getEffectiveHops(node, calculation, traceroutes, currentNodeNum)` | `src/utils/nodeHops.ts:20` | Hop count fed to `getHopColor`. Same call the map (`NodesTab.tsx:1097`) and the DM node list already make. |
| `getRoleName(role)` | `src/utils/nodeHelpers.ts:158` | Tooltip role line. Returns `null` when unknown. |
| `isValidRouteNode(nodeNum)` | `src/utils/tracerouteSegments.ts` | Reserved/invalid hop filter. **The canonical predicate** — see §3.3 for the one deliberate deviation (BROADCAST_ADDR). |
| `hasReturnPath(routeBack, snrBack)` | `src/utils/tracerouteSegments.ts:199` | The #2051/#3622 empty-return-path guard. Gates the return leg. |
| `isUnknownSnr(scaledSnr)` / `UNKNOWN_SNR_SENTINEL` | `src/utils/tracerouteSegments.ts` | The INT8_MIN (`-128/4 = -32`) unknown-hop sentinel. |
| `parseHopArray` / `hasRouteData` | `src/utils/tracerouteSegments.ts:262,274` (currently **private**) | JSON array parse tolerant of `null`/`'null'`/`''`. WP2 exports both. |
| `DeviceInfo` | `src/types/device.ts` | `user.longName/shortName/role`, `isUnmessagable`, `hopsAway`. |
| `UiIcon` | `src/components/icons` | Any interface glyph the strip needs beyond the node glyphs (CLAUDE.md hard rule). |
| `useTranslation()` + flat dotted keys in `public/locales/en.json` | | i18n. |
| CSS-module pattern | `src/components/NodeDetailsButton.module.css` + `.tsx` | Style containment reference (CLAUDE.md CSS rule). |
| Component-test pattern | `src/components/HopCountDisplay.test.tsx` (simple), `src/components/MessagesTab.composeFocus.test.tsx` (MessagesTab harness + mocks) | Test templates. |
| Leaflet-mock test pattern | `src/components/map/markerIcons.test.ts` | Template for WP1's regression test. |

### 1.2 New modules, each justified against the closest existing one

| New | Closest existing | Why new |
|---|---|---|
| `src/utils/roleGlyphSvg.ts` | `src/components/map/markerIcons.ts` | `markerIcons.ts` does `import L from 'leaflet'` at module top. Importing it from `MessagesTab.tsx` pulls Leaflet into the Messages chunk and into every MessagesTab jsdom test. This is a **pure relocation** of the already-Leaflet-free string builders, with `markerIcons.ts` re-exporting them. Exact precedent: `src/utils/tracerouteSegments.ts` was carved out of `mapHelpers.tsx` for the same reason and `mapHelpers.tsx` re-exports (see its banner comment). |
| `src/utils/tracerouteStrip.ts` | `decomposeTraceroute` in `src/utils/tracerouteSegments.ts` | `decomposeTraceroute` requires a `resolvePosition` callback and emits lat/lng render segments — it is a *map* decomposition and **drops any hop without a position**. The strip needs every hop regardless of position, plus dedup, row assignment, and column layout, which `decomposeTraceroute` has no concept of. New module, but it reuses `parseHopArray`/`hasRouteData`/`hasReturnPath`/`isValidRouteNode`/`isUnknownSnr` and copies the SNR index-pairing rule verbatim (§3.2). |
| `src/utils/tracerouteStripMeta.ts` | — | Thin `DeviceInfo[] → Map<nodeNum, meta>` adapter. Kept out of the component so the component takes plain data and out of `tracerouteStrip.ts` so that stays free of `DeviceInfo`. |
| `src/components/traceroute/NodeGlyph.tsx` | `MapLegend.tsx:148-153` raw-SVG span | The thin React wrapper the task asks for. |
| `src/components/traceroute/TracerouteStrip.tsx` | — | The strip itself. |

### 1.3 ONE parse path — decision

**`src/utils/tracerouteStrip.ts` is the only place the strip parses route/SNR
JSON, and it parses via `parseHopArray` exported from
`src/utils/tracerouteSegments.ts`.** Rationale: three parse paths exist today —

* `formatTracerouteRoute` (`src/utils/traceroute.tsx:143`) — inline, its own
  local `isValidRouteNode`, and it **compacts** the SNR array while filtering
  (`snrArray.push(...)` only for surviving hops), which shifts SNR samples.
* `useTracerouteAnalysis.ts` — its own local `parseNumArray`.
* `tracerouteSegments.ts` — `parseHopArray` + `isValidRouteNode` +
  `hasReturnPath`, documented as "the SINGLE home" for exactly this, and the
  one that pairs SNR **before** filtering so a dropped hop does not shift its
  neighbours' samples.

`tracerouteSegments.ts` wins. WP2 exports `parseHopArray` and `hasRouteData`
from it (no behavior change; they are already used internally by
`decomposeTraceroute`). Do **not** add a fourth parser, and do **not** modify
`formatTracerouteRoute` — the out-of-scope surfaces still depend on it byte for
byte.

### 1.4 Deliberate behavior change: SNR hop pairing

`formatTracerouteRoute` renders `snrArray[idx]` next to `fullPath[idx]`, i.e. it
attaches the first SNR sample to the path's **start** node. The authoritative
convention (documented in `useTracerouteAnalysis.ts` and implemented by
`buildLegSegments`) is that `snr[i]` is measured at the **receiver** of hop `i`,
i.e. at `fullPath[i+1]`. The strip uses the authoritative pairing: **edge
`path[k-1] → path[k]` carries the arrival SNR at `path[k]`, and `path[0]` has
no incoming SNR.** Call this out in the PR description — a reviewer comparing
old and new screenshots will see the labels shift by one position, and that is
the fix, not a regression.

**Confirmed against firmware master** (`TraceRouteModule::appendMyIDandSNR()`,
`src/modules/TraceRouteModule.cpp`): each relay writes `snr_list[n] = rx_snr * 4`
and `route[n] = my_node_num` at the *same* index in the same call, so `route[i]`
is literally the node that recorded `snr_towards[i]`, and the value it recorded
is the SNR of the packet it just received from the previous hop. A complete
forward leg therefore has exactly `route_count + 1` SNR entries — the trailing
one is appended by the destination itself (the `SNRonly` branch), which is why
§3.2 reads `snrTowards[route.length]` for the final edge. Because the strip puts
each SNR on the **arrow** rather than on a node, this indexing is unambiguous by
construction.

Three further firmware facts that this design already accommodates, recorded so
a future reader doesn't "fix" them:

* **`INT8_MIN` (-128) is the explicit unknown-SNR sentinel**, not `0`. Case 17
  in §3.7 covers it (`-128 / 4 = -32` → `isUnknownSnr`).
* **`insertUnknownHops()` deliberately backfills mid-path gaps** with
  `route[i] = NODENUM_BROADCAST` and `snr_list[i] = INT8_MIN` when the packet's
  `hop_start`/`hop_limit` imply more hops than were appended (an old relay that
  doesn't participate in path-recording). This is firmware-generated signal, not
  corruption — it is the direct justification for §3.3 keeping `BROADCAST_ADDR`
  as a visible "Unknown" hop. Dropping it would understate the path length.
* **The two legs can traverse physically different relays**, and
  `route_back_count` need not equal `route_count` — flood routing does not
  guarantee a symmetric return. This is exactly the divergence case §3.4 exists
  to lay out; do not assume symmetry anywhere.
* `ROUTE_SIZE` is 8; beyond that the firmware silently stops appending with no
  truncation marker. That surfaces here as "SNR array shorter than hop list"
  (case 15), which already degrades to `snr: null`.

### 1.5 Should `MapLegend.tsx` migrate onto the new React wrapper?

**No — explicitly recommended against in this PR.** Reasons:

* The legend swatch is a decorative `aria-hidden` span with a **fixed** color
  (`NODE_TYPE_LEGEND_COLOR`), no tooltip, no shortName label, no unmessagable
  badge, and no `standard`-category fallback (it filters `standard` out
  precisely because `roleGlyphMarkerSvg` returns `''` for it). Every prop
  `NodeGlyph` exists to carry is inapplicable, so "reuse" would mean growing
  `NodeGlyph` a `decorative`/`noFallback` mode to serve one call site — more
  API surface, not less duplication.
* The reuse that actually matters is already in place: both surfaces render the
  string from the same `roleGlyphMarkerSvg`. WP1's extraction keeps
  `MapLegend`'s import working unchanged via the re-export.

Leave `MapLegend.tsx` alone. If `NodeGlyph` later grows a genuinely decorative
mode for another consumer, revisit then.

---

## 2. Files

```
NEW  src/utils/roleGlyphSvg.ts                              (WP1)
MOD  src/components/map/markerIcons.ts                      (WP1 — re-export shim)
MOD  src/components/map/markerIcons.test.ts                 (WP1 — extraction guard)

NEW  src/utils/tracerouteStrip.ts                           (WP2)
NEW  src/utils/tracerouteStrip.test.ts                      (WP2)
MOD  src/utils/tracerouteSegments.ts                        (WP2 — export 2 helpers + BROADCAST_ADDR)

NEW  src/components/traceroute/NodeGlyph.tsx                (WP3)
NEW  src/components/traceroute/NodeGlyph.module.css         (WP3)
NEW  src/components/traceroute/NodeGlyph.test.tsx           (WP3)
NEW  src/components/traceroute/TracerouteStrip.tsx          (WP3)
NEW  src/components/traceroute/TracerouteStrip.module.css   (WP3)
NEW  src/components/traceroute/TracerouteStrip.test.tsx     (WP3)
MOD  public/locales/en.json                                 (WP3)

NEW  src/utils/tracerouteStripMeta.ts                       (WP4)
NEW  src/utils/tracerouteStripMeta.test.ts                  (WP4)
MOD  src/components/MessagesTab.tsx                         (WP4)
NEW  src/components/MessagesTab.tracerouteStrip.test.tsx    (WP4)
```

`src/styles/nodes.css` is **not** modified. (The existing `.traceroute-info`,
`.traceroute-age` and `.messages-split-view .traceroute-info` rules stay exactly
as they are — the strip nests inside that box.)

---

## 3. `src/utils/tracerouteStrip.ts` — the pure graph util

No React, no Leaflet, no `DeviceInfo`. Node environment tests.

### 3.1 Types

```ts
/** Which leg of the traceroute an edge belongs to. */
export type StripLeg = 'forward' | 'return';

/** Firmware placeholder for a relay-role hop that refused to self-identify. */
export const BROADCAST_ADDR = 4294967295; // re-exported from tracerouteSegments

export interface StripNode {
  /** Stable, unique within one graph: `${row}-${col}-${nodeNum}`. */
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

export function buildTracerouteStripGraph(
  input: TracerouteStripInput,
): TracerouteStripGraph;
```

### 3.2 Step 1 — parse each leg into a node sequence + arrival SNRs

Copy the pairing rule from `buildLegSegments`
(`src/utils/tracerouteSegments.ts:288-347`) verbatim. Internal shape:

```ts
interface LegPath {
  /** Ordered node numbers, endpoints included. */
  nodes: number[];
  /** rawSnr[k] = raw firmware SNR (dB × 4) arriving AT nodes[k].
   *  Always `undefined` at k === 0. */
  rawSnr: (number | undefined)[];
}
```

**Forward leg** — emitted only when `hasRouteData(input.route)`:

```
hops = [ { nodeNum: fromNodeNum, snr: undefined },
         ...route.map((n, i) => ({ nodeNum: n, snr: i < snrTowards.length ? snrTowards[i] : undefined })),
         { nodeNum: toNodeNum,
           snr: route.length < snrTowards.length ? snrTowards[route.length] : undefined } ]
```

**Return leg** — `routeBack = parseHopArray(input.routeBack)`; emitted only when
`hasReturnPath(routeBack, input.snrBack)`:

```
hops = [ { nodeNum: toNodeNum,   snr: undefined },
         ...routeBack.map(...snrBack...),
         { nodeNum: fromNodeNum, snr: ... } ]
```

Then filter (§3.3) and drop the paired `snr` alongside the dropped hop — never
re-index. This is what keeps a surviving hop's SNR correct across a removed
neighbour.

### 3.3 Step 2 — hop filtering (reserved / invalid / broadcast)

Applied per leg, **after** pairing, to intermediate hops only. Index 0 and the
last index are never filtered — they are real device node numbers.

```
for each intermediate hop h at index i:
  if h.nodeNum === BROADCAST_ADDR  -> KEEP, mark isUnknown = true
  else if !isValidRouteNode(h.nodeNum) -> DROP (with its paired snr)
  else -> KEEP
```

Note the deliberate deviation: `tracerouteSegments`'s `isValidRouteNode` returns
`false` for `BROADCAST_ADDR` (its consumers cannot place an unresolvable hop on
a map). `formatTracerouteRoute` keeps it and renders "Unknown", because a hop
*did* occur and hiding it lies about the path length. The strip preserves the
Node-Details behavior: keep it, flag `isUnknown`, render the neutral placeholder
glyph with the label "Unknown". Everything else (`<= 3`, `255`, `65535`) is
dropped by `isValidRouteNode`.

An endpoint (`fromNodeNum`/`toNodeNum`) that is itself invalid is still kept —
same as `buildLegSegments`.

### 3.4 Step 3 — main row, dedup, and divergence

Definitions:

* `primary` = the forward leg if present, else the return leg.
* `secondary` = the other leg, if present.
* If only one leg exists, the graph is one row and step 3 is trivial.

**Orientation.** The main row is laid out in `primary`'s traversal order, left
to right. When `primary` is the forward leg, the return leg therefore travels
**right to left** across the same axis; its arrowheads point left. That is
correct and is the whole reason arrowheads (not just position) carry direction.
Label lane assignment is by **leg identity, not by direction**: forward labels
always above, return labels always below, even in the return-only case where the
return leg reads left→right.

**Main row.** Walk `primary.nodes` in order; each element becomes a `StripNode`
with `row: 0` and `col` = its ordinal. A node repeating inside a single leg (a
loop) gets a **separate `StripNode` per occurrence**, each with its own column.
Build `mainCol: Map<nodeNum, number>` recording the **first** occurrence's
column — first-occurrence-wins is the deterministic dedup rule for cross-leg
matching, and must be documented in the module and asserted by a test.

**Unknown hops are exempt from cross-leg dedup.** A hop flagged `isUnknown`
(i.e. `BROADCAST_ADDR`) must NEVER be registered as a cross-leg anchor, and a
secondary-leg unknown hop must never resolve to one. Each occurrence gets its
own `StripNode` and an unanchored return-leg unknown hop flows into the normal
branch-run path onto row 1.

Rationale: `BROADCAST_ADDR` is not a node identity, it is the firmware's
"a hop happened here and nobody recorded who" placeholder, written by
`insertUnknownHops()` (see §1.4). Both legs of a single traceroute routinely
carry one whenever any relay in the path runs firmware old enough not to
participate in path recording. Deduping two of them would render a **shared
node that does not exist** — and "these two paths overlap here" is the single
claim this whole visualization is making. Two independent unknowns are exactly
the case where that claim cannot be supported. Case 22 in §3.7 asserts this,
including that genuine endpoint dedup still works in the same graph.

**Secondary walk.** For each element of `secondary.nodes`, resolve
`anchor = mainCol.get(nodeNum)`. Anchored elements reuse the existing main-row
`StripNode` (append `'return'` to its `legs`, set `shared = true`). Unanchored
elements are collected into maximal **runs** of consecutive unanchored elements.

**Placing a run.** A run of length `k` is bounded by the anchor before it
(column `a`, undefined if the run starts the leg) and the anchor after it
(column `b`, undefined if the run ends the leg).

```
case both anchors defined:
    lo = min(a, b); hi = max(a, b)
    available = hi - lo - 1
    if available < k:
        deficit = k - available
        insertColumns(after = lo, count = deficit)   // shift every node with col > lo right by deficit; update mainCol
    place the k nodes on row 1 at columns lo+1 .. lo+k
    order within the placement: source order when b > a (traversal left→right),
                                reversed when b < a (traversal right→left)
    // a === b (leg returns to the same node) is handled by the same code:
    // available = -1 < k, so k+1 columns are inserted after lo.

case only `b` defined (run leads the leg):
    insertColumns(after = b - 1, count = k)   // i.e. prepend k columns before b
    place at columns b-k .. b-1, in the order that puts the leg's first node
    furthest from `b`
    // when b === 0 this prepends at the far left; `insertColumns(after = -1, ...)`
    // must be supported.

case only `a` defined (run trails the leg):
    append k columns after the current max column
    place at maxCol+1 .. maxCol+k in source order

case neither defined:
    unreachable — a run with no anchors means the two legs share no node, which
    is impossible: forward and return always share both endpoints
    (`fromNodeNum`/`toNodeNum`) unless one leg is absent, and an absent leg means
    there is no `secondary`. Assert/throw is wrong here; place the whole
    secondary leg on row 1 in source order starting at column 0 and let the
    renderer draw it. Cover with a test using hand-built disjoint input.
```

`insertColumns(after, count)` mutates every already-assigned `StripNode.col`
greater than `after` by `+count`, and mutates `mainCol` the same way. Keep it as
one small helper; it is where an off-by-one will hide.

Row-1 ordering rule restated: the placement order must make the return arrow
**monotone in column** across the run so branch edges never cross each other.

**Ordering of `graph.nodes`:** sort by `row`, then `col`. Row-1 columns are
therefore always a strict subset of the row-0 column axis.

### 3.5 Step 4 — edges

For each leg, for every consecutive pair `(p[k-1], p[k])` in that leg's
`StripNode` sequence (which mixes row-0 and row-1 nodes for the secondary leg):

```
raw     = leg.rawSnr[k]                        // arrival SNR at p[k]
scaled  = raw === undefined ? undefined : raw / 4
unknown = scaled !== undefined && isUnknownSnr(scaled)
snr     = (scaled === undefined || unknown) ? null : scaled
```

Emit `{ id: `${leg}:${fromId}>${toId}`, leg, fromId, toId, snr, snrUnknown: unknown }`.

`graph.edges` = all forward edges in source order, then all return edges in
source order.

### 3.6 Step 5 — layout (also pure, same module)

```ts
export interface StripLayoutOptions {
  /** Column pitch in px. */
  colWidth: number;        // default 64
  /** Vertical pitch between row 0 and row 1, px. */
  rowHeight: number;       // default 56
  /** Glyph edge length in px. */
  glyphSize: number;       // default 32
  /** Height reserved above row 0 for the forward SNR lane + tooltips, px. */
  topBand: number;         // default 44
  /** Height reserved below the last row for the return SNR lane, px. */
  bottomBand: number;      // default 26
}

export interface StripPoint { x: number; y: number }

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

export function layoutTracerouteStrip(
  graph: TracerouteStripGraph,
  opts?: Partial<StripLayoutOptions>,
): StripLayout;
```

Geometry is **fixed and arithmetic** — no DOM measurement, no `ResizeObserver`.
`center(node) = { x: col * colWidth + colWidth / 2, y: topBand + row * rowHeight + glyphSize / 2 }`.
`width = columns * colWidth`; `height = topBand + (maxRow + 1) * rowHeight + bottomBand`.

Edge paths:
* Same-row edge → straight segment between the two centers, both ends pulled in
  by `glyphSize / 2 + 3` along the segment.
* Row-crossing edge (main ↔ branch) → 3-point polyline: start rim, a midpoint at
  `{ x: (x0+x1)/2, y: max(y0,y1) }`, end rim. Rendered as a rounded polyline;
  do not use a bezier, straight dog-legs are easier to read at 48–64px pitch
  and trivially assertable in tests.

Label anchor: midpoint of the path, offset `-14px` in `y` for `forward`,
`+14px` for `return`.

This function is unit-tested on numbers only — no rendering required.

### 3.7 Edge cases the util MUST handle (each gets a named test)

| # | Input | Expected |
|---|---|---|
| 1 | `route = null` and `routeBack = null` | `isEmpty: true`, `nodes: []`, `edges: []`, `columns: 0`, `hasForward/hasReturn: false` |
| 2 | `route = 'null'` (the string) | Same as (1) for that leg — `hasRouteData` handles it |
| 3 | `route = ''` | Same as (1) for that leg |
| 4 | `route = '[]'`, `snrTowards = '[]'` | Forward leg emitted: 2 nodes (`from`, `to`), 1 edge, `snr: null`. `hasRouteData('[]')` is TRUE — an empty array is a *direct* path, not a missing one |
| 5 | `routeBack = '[]'`, `snrBack = '[]'` | Return leg **suppressed** — `hasReturnPath([], '[]')` is false (#2051/#3622). `hasReturn: false` |
| 6 | Forward only (`routeBack` null) | One row, forward edges only, all labels above |
| 7 | Return only (`route` null) | One row laid out in the RETURN leg's order (left = `toNodeNum`), return edges only, all labels **below** |
| 8 | Single hop / direct (`route = '[]'`, `routeBack = '[]'` but `snrBack = '[-40]'`) | 2 nodes, 1 forward + 1 return edge between the same pair, distinct edge ids, return edge's arrowhead points the other way |
| 9 | Identical forward and return paths (full overlap) | Exactly `n` nodes, all `shared: true`, `2(n-1)` edges, `row: 1` unused |
| 10 | Divergence `F = A→B→C→D`, `R = D→E→A` | Row 0 = `[A,B,C,D]` cols 0–3; `E` on row 1; columns inserted as needed; return edges `D→E`, `E→A` cross rows; A and D are `shared` |
| 11 | Multi-node branch `F = A→B→C`, `R = C→X→Y→A` | `X`,`Y` both on row 1, columns monotone between C(2) and A(0) — traversal is right→left so placement order is reversed; one column inserted (available = 1, k = 2) |
| 12 | Loop within one leg `route = [B, C, B]` | Three distinct `StripNode`s for B/C/B, three distinct columns, `mainCol.get(B)` = the FIRST B's column, edges have distinct ids |
| 13 | Reserved node in route `route = [2, 999, 255, 65535, 1234]` | `2`,`255`,`65535` dropped; surviving path `[from, 999, 1234, to]`; **SNR of the surviving hops unshifted** (assert the exact `snr` on each edge) |
| 14 | `BROADCAST_ADDR` in route | Kept, `isUnknown: true`, still gets its edge and SNR |
| 15 | `snrTowards` SHORTER than the hop list | Missing entries → `snr: null`, `snrUnknown: false` |
| 16 | `snrTowards` LONGER than the hop list | Extra entries ignored; the entry at index `route.length` is the destination's arrival SNR and IS used |
| 17 | `snrTowards` contains `-128` | `snr: null`, `snrUnknown: true` (the INT8_MIN sentinel via `isUnknownSnr(-32)`) |
| 18 | Malformed JSON (`route = '{'`) | `parseHopArray` catches → `[]`; leg still emitted as direct (because `hasRouteData` is true), no crash |
| 19 | Non-array JSON (`route = '5'`) | `parseHopArray` → `[]`; same as (18) |
| 20 | `fromNodeNum === toNodeNum` | Degenerate but must not crash or loop; single column when the route is empty |
| 21 | Legs sharing no node (hand-built) | Secondary leg placed wholly on row 1 from column 0; no throw |

---

## 4. React components

### 4.1 `src/utils/roleGlyphSvg.ts` (WP1)

Banner comment, mirroring `tracerouteSegments.ts`:

> Pure SVG string builders for node role glyphs. **Leaflet-free on purpose** —
> `markerIcons.ts` re-exports these for map callers, and off-map surfaces
> (the Node Details traceroute strip) import them directly so they don't pull
> Leaflet into a non-map bundle/test. Do not add a Leaflet import here.

Moved verbatim (byte-identical output required):
`repeaterTowerSvg`, `roleGlyphInnerSvg`, `roleGlyphMarkerSvg`,
`unmessageableBadgeSvg` (now **exported**), `getHopColor`.

Added:

```ts
/** The bare glyph-less marker disc: the same white circle + hop-colored stroke
 *  `roleGlyphMarkerSvg` draws under a glyph. Used when a category has no glyph
 *  (the `standard` family) so the strip still shows a hop-colored node.
 *  `roleGlyphMarkerSvg` keeps returning '' for those categories — its existing
 *  contract is load-bearing for `createNodeIcon` and `MapLegend`. */
export function plainNodeDiscSvg(color: string, size = 24): string;

/** Neutral placeholder for a BROADCAST_ADDR hop that never self-identified:
 *  dashed grey circle with a centered "?" — visibly "a hop happened here, we
 *  don't know who". */
export function unknownNodeSvg(size = 24): string;
```

`markerIcons.ts` then becomes: `import L from 'leaflet'; export { roleGlyphInnerSvg, roleGlyphMarkerSvg, getHopColor, unmessageableBadgeSvg } from '../../utils/roleGlyphSvg';`
plus its own internal imports. **Every existing importer keeps its current
import path** — `MapLegend.tsx`, `createNodeIcon`, `markerIcons.test.ts`,
`NodeMarkersLayer`, `MeshCoreMap`, `DashboardMap`, `EmbedMap` are untouched.

### 4.2 `src/components/traceroute/NodeGlyph.tsx` (WP3)

```tsx
export interface NodeGlyphProps {
  category: NodeTypeCategory;
  /** Already resolved through getHopColor — NEVER a caller-invented color. */
  color: string;
  size?: number;              // default 32
  unmessagable?: boolean;
  /** Render the neutral unknown-hop placeholder instead of a role glyph. */
  unknown?: boolean;
  className?: string;
}
```

Body:

```
svg = unknown
        ? unknownNodeSvg(size)
        : (roleGlyphMarkerSvg(category, color, size) || plainNodeDiscSvg(color, size))
```

Renders one `<span className={styles.glyph} aria-hidden="true"
dangerouslySetInnerHTML={{ __html: svg }} />`, plus, when `unmessagable`, an
absolutely-positioned `<span className={styles.badge} aria-hidden="true"
dangerouslySetInnerHTML={{ __html: unmessageableBadgeSvg(round(size * 0.4)) }} />`
in the top-right corner (same placement `createNodeIcon` uses).

`dangerouslySetInnerHTML` is correct and precedented here (`MapLegend.tsx:152`
does the same with the same builder). The strings are machine-generated from a
closed category enum plus a hex color from `getHopColor`. **Add a code comment
stating that the `color` prop must never carry user-supplied text**, so a
future caller doesn't route a node name into it.

`aria-hidden` on the glyph is deliberate: the accessible name lives on the
strip-node wrapper (§4.3), so a screen reader announces the node once, not
twice.

### 4.3 `src/components/traceroute/TracerouteStrip.tsx` (WP3)

```tsx
export interface TracerouteStripNodeMeta {
  nodeNum: number;
  /** Display shortName; falls back to the last 4 hex digits. */
  shortName: string;
  longName: string | null;
  /** Human role name, e.g. "Router (Late)". null when unknown. */
  roleLabel: string | null;
  /** "!a1b2c3d4" — node.user.id when known, else padded hex. */
  nodeId: string;
  category: NodeTypeCategory;
  /** Effective hops; 999 = unknown (grey). */
  hops: number;
  unmessagable: boolean;
}

export interface TracerouteStripProps {
  graph: TracerouteStripGraph;
  /** nodeNum -> metadata. A missing entry renders the unknown placeholder. */
  meta: Map<number, TracerouteStripNodeMeta>;
  /** Narrow-container mode: smaller pitch + glyph + font. */
  compact?: boolean;
}
```

The component is a pure function of `(graph, meta, compact)` — no contexts, no
hooks except `useTranslation`, `useId`, and one `useMemo` around
`layoutTracerouteStrip`. That is what makes it cheap to test.

DOM structure:

```
<div className={styles.scroller} role="group" aria-label={t('messages.traceroute_strip_label', 'Traceroute path')}>
  <div className={styles.canvas} style={{ width: layout.width, height: layout.height }}>

    <svg className={styles.edges} width={layout.width} height={layout.height} aria-hidden="true" focusable="false">
      <defs>
        <marker id={`${uid}-head`} .../>      {/* one marker, both legs */}
      </defs>
      {edges.map(e => <polyline className={e.leg === 'forward' ? styles.forwardEdge : styles.returnEdge}
                                points={...} markerEnd={`url(#${uid}-head)`} />)}
    </svg>

    {edges.map(e => (
      <span className={cx(styles.snrLabel, e.leg === 'forward' ? styles.above : styles.below)}
            style={{ left: anchor.x, top: anchor.y }}>
        {e.snrUnknown
          ? <span className={styles.snrUnknown} title={t('messages.traceroute_snr_unknown', 'Unknown SNR (MQTT-bridged hop, decrypt failure, or old firmware)')}>?</span>
          : e.snr === null ? null : t('messages.traceroute_hop_snr', '{{snr}} dB', { snr: e.snr.toFixed(1) })}
      </span>
    ))}

    {nodes.map(n => (
      <div className={styles.node} style={{ left: center.x, top: center.y }}
           tabIndex={0} aria-describedby={`${uid}-tip-${n.id}`}
           aria-label={accessibleName}>
        <NodeGlyph ... />
        <span className={styles.shortName}>{shortName}</span>
        <span id={`${uid}-tip-${n.id}`} role="tooltip" className={styles.tooltip}>
          <span className={styles.tipLong}>{longName ?? shortName}</span>
          <span className={styles.tipRole}>{roleLabel}</span>
          <span className={styles.tipId}>{nodeId}</span>
        </span>
      </div>
    ))}
  </div>
</div>
```

Details:

* **Marker ids must be `useId()`-suffixed.** Two strips on one page (or a strip
  plus any future SVG) with a bare `id="head"` collide and the second one's
  arrowheads vanish. There is precedent for `useId` at
  `src/components/automations/GeofenceFieldInput.tsx:19`.
* **One marker def, both legs.** Colors: use `var(--ctp-pink)` for both legs,
  matching `overlayColors.tracerouteForward`/`tracerouteReturn`, which are
  deliberately the *same* color with the comment "direction shown by arrows".
  Differentiate the return leg by **dash pattern** (`stroke-dasharray: 4 3`) and
  by its label lane, not by hue. Do not invent a second traceroute color.
* Set the marker's fill in the CSS module (`.arrowHead { fill: var(--ctp-pink); }`)
  rather than inline, so the theme variable resolves.
* An edge with `snr === null && !snrUnknown` renders **no** label element at all
  (not an empty span) — keeps the DOM assertable.
* `meta.get(nodeNum)` missing OR `node.isUnknown` → `<NodeGlyph unknown />`,
  shortName = `t('messages.traceroute_unknown_node', 'Unknown')`, tooltip shows
  only the padded hex id.

**Accessibility.**

* Each strip node is `tabIndex={0}` so the tooltip is keyboard-reachable — the
  content is otherwise hover-only. It is deliberately NOT a `<button>`: nothing
  is clickable and a button would promise an action that doesn't exist.
* The tooltip element is **always in the DOM** with `opacity: 0; pointer-events: none`
  (never `display: none`), so `aria-describedby` resolves for assistive tech.
  It is revealed by `.node:hover .tooltip, .node:focus-visible .tooltip { opacity: 1 }`.
* No `title` attribute anywhere on the node (it would double-announce alongside
  the described-by tooltip). `title` IS used on the SNR "?" chip, matching the
  existing `formatSnrElement` treatment in `src/utils/traceroute.tsx:34`.
* `aria-label` on the node wrapper carries the whole thing in one string:
  `"{longName} ({shortName}), {roleLabel}, {nodeId}"`, so a screen-reader user
  gets it without needing the tooltip at all.
* The `<svg>` layer is `aria-hidden="true" focusable="false"` — arrows carry no
  information a screen reader can't get from reading the node sequence.
* `prefers-reduced-motion`: the strip has no animation; nothing to gate.

### 4.4 `src/components/traceroute/TracerouteStrip.module.css` (WP3)

Per CLAUDE.md's CSS containment rule: a CSS module scoped to this component.
**No additions to `src/styles/nodes.css`** — in particular do NOT touch the
`.messages-split-view .traceroute-info` block at `nodes.css:1329`, which sits
inside a mobile `@media` and is subject to that file's documented
cascade-ordering hazard (#3532).

Key rules:

```css
.scroller {
  overflow-x: auto;
  overflow-y: hidden;      /* tooltips live inside the reserved topBand */
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
  max-width: 100%;
  padding-bottom: 2px;     /* keeps the focus ring off the scrollbar */
}
.canvas { position: relative; }
.edges  { position: absolute; inset: 0; pointer-events: none; }
.node   { position: absolute; transform: translate(-50%, -50%); display: flex;
          flex-direction: column; align-items: center; }
```

**Overflow / narrow widths.** The canvas has a fixed computed width
(`columns * colWidth`), so the strip never forces the page or panel to scroll
horizontally — only `.scroller` scrolls, satisfying the "wide content scrolls
inside its own container" rule. The box lives inside `.traceroute-info`, which
in split view (`.messages-split-view .traceroute-info`) is a narrow side panel;
the scroller is what absorbs that.

**Compact mode.** Driven by the `compact` prop (layout numbers), not only by a
media query, because the split-view panel can be narrow on a wide viewport.
`compact` → `colWidth 48`, `rowHeight 44`, `glyphSize 24`, `topBand 34`,
`bottomBand 20`, `.shortName { font-size: 0.6rem; max-width: 44px; }`.
Additionally, a `@media (max-width: 768px)` block in the module shrinks the
short-name font one more step. MessagesTab passes `compact` when the node list
is not collapsed (split view) — see §5.

**Tooltip band.** `topBand` reserves vertical room so a tooltip anchored upward
from row 0 stays inside `.canvas` and is not clipped by `overflow-y: hidden`.
Row-1 tooltips also anchor upward, into the gap between rows. Verify visually;
if a row-1 tooltip overlaps row 0's glyphs, increase `rowHeight`, do not switch
the scroller to `overflow: visible` (that reintroduces page-level horizontal
scroll).

**Short names** get `max-width: <colWidth - 6>px; overflow: hidden;
text-overflow: ellipsis; white-space: nowrap;` — the full name is in the
tooltip.

Light/dark: use `var(--ctp-*)` tokens only. No hard-coded hex except what comes
back inside the generated SVG strings (which already take `getHopColor` output).

---

## 5. `MessagesTab.tsx` wiring (WP4)

Replace **only** the two `<div className="traceroute-route">` blocks at
`MessagesTab.tsx:1938-1959`. Everything else inside the IIFE at L1918-1985 stays
byte-identical: the `hasPermission('traceroute', 'write')` gate, `age`/`ageStr`
(including the `Math.max(0, …)` clamp for #2768), `forwardFailed`/`returnFailed`/
`noData`/`isPending`/`isFailed`, the `.traceroute-age` line, and both badges.

New body:

```tsx
const stripGraph = buildTracerouteStripGraph(recentTrace);
const stripMeta = buildStripNodeMeta(stripGraph, nodes, {
  hopsCalculation: nodeHopsCalculation,
  traceroutes,
  currentNodeNum,
});

<div className="traceroute-info" style={{ marginTop: '1rem' }}>
  {stripGraph.isEmpty
    ? <div className="traceroute-route">{t('messages.traceroute_no_response', 'No response received')}</div>
    : <TracerouteStrip graph={stripGraph} meta={stripMeta} compact={!isMessagesNodeListCollapsed} />}
  {!stripGraph.isEmpty && !stripGraph.hasReturn && (
    <div className={/* module class */}>{t('messages.traceroute_no_return_path', 'No return path data')}</div>
  )}
  <div className="traceroute-age"> …unchanged… </div>
</div>
```

Notes:

* `recentTrace` (`TracerouteData`, `MessagesTab.tsx:70-78`) is structurally
  compatible with `TracerouteStripInput` — no adapter, no prop-drilling change,
  no change to `getRecentTraceroute`.
* `nodeHopsCalculation` (L300), `traceroutes` (L301), `currentNodeNum` (L303),
  and `nodes` are all already in scope. **No new props on `MessagesTabProps`.**
* Wrap both `build*` calls in a single `useMemo` keyed on
  `[recentTrace, nodes, nodeHopsCalculation, traceroutes, currentNodeNum]`.
  Because the block lives inside an IIFE in JSX, hoist the memo to component
  scope (compute from `getRecentTraceroute(selectedDMNode)` there) rather than
  calling a hook inside the IIFE — **calling a hook inside that IIFE is a
  rules-of-hooks violation and will fail lint.** This is the one structural
  refactor WP4 must make.
* `formatTracerouteRoute` may become unused in `MessagesTab.tsx` — remove the
  import if so (`src/utils/traceroute.tsx` itself stays, other callers need it).
* Watch the ESLint ratchet: do not add `react-hooks/exhaustive-deps` or
  `no-explicit-any` violations to `MessagesTab.tsx` (already baselined). Verify
  with `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'`.

### 5.1 `src/utils/tracerouteStripMeta.ts` (WP4)

```ts
export function buildStripNodeMeta(
  graph: TracerouteStripGraph,
  nodes: DeviceInfo[],
  opts: {
    hopsCalculation: NodeHopsCalculation;
    traceroutes: { fromNodeNum: number; toNodeNum: number; route: string | null; routeBack: string | null }[];
    currentNodeNum: number | null;
  },
): Map<number, TracerouteStripNodeMeta>;
```

* Index `nodes` into a `Map<nodeNum, DeviceInfo>` once, then look up only the
  node numbers in `graph.nodes` (never an O(n·m) `find` per hop).
* `hops` = `getEffectiveHops(node, opts.hopsCalculation, opts.traceroutes, opts.currentNodeNum)`;
  `999` when the node is unknown. This is the identical call the map
  (`NodesTab.tsx:1097`) makes — that is what "colored exactly as the map does"
  means here.
* `category` = `getNodeTypeCategory(node)`; unknown node → `'mtClient'`
  (`getNodeTypeCategory`'s own default) but with no glyph reached anyway since
  the strip renders the unknown placeholder.
* `roleLabel` = `getRoleName(node.user?.role)`.
* `shortName` = `node.user?.shortName?.trim()` || last 4 hex digits of
  `nodeNum`, matching `getNodeShortName`'s fallback shape.
* `nodeId` = `node.user?.id` || `` `!${nodeNum.toString(16).padStart(8, '0')}` ``.
* `unmessagable` = `!!node.isUnmessagable`.
* Nodes absent from `nodes` get **no map entry** (the component's missing-entry
  branch handles them) — do not fabricate a half-populated record.

---

## 6. i18n (WP3)

Keys are **flat dotted strings** in `public/locales/en.json`. Add to `en.json`
only, and pass an English default at every call site — precedent:
`messages.traceroute_pending` is called with a default and has no `en.json`
entry at all (`MessagesTab.tsx:1968`). Other locales fall back to the default
until translated.

Reuse unchanged: `messages.traceroute_forward`, `messages.traceroute_return`,
`messages.last_traced`, `messages.traceroute_failed`,
`messages.traceroute_pending`.

New:

| Key | English |
|---|---|
| `messages.traceroute_strip_label` | `Traceroute path` |
| `messages.traceroute_leg_forward` | `Forward` |
| `messages.traceroute_leg_return` | `Return` |
| `messages.traceroute_hop_snr` | `{{snr}} dB` |
| `messages.traceroute_snr_unknown` | `Unknown SNR (MQTT-bridged hop, decrypt failure, or old firmware)` |
| `messages.traceroute_unknown_node` | `Unknown` |
| `messages.traceroute_node_label` | `{{name}}, {{role}}, {{id}}` |
| `messages.traceroute_no_response` | `No response received` |
| `messages.traceroute_no_return_path` | `No return path data` |

`traceroute_leg_forward`/`_return` exist for the visually-hidden lane captions
(the existing `traceroute_forward`/`_return` values carry a trailing colon and
are wrong for that use).

---

## 7. Test plan

All tests are standard Vitest files in the existing suite. **No standalone
scripts.** Node-environment for the pure utils; `/** @vitest-environment jsdom */`
for components.

| File | Env | Template | Covers |
|---|---|---|---|
| `src/utils/tracerouteStrip.test.ts` | node | `src/utils/tracerouteSegments.test.ts` | **All 21 cases in §3.7**, one `it()` each, named after the case. Plus `layoutTracerouteStrip`: center/width/height arithmetic, row-crossing polyline has 3 points, forward label anchors above / return below, `compact` option scales every dimension. |
| `src/utils/tracerouteStripMeta.test.ts` | node | any util test | shortName/longName/nodeId fallbacks; `getEffectiveHops` passthrough per calculation mode; unmessagable flag; node absent from `nodes` produces no entry; no O(n²) `find` (assert by building a 1,000-node array and a 3-hop graph — a smoke perf guard, not a benchmark). |
| `src/components/traceroute/NodeGlyph.test.tsx` | jsdom | `src/components/HopCountDisplay.test.tsx` | Glyph category → SVG contains the expected silhouette marker (`repeaterTowerSvg`'s `<rect x="19" y="32"` for repeater family, the person path for companion); `standard` category falls back to `plainNodeDiscSvg` (a disc, not empty); `unknown` renders the placeholder; `unmessagable` adds the badge and omitting it does not; `color` reaches the SVG stroke. |
| `src/components/traceroute/TracerouteStrip.test.tsx` | jsdom | `src/components/HopCountDisplay.test.tsx` | Renders N node elements for an N-node graph; shared node rendered **once** (query by short name, expect exactly 1); divergence case puts the branch node in row 1 (assert its computed `top` differs from a row-0 node); forward SNR label above and return below (assert the lane class); `snrUnknown` renders the "?" chip with its title; `snr === null` renders no label element; marker id is `useId`-suffixed (two strips on one page have different `marker-end` urls); every node is `tabIndex=0` and has an `aria-label` containing long name, role, and id; tooltip element exists in the DOM (not `display:none`) and is referenced by `aria-describedby`. |
| `src/components/map/markerIcons.test.ts` | node | itself | **Extend** (WP1): assert `roleGlyphMarkerSvg`/`getHopColor`/`roleGlyphInnerSvg` imported from `components/map/markerIcons` still produce output identical to the same functions imported from `utils/roleGlyphSvg` — the extraction guard. The existing byte-identical `createNodeIcon` fixtures already catch any accidental markup drift. |
| `src/components/MessagesTab.tracerouteStrip.test.tsx` | jsdom | **`src/components/MessagesTab.composeFocus.test.tsx`** (copy its full mock block: `useServerData`, `SettingsContext`, `MapContext`, `ToastContainer`, `useCsrfFetch`) | Integration: strip renders when `getRecentTraceroute` returns a row; **nothing renders** when `hasPermission('traceroute','write')` is false; the `messages.last_traced` age line still renders; pending badge for a fresh null-route row; failed badge for an old null-route row; a null-route row renders the "no response" text and no strip. |

Run before PR: `npm test` (full Vitest suite, 0 failures) and
`npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` (empty
output). No migration/schema work here, so the PG/MySQL containers are not
required.

---

## 8. Work packages

Sized for one Sonnet implementer each.

```
WP1 ─┐
     ├─► WP3 ──► WP4
WP2 ─┘
```

WP1 and WP2 are independent and **can run in parallel**. WP3 needs both. WP4
needs WP3.

> **Concurrency hazard (repo-specific):** if WP1 and WP2 run as parallel agents
> in this one worktree, `rtk`-wrapped `git commit` auto-stages the whole tree
> and each agent will sweep up the other's files. Either serialize the commits
> or use the pathspec form (`git commit -- <files>`), and audit the per-commit
> file list.

### WP1 — Leaflet-free glyph extraction

**Files:** `src/utils/roleGlyphSvg.ts` (new), `src/components/map/markerIcons.ts`,
`src/components/map/markerIcons.test.ts`.

**Do:** move `repeaterTowerSvg`, `roleGlyphInnerSvg`, `roleGlyphMarkerSvg`,
`unmessageableBadgeSvg`, `getHopColor` verbatim into the new module; export
`unmessageableBadgeSvg`; add `plainNodeDiscSvg` and `unknownNodeSvg`; re-export
everything from `markerIcons.ts`; add the extraction-guard test.

**Acceptance:**
* `npx tsc --noEmit` clean.
* Every existing importer of `markerIcons` is unmodified and its tests pass —
  especially the byte-identical `createNodeIcon` fixtures in
  `markerIcons.test.ts`.
* `src/utils/roleGlyphSvg.ts` contains no `import ... from 'leaflet'` and no
  React import, and carries the banner comment.
* `roleGlyphMarkerSvg` still returns `''` for the `standard` family (contract
  unchanged — `MapLegend` and `createNodeIcon` depend on it).
* No behavior change ships; zero UI diff.

### WP2 — Pure graph + layout util

**Files:** `src/utils/tracerouteStrip.ts` (new),
`src/utils/tracerouteStrip.test.ts` (new), `src/utils/tracerouteSegments.ts`
(export `parseHopArray`, `hasRouteData`, add `export const BROADCAST_ADDR = 4294967295`).

**Do:** implement §3 exactly — types, per-leg parse with the `buildLegSegments`
SNR pairing, the §3.3 filter, the §3.4 dedup/divergence/column-insertion
algorithm, `graph.edges`, and `layoutTracerouteStrip`.

**Acceptance:**
* All 21 cases in §3.7 have a named passing test, plus the layout tests.
* No React, no Leaflet, no `DeviceInfo` import in the module.
* No new JSON parsing — `parseHopArray` is the only parse call.
* `formatTracerouteRoute` and `decomposeTraceroute` are **not** modified;
  `tracerouteSegments.ts`'s only diff is three added `export` keywords/consts.
* `npm test src/utils/traceroute` green (proves the segments export change broke
  nothing).

### WP3 — React components + CSS module + i18n

**Files:** `src/components/traceroute/{NodeGlyph,TracerouteStrip}.{tsx,module.css,test.tsx}`,
`public/locales/en.json`.

**Do:** implement §4 and §6. Depends on WP1's exports and WP2's types.

**Acceptance:**
* Component tests in §7 pass.
* No `src/styles/nodes.css` diff.
* No raw `fetch()`; no hardcoded emoji/Unicode icon stand-ins (CLAUDE.md
  `UiIcon` rule) — the node glyphs come from the SVG builders, and the "?"
  unknown-SNR chip matches the existing `formatSnrElement` precedent.
* SVG marker ids are `useId()`-suffixed; two strips on one page both draw
  arrowheads.
* Every new locale string is called with an English default.
* Renders correctly in a 320px-wide container: `.scroller` scrolls, the page
  body does not.

### WP4 — MessagesTab wiring + integration test

**Files:** `src/utils/tracerouteStripMeta.ts` (+ test),
`src/components/MessagesTab.tsx`,
`src/components/MessagesTab.tracerouteStrip.test.tsx` (new).

**Do:** implement §5. Hoist the graph/meta `useMemo` to component scope (the
IIFE cannot host a hook). Replace only the two `traceroute-route` divs.

**Acceptance:**
* Permission gate, age line, and pending/failed badges are behaviorally
  unchanged — proven by the new integration test, not by inspection.
* No new props on `MessagesTabProps`; no change to `getRecentTraceroute` or its
  call sites in `App.tsx`.
* `TracerouteBody`, `TracerouteHistoryModal`, `RouteSegmentTraceroutesModal`,
  `TracerouteWidget` have **zero diff**; `git diff --stat` proves it.
* Full `npm test` green, 0 failures.
* `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` is empty,
  and `eslint-baseline.json` is **not** regenerated (no rule count grows).
* Manual check in the dev container at `http://localhost:8080`: open a node with
  a recent traceroute in Node Details, in both full-width and split view;
  confirm dedup, the branch row on a diverging traceroute, arrow directions, SNR
  lanes, tooltips on hover and on Tab focus.

---

## 9. Open risks for the orchestrator

1. **§1.4 SNR pairing shift is a visible change.** Old and new screenshots will
   not match. Confirm this is wanted (it is a correctness fix, and the map
   already renders the corrected pairing).
2. **BROADCAST_ADDR treatment (§3.3) intentionally diverges from
   `isValidRouteNode`.** Chosen to preserve the current Node Details behavior
   ("Unknown" hop is shown). If the preference is to hide it, drop the special
   case and case 14 in §3.7 flips to "dropped".
3. **Both legs share one traceroute color** (`--ctp-pink`), with the return leg
   dashed. That mirrors `overlayColors.tracerouteForward === tracerouteReturn`.
   If the user wants two hues, that is a small CSS-module change, but it drifts
   from the map.
4. **Fixed-geometry layout** (no DOM measurement) is what makes the whole thing
   pure and testable. The cost is that a very long short name ellipsizes rather
   than widening its column.
