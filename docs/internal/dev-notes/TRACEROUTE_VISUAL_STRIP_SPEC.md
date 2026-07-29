# Traceroute Visual Strip — Implementation Spec (issue #4381)

**Branch:** `feature/4381-traceroute-visual-strip`
**Scope:** ONE PR. Node Details page only (`src/components/MessagesTab.tsx`, the
`traceroute-info` block at ~L1917–1985).
**Status:** implemented in PR #4392. §3 carries an in-place **spine-model
amendment** (see §0.4 and §3.4.0) made before that PR merged, in response to a
real mis-rendering caught against live mesh data; §10 holds its work packages.
§8 is the original PR's package list and is historical.

Replace the two plain-text route lines in the Node Details traceroute box with a
single left-to-right strip of Node-Map node icons, arrowed for direction, SNR
labelled, deduplicated across the forward and return legs, with the shared hops
forming a central **spine** and each leg's exclusive hops branching above
(forward) or below (return) it.

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
4. **Divergence — the spine model** (revised after PR #4392; supersedes the
   original "return-only nodes drop to a lower sub-row" wording). The middle
   row is the **spine**: only nodes present in **both** legs — the true
   overlap. Nodes in the **forward leg only** are raised **above** the spine;
   nodes in the **return leg only** are dropped **below** it. This mirrors the
   forward-SNR-above / return-SNR-below convention already in place, so
   "up = forward, down = return" reads consistently across the whole strip. A
   fully symmetric traceroute (the return leg is the exact reverse of the
   forward leg) still renders as **one flat row**, unchanged. See §3.4 for the
   algorithm and §3.4.0 for the live bug that forced the change.
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

/** Which of the three horizontal bands a node sits in.
 *  'spine'   = present in BOTH legs (the true overlap), or the only leg when
 *              just one leg exists.
 *  'forward' = forward-leg-exclusive; raised ABOVE the spine.
 *  'return'  = return-leg-exclusive; dropped BELOW the spine. */
export type StripLane = 'forward' | 'spine' | 'return';

/** Firmware placeholder for a relay-role hop that refused to self-identify. */
export const BROADCAST_ADDR = 4294967295; // re-exported from tracerouteSegments

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
   *  unused lane costs no vertical space (this is what keeps a symmetric
   *  traceroute one flat row, and a spine+return graph two rows with the
   *  spine at row 0 exactly as before this change).
   *  `layoutTracerouteStrip` keys its geometry off `row`; `lane` is for
   *  semantics, tests, and renderer class hooks. */
  row: number; // 0 | 1 | 2
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
   *  then the next, then the next. Deterministic because within one lane no
   *  two nodes share a column (§3.4 invariant I3). */
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

**Why `lane` + a derived dense `row`, and not a signed row or a fixed 0/1/2.**
Three options were on the table:

| Option | Rejected because |
|---|---|
| signed `row: -1 \| 0 \| 1` (spine = 0) | One field, natural sort — but it bakes the ugly `-1-3-140` into `StripNode.id`, and it leaves "row 0 = spine" as an unwritten convention exactly like the "row 0 = primary leg" convention that produced this bug. It also needs a data-dependent origin (`row - minRow`) in the layout anyway, so it saves nothing there. |
| fixed `row: 0 \| 1 \| 2` (spine always = 1) | A symmetric traceroute would reserve an empty row 0 and an empty row 2, so the flat-row case grows two rows of dead space — it breaks decision §0.4's "still renders as one flat row, unchanged". Compacting it back makes `row` data-dependent again, i.e. the option below with worse names. |
| **`lane` (semantic) + `row` (dense, derived)** — chosen | `lane` names the invariant that was previously implicit, so no future reader can confuse "main row" with "spine". `row` stays a non-negative dense index, so `layoutTracerouteStrip`'s existing arithmetic (`topBand + row * rowHeight`), the existing `nodes` sort, and the existing `height` formula are **unchanged**, and unoccupied lanes cost nothing. `id` keys off `lane`, so ids are stable when lane occupancy changes — load-bearing, since `layout.centers` keys off `id`. |

The two fields must never disagree. `buildGraphCore` is the only writer and
assigns `row` in one place, from a lane→row map computed after placement
(§3.4.4). Test fixtures that hand-build a `TracerouteStripGraph` literal set
both; `layoutTracerouteStrip` reads only `row`, so such a fixture stays valid.

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

### 3.4 Step 3 — the spine, dedup, and divergence

#### 3.4.0 Why this was rewritten (the live bug)

The original design was **asymmetric**: it put the *primary* (forward) leg
wholly on row 0 and lifted only **return**-exclusive nodes to a branch row. It
never considered a forward-exclusive node. A real traceroute off the dev mesh:

```
forward: Yble -> Yrze -> CS (SW SECTOR) V4 -> TRPK G2 -> BOCA G2   snrTowards [42,-45,29,15]
return:  BOCA G2 -> Yrze -> Yble                                    snrBack    [37,44]
```

`CS` and `TRPK` are forward-only. Under the old rule all five nodes landed on
row 0, and the return edge `BOCA -> Yrze` was drawn as one long straight line
running underneath `CS` and `TRPK` — reading as though the return path
traversed them. It does not. The visualization made the one claim it exists to
make ("these two paths overlap here") and made it **wrong**.

The fix is to stop privileging either leg.

#### 3.4.1 The spine model

**Row 0 is no longer "the primary leg". The middle band is the SPINE: exactly
the nodes present in BOTH legs.**

* forward-leg-exclusive nodes are **raised above** the spine (`lane: 'forward'`)
* return-leg-exclusive nodes are **dropped below** it (`lane: 'return'`)

This mirrors the SNR label convention (forward above / return below) that was
already there, so the whole strip reads "up = forward, down = return". A
symmetric traceroute — the overwhelmingly common case, where the return leg is
the exact reverse of the forward leg — has an all-shared spine and **still
renders as one flat row**, byte-identical to today.

For the example above the required result is: spine `[Yble, Yrze, BOCA G2]`,
`CS` and `TRPK` raised between the `Yrze` and `BOCA G2` columns, and the return
edge `BOCA -> Yrze` running cleanly along the spine as a same-row segment.

**What is preserved from the old algorithm** (this is a generalization, not a
rewrite — reviewers should see a diff, not a new file):

* the per-leg parse + SNR pairing (§3.2) and the hop filter (§3.3) — untouched;
* the 1:1 correspondence between a leg's filtered `hops[k]` and its
  `StripNode` sequence element `k`, which is what makes §3.5's SNR indexing
  work — untouched;
* first-occurrence-wins dedup;
* the unknown-hop dedup exemption (§3.4.3) — load-bearing, do not weaken;
* the anchor / maximal-run / `insertColumns` machinery, including all four
  anchor cases (both / leading / trailing / neither);
* the monotone-column placement rule that stops branch edges crossing;
* `graph.nodes` sorted by (row, col); ids assigned only after placement;
  edges built only after ids.

**What changes:** the run machinery now runs **twice** — once for the forward
leg and once for the return leg, both against the spine — instead of once for
"the secondary leg against the primary leg".

#### 3.4.2 Orientation

The spine is laid out in the **forward leg's** traversal order, left to right.
The return leg therefore travels **right to left** across the same axis; its
arrowheads point left. That is correct and is the whole reason arrowheads (not
just position) carry direction.

When **only the return leg exists**, there is no forward order to inherit, so
the spine is laid out in the return leg's own traversal order (left =
`toNodeNum`) — unchanged from today (§3.7 case 7).

Lane and label assignment is by **leg identity, never by direction**: forward
labels/nodes always above, return labels/nodes always below, even in the
return-only case where the return leg reads left→right.

#### 3.4.3 Spine construction

```
sharedNums = { h.nodeNum : h in forward.hops, !h.isUnknown }
           ∩ { h.nodeNum : h in return.hops,  !h.isUnknown }

spine = forward.hops
          .filter(h => sharedNums.has(h.nodeNum) && !h.isUnknown)
          .filter(first occurrence of each nodeNum)      // first-occurrence-wins
```

Each surviving hop becomes a `StripNode` with `lane: 'spine'`, `col` = its
ordinal in `spine`, `legs: ['forward', 'return']`, `shared: true`. Build
`spineAnchor: Map<nodeNum, StripNode>` from it — the single anchor map both
legs resolve against (this replaces `mainCol`).

When only the return leg exists, substitute `return.hops` for `forward.hops`
above and drop the intersection (§3.4.5).

**Unknown hops can never be spine nodes.** A hop flagged `isUnknown` (i.e.
`BROADCAST_ADDR`) is excluded from `sharedNums`, never registered in
`spineAnchor`, and never resolves to one when walking a leg. It is therefore
**always leg-exclusive** and always lands on a branch lane.

Rationale (unchanged, and still load-bearing — see §1.4 and §3.3):
`BROADCAST_ADDR` is not a node identity, it is the firmware's "a hop happened
here and nobody recorded who" placeholder, written by `insertUnknownHops()`.
Both legs of a single traceroute routinely carry one whenever any relay in the
path runs firmware old enough not to participate in path recording. Deduping
two of them would render a **shared node that does not exist** — and "these
two paths overlap here" is the single claim this whole visualization is
making. Two independent unknowns are exactly the case where that claim cannot
be supported. §3.7 case 22 asserts this (an unknown hop in each leg must land
on **opposite** branch lanes), including that genuine endpoint dedup still
works in the same graph.

#### 3.4.4 Per-leg walk: anchors and runs

Run this for the forward leg first (in forward traversal order), then for the
return leg (in return traversal order). The order matters only for column
packing determinism; fix it and document it.

For each hop of the leg, in order:

```
anchor = (hop.isUnknown || alreadyAnchoredInThisLeg(hop.nodeNum))
           ? undefined
           : spineAnchor.get(hop.nodeNum)
```

* **Anchored** → flush any pending run against this anchor, then push the
  existing spine `StripNode` onto this leg's sequence and remember it as
  `prevAnchor`. Do not append to `legs` — a spine node already carries both
  (but in the single-leg case, `legs` stays the one leg).
* **Unanchored** → accumulate into the current maximal run.

`alreadyAnchoredInThisLeg` is **first-occurrence-wins applied per leg**: the
first hop in a leg that matches a spine node claims it; a later repeat of the
same node number *within the same leg* (a loop) is treated as unanchored and
gets its own branch node in that leg's lane. This preserves today's
first-occurrence-wins semantics and — importantly — keeps each leg's column
sequence monotone even when the physical route loops (§3.7 case 12).

Branch nodes get `lane: 'forward'` or `lane: 'return'` matching the leg being
walked, `legs: [thatLeg]`, `shared: false`.

#### 3.4.5 Placing a run (generalized to both lanes)

A run of length `k` in lane `L` is bounded by the anchor before it (column `a`,
undefined if the run starts the leg) and the anchor after it (column `b`,
undefined if the run ends the leg).

```
freeCols(L, lo, hi) = [ c : lo < c < hi, no node of lane L currently at column c ]

case both anchors defined:
    lo = min(a, b); hi = max(a, b)
    free = freeCols(L, lo, hi)
    if free.length < k:
        deficit = k - free.length
        insertColumns(after = lo, count = deficit)  // shift EVERY node with col > lo
        // `lo` itself never moves (insertColumns shifts strictly-greater only),
        // so lo is still valid; hi and every already-placed branch node shift.
        recompute hi and free            // the new columns lo+1..lo+deficit are
                                         // free in EVERY lane by construction
    target = first k entries of `free`, ascending
    order  = source order when b > a (traversal left→right),
             reversed     when b < a (traversal right→left)
    assign order[i] -> target[i]
    // a === b (the leg returns to the same node) falls out of the same code:
    // free is empty, so k columns are inserted after lo.

case only `b` defined (run leads the leg):
    insertColumns(after = b - 1, count = k)    // prepend k columns before b
    re-read b (it just shifted); place at columns b-k .. b-1, in the order that
    puts the leg's first node furthest from `b`
    // when b === 0 this prepends at the far left; insertColumns(after = -1, …)
    // must be supported.

case only `a` defined (run trails the leg):
    base = current max column over ALL nodes
    place at base+1 .. base+k in source order

case neither defined (empty spine):
    the two legs share no node at all — see §3.4.8. Place the whole run in lane
    L starting at column 0, in source order. Do not throw.
```

`insertColumns(after, count)` mutates every already-assigned `StripNode.col`
greater than `after` by `+count`. It is unchanged from today except that it now
also has to shift branch nodes of the *other* lane. Keep it as one small
helper; it is where an off-by-one will hide.

**The `freeCols` refinement is the one genuinely new piece of placement logic.**
The old code computed `available = hi - lo - 1` — the raw column count between
the anchors — because only one lane could ever hold branch nodes, so nothing
else could already be sitting there. With two branch lanes and multiple runs
per leg, a column between `lo` and `hi` may already be occupied *in this lane*
by an earlier run. Counting it as available would place two branch nodes of the
same lane in the same column: overlapping glyphs and, worse, a **duplicate
`StripNode.id`** (ids are `${lane}-${col}-${nodeNum}`), which silently corrupts
`layout.centers`. Occupancy is checked **per lane** — a forward-lane node and a
return-lane node may share a column, and should, because they are on different
rows and packing them tightly keeps the strip narrow.

**Monotone ordering rule (restated, now for both lanes):** the placement order
must make each leg's column sequence **monotone** across a run — increasing for
a left→right traversal, decreasing for right→left — so branch edges never
cross each other. (A leg whose *anchors* are themselves out of spine order —
possible only when the physical route genuinely doubles back — can still
produce crossing edges. That is honest signal, not a layout bug; do not add
special handling.)

#### 3.4.6 Lane occupancy → the dense `row` index

After all placement:

```
occupied = lanes in top-to-bottom order ['forward', 'spine', 'return']
             that have at least one node
row(lane) = index of lane in `occupied`
```

So:

| Occupied lanes | rows |
|---|---|
| spine only (symmetric traceroute, or a single leg) | spine = 0 → **one flat row, unchanged from today** |
| spine + return | spine = 0, return = 1 → **numerically identical to today's row 0 / row 1** |
| spine + forward | forward = 0, spine = 1 |
| all three | forward = 0, spine = 1, return = 2 |
| forward + return, no spine (§3.6.5) | forward = 0, return = 1 |

An unoccupied lane costs no vertical space. That is the whole reason `row` is
dense rather than a fixed 0/1/2 (§3.1), and it is what preserves the existing
`height` arithmetic and the existing component test that asserts a return-only
branch node sits at `row === 1`.

#### 3.4.7 Invariants (assert these; §3.7 has generic tests for each)

* **I1 — lane containment.** Every `forward` edge's endpoints are in
  `{spine, forward}`; every `return` edge's endpoints are in `{spine, return}`.
  Holds by construction (a leg's sequence only ever contains spine nodes and
  its own lane's branch nodes). This is what guarantees no forward edge ever
  crosses below the spine, which in turn is what keeps the SNR label lanes
  clean (§3.5).
* **I2 — spine ⇔ shared.** In a two-leg graph, `node.shared === (node.lane === 'spine')`.
  In a single-leg graph every node is `lane: 'spine'`, `shared: false`.
* **I3 — per-lane column uniqueness.** No two nodes in the same lane share a
  column. (Guaranteed by `freeCols`. This is what makes `StripNode.id` unique.)
* **I4 — id uniqueness.** All `StripNode.id` values in a graph are distinct.
  Follows from I3, but assert it directly across every fixture — `layout.centers`
  silently loses nodes if it ever fails.
* **I5 — per-leg column monotonicity.** For each leg, consecutive elements of
  that leg's sequence have strictly monotone columns (increasing for forward,
  decreasing for return, when the spine came from the forward leg).
* **I6 — unknown hops are never spine nodes.** `node.isUnknown` ⇒
  `node.lane !== 'spine'` in any two-leg graph.

**Ordering of `graph.nodes`:** sort by `row`, then `col` (unchanged). Note this
is also the DOM/tab order in the renderer, i.e. raised nodes are announced
before spine nodes. Accepted: it matches visual top-to-bottom reading. If that
ever becomes a complaint, fix it with a renderer-side sort, not by changing the
graph contract.

#### 3.4.8 Degenerate and single-leg cases

| Case | Behavior |
|---|---|
| **Neither leg present** | `isEmpty: true`, `nodes: []`. Unchanged (§3.7 case 1). |
| **Exactly one leg present** | There is nothing to diverge from, so **that leg IS the spine**: every hop becomes a `lane: 'spine'` node at its own ordinal column, `legs: [thatLeg]`, `shared: false`. One row. No anchor map is needed and no run machinery runs. This is byte-for-byte today's single-leg behavior, including repeated nodes within the leg (a loop) each getting their own spine column — a loop only becomes a *branch* when a second leg exists to define a spine (§3.4.4). |
| **Legs share only the endpoints** (every intermediate hop is leg-exclusive) | Spine = `[fromNodeNum, toNodeNum]` at columns 0 and 1. The forward run and the return run both land between those two anchors and both branch lanes are populated → three rows. Column insertion fires twice, and `freeCols` is what lets the forward and return runs share the same columns on different lanes rather than each demanding its own. This is a **normal**, expected shape, not an edge case — flood routing gives it regularly. |
| **Legs share nothing at all** (empty spine) | Structurally unreachable from `buildTracerouteStripGraph`: forward and return always share `fromNodeNum` and `toNodeNum`, and those endpoints are never filtered (§3.3). Reachable only via `buildStripGraphFromLegs` with hand-built input (§3.7 case 21). Behavior: **no spine lane at all**; the forward leg is placed wholly in the `forward` lane from column 0, the return leg wholly in the `return` lane from column 0. Dense rows → forward = 0, return = 1. Do not throw. The two rows sit adjacent with no middle band; the absence of a spine is itself the (honest) message. |
| **`fromNodeNum === toNodeNum`** | Degenerate self-path. Must not crash or loop. With one leg it is two spine nodes / two columns (§3.7 case 20's note: "single row", not "single column"). With both legs present the two endpoints are the same node number, so the spine has **one** node (first-occurrence-wins collapses them) and each leg's second endpoint hop is a repeat → an unanchored trailing run in that leg's own lane. Assert only "does not throw / terminates"; the exact columns are not a contract. |
| **A leg whose every hop is `isUnknown`** | Impossible — endpoints are never `BROADCAST_ADDR`-flagged (§3.3 only flags intermediates). |

### 3.5 Step 4 — edges and SNR labels

For each leg, for every consecutive pair `(p[k-1], p[k])` in that leg's
`StripNode` sequence (which mixes spine nodes and that leg's own branch-lane
nodes — never the *other* leg's lane, invariant I1):

```
raw     = leg.rawSnr[k]                        // arrival SNR at p[k]
scaled  = raw === undefined ? undefined : raw / 4
unknown = scaled !== undefined && isUnknownSnr(scaled)
snr     = (scaled === undefined || unknown) ? null : scaled
```

Emit `{ id: `${leg}:${fromId}>${toId}`, leg, fromId, toId, snr, snrUnknown: unknown }`.

`graph.edges` = all forward edges in source order, then all return edges in
source order. **Unchanged**: because §3.4.4 still emits exactly one sequence
element per filtered hop, `leg.rawSnr[k]` still lines up with `sequence[k]`,
so none of the SNR indexing moves.

**Edge shapes are now four, not two.** Previously every row-crossing edge was a
return edge. Now:

| Edge | Endpoints | Shape |
|---|---|---|
| spine ↔ spine | same row | 2-point segment |
| spine ↔ forward-lane | crossing (spine row ↔ row above) | 3-point dog-leg |
| forward-lane ↔ forward-lane | same row | 2-point segment |
| spine ↔ return-lane | crossing (spine row ↔ row below) | 3-point dog-leg |
| return-lane ↔ return-lane | same row | 2-point segment |

Geometry for both shapes is unchanged from §3.6; only the set of edges that
takes the crossing branch grows.

#### 3.5.1 Where an SNR label anchors

The old rule ("midpoint of the path, offset −14px for forward / +14px for
return", later refined to `±labelOffset(o)`) derives the offset from a node's
half-height **on a single row**. With three rows that is not enough: a label
placed `labelOffset` above a spine node lands in the band the *forward lane*
now occupies, and a crossing edge's midpoint sits between two rows where a flat
offset drops the label straight into one of them.

New rule, entirely in `layoutTracerouteStrip` (still pure arithmetic):

```
labelAnchor.x = midpoint x of the edge's rendered path      // unchanged
labelAnchor.y =
   same-row edge   : rowCenterY(row) + laneSign * labelOffset(o)
   crossing edge   : (rowCenterY(upperRow) + rowCenterY(lowerRow)) / 2
                     // i.e. the middle of the inter-row gap
where laneSign = -1 for leg 'forward', +1 for leg 'return'
```

`y` is computed from **row centers**, not from the (lane-offset-translated)
path, so `LANE_OFFSET` no longer perturbs label placement and the clearance
arithmetic is exact. `x` still comes from the path, so a purely vertical chord's
two legs still get horizontally separated labels.

**Why this keeps "forward reads above, return reads below" without collisions.**
By invariant I1 a forward edge only ever touches the spine and the lane *above*
it, and a return edge only the spine and the lane *below* it. So:

* a forward crossing-edge label lands in the forward↔spine gap — above the
  spine, i.e. still in forward territory;
* a return crossing-edge label lands in the spine↔return gap — below the spine;
* **no forward-leg label can ever appear below the spine row, and no return-leg
  label above it.** That is the invariant to assert, and it is stronger and more
  meaningful than the old "forward y < row center" check.

#### 3.5.2 Clearance invariants the layout must satisfy

These generalize the existing arithmetic guards in
`tracerouteStrip.test.ts` (the `SNR label collision avoidance` describe block)
rather than replacing them — **extend those tests, do not delete them.**

Let `nodeHalfHeight = (glyphSize + NODE_NAME_GAP + nameHeight) / 2` and
`labelOffset = nodeHalfHeight + LABEL_HALF_HEIGHT + LABEL_CLEARANCE`
(both already implemented, unchanged).

* **C1 — universal label/node clearance.** For every edge label anchor `L` and
  every node `N` in the graph: `|L.y − center(N).y| >= labelOffset`.
  Equivalently, the label's box clears every node's box (glyph + gap + short
  name) by at least `LABEL_CLEARANCE` vertically. This single assertion
  subsumes the two existing per-config guards and extends cleanly to three
  rows; write it as a helper run over **every** §3.7 fixture.
* **C2 — band clearance (existing, unchanged).** `topBand >= labelOffset + LABEL_HALF_HEIGHT`
  and likewise `bottomBand`, enforced by the existing `minBand()` floor, so a
  label on the outermost row keeps its own far edge inside the canvas.
* **C3 — inter-row clearance (new).** `rowHeight >= 2 * labelOffset`. This is
  exactly the condition that makes C1 hold: a same-row forward label sits
  `labelOffset` above its row and must still clear the row above it
  (`rowHeight − labelOffset >= labelOffset`), and a crossing label at the gap
  midpoint sits `rowHeight / 2` from each endpoint row. Enforced by a
  `minRowHeight()` floor mirroring the existing `minBand()` floor — see §3.6.

C3 is the reason the default `rowHeight` rises from 56 to 76 (§3.6). It is not
cosmetic: at 56, with the default glyph/name sizes, `2 * labelOffset = 72`, so
a forward label on the spine would sit inside the raised node above it.

### 3.6 Step 5 — layout (also pure, same module)

```ts
export interface StripLayoutOptions {
  /** Column pitch in px. */
  colWidth: number;        // default 64
  /** Vertical pitch between adjacent occupied rows, px.
   *  Floored at `2 * labelOffset` — see §3.5.2 C3. */
  rowHeight: number;       // default 76   (was 56 before the spine model)
  /** Glyph edge length in px. */
  glyphSize: number;       // default 32
  /** Height reserved for the short-name line rendered below each glyph, px.
   *  A node's real footprint is glyph + gap + name, centered as ONE flex
   *  column on `center` — see the banner in tracerouteStrip.ts. */
  nameHeight: number;      // default 14
  /** Height reserved above the TOPMOST occupied row for its SNR lane +
   *  tooltips, px. Floored at `minBand()`. */
  topBand: number;         // default 44
  /** Height reserved below the BOTTOMMOST occupied row, px. Floored likewise. */
  bottomBand: number;      // default 44
}

export interface StripPoint { x: number; y: number }

export interface StripLayout {
  width: number;
  height: number;
  /** StripNode.id -> glyph CENTER, in the container's coordinate space. */
  centers: Map<string, StripPoint>;
  /** Per-edge polyline through 2+ points, already offset off the glyph
   *  edges so the arrowhead lands on the rim, not under the icon,
   *  translated into its leg's lane, and routed around unrelated glyphs
   *  (#4428). */
  edgePaths: Map<string, StripPoint[]>;
  /** Where each edge's SNR label anchors (§3.5.1). */
  labelAnchors: Map<string, StripPoint>;
}

export function layoutTracerouteStrip(
  graph: TracerouteStripGraph,
  opts?: Partial<StripLayoutOptions>,
): StripLayout;
```

Geometry stays **fixed and arithmetic** — no DOM measurement, no
`ResizeObserver`, no font metrics. That purity is the whole reason this is
unit-testable on numbers, and it is not negotiable.

**Band and row arithmetic.**

```
rowHeight  = max(opts.rowHeight,  minRowHeight(o))   // NEW floor: 2 * labelOffset(o)
topBand    = max(opts.topBand,    minBand(o))        // existing floor
bottomBand = max(opts.bottomBand, minBand(o))        // existing floor
rowCount   = maxRow + 1                              // = number of OCCUPIED lanes

center(node) = { x: node.col * colWidth + colWidth / 2,
                 y: topBand + node.row * rowHeight + glyphSize / 2 }
width  = columns * colWidth
height = topBand + rowCount * rowHeight + bottomBand
```

Every one of those formulas is **unchanged**. What changed is only that `row`
now ranges over 0..2 and `rowCount` over 1..3, and that `rowHeight` gained a
floor. In particular the bands do **not** grow to hold a raised row: a raised
row is a *row*, counted by `rowCount`, so `topBand` still reserves only the
label lane (plus tooltip room) above the topmost occupied row and `bottomBand`
only the label lane below the bottommost. That is precisely why `row` is a
dense index (§3.1) — a graph with no forward-exclusive nodes must not pay for
an empty band, or the common symmetric strip would visibly grow.

Worked example — the §3.4.0 BOCA G2 fixture at defaults: lanes forward + spine
occupied, `rowCount = 2`, `columns = 5` →
`width = 320`, `height = 44 + 2*76 + 44 = 240`. Spine sits at
`y = 44 + 1*76 + 16 = 136`; the raised `CS`/`TRPK` at `y = 60`.

**Edge paths.**
* Same-row edge → straight segment between the two centers, both ends pulled in
  by `glyphSize / 2 + EDGE_RIM_MARGIN` (= `+3`) along the segment.
* Row-crossing edge → 3-point polyline: start rim, elbow at
  `{ x: (x0+x1)/2, y: max(y0,y1) }`, end rim. Straight dog-legs, not beziers —
  easier to read at this pitch and trivially assertable.
* Then the whole path (2 or 3 points) is translated by
  `canonicalPerpendicular(c0, c1) * LANE_OFFSET * (leg === 'forward' ? +1 : -1)`.
* **Glyph routing (#4428).** The translated path is then bent around every
  OTHER node's clearance circle, radius
  `edgeClearance = glyphSize/2 + EDGE_RIM_MARGIN + LANE_OFFSET` — an edge
  spanning non-adjacent columns, or a dog-leg grazing a glyph, must not render
  through nodes it doesn't terminate at. Two bounded, deterministic phases in
  `routeAroundGlyphs`: (1) an elbow inside a circle is pushed radially out
  past it; (2) any segment still cutting a circle gets a bend inserted just
  past the rim (`+ BEND_MARGIN`) at its deepest point. Both phases push
  radially — the side the lane-translated path already favors — falling back
  to the leg's lane direction when degenerate, so forward detours stay above
  and return detours below. Result stays a plain `<polyline>`; paths are
  therefore **2+ points**, not just 2 or 3.

**`LANE_OFFSET = 5` and `canonicalPerpendicular` are preserved exactly as they
are.** They exist because the forward and return legs routinely traverse the
*identical* chord in opposite directions — which, under the spine model, is now
even more common (a symmetric traceroute is entirely spine↔spine chords walked
both ways). The canonicalization ("up" defined as `y <= 0`, sign taken from the
chord's canonical direction rather than the edge's traversal direction) is what
makes lane assignment follow **leg identity, not direction** — the same rule
`laneSign` follows in §3.5.1. The `dx === 0` branch (two nodes in the same
column on different rows) is only reachable from hand-built fixtures and has a
dedicated test; keep it.

**Label anchors:** §3.5.1. Note the anchor `y` is now derived from row centers,
so it is independent of `LANE_OFFSET` — that row-band rule is also what makes
the C1 invariant hold, so #4428 never moves a label vertically. The anchor `x`
(#4428) samples the FINAL routed path: the midpoint of the longest segment
whose midpoint clears every glyph circle by
`labelClearRadius = glyphSize/2 + LABEL_HALF_HEIGHT + LABEL_CLEARANCE`
(ties → the earlier segment; deterministic), with a horizontal-only nudge as a
last resort. For an un-detoured same-row edge this IS the old endpoint
midpoint, so plain strips are pixel-identical; on a detoured edge it moves the
label off the bend and off the avoided glyph's column. X still comes from the
translated path, which is what separates the two legs' labels on a vertical
chord.

This function is unit-tested on numbers only — no rendering required.

### 3.7 Edge cases the util MUST handle (each gets a named test)

`src/utils/tracerouteStrip.test.ts` currently holds **22 numbered cases** (this
table historically listed 21; case 22 was added with the unknown-hop dedup
exemption and never backfilled here — it is now included) plus 10 layout tests
across three `describe` blocks. Every one is triaged below. **Nothing is
deleted**; the geometry-clearance guards and the vertical-chord
`canonicalPerpendicular` test are explicitly preserved.

Status legend: **KEEP** = passes unchanged, no edit; **ANNOTATE** = passes
unchanged, add a `lane` assertion so the new model is actually covered;
**REWRITE** = row/column expectations are invalidated by the spine model;
**RETUNE** = geometry numbers move because of the `rowHeight` floor.

#### Cases 1–22

| # | Input | Status | Expected under the spine model |
|---|---|---|---|
| 1 | `route = null` and `routeBack = null` | KEEP | `isEmpty: true`, `nodes: []`, `edges: []`, `columns: 0`, `hasForward/hasReturn: false` |
| 2 | `route = 'null'` (the string) | KEEP | Same as (1) for that leg |
| 3 | `route = ''` | KEEP | Same as (1) for that leg |
| 4 | `route = '[]'`, `snrTowards = '[]'` | ANNOTATE | Single leg ⇒ it IS the spine: 2 nodes (`lane: 'spine'`, `shared: false`), 1 edge, `snr: null` |
| 5 | `routeBack = '[]'`, `snrBack = '[]'` | KEEP | Return leg suppressed (#2051/#3622); forward-only ⇒ spine |
| 6 | Forward only (`routeBack` null) | ANNOTATE | One row, all `lane: 'spine'`, forward edges only, labels above |
| 7 | Return only (`route` null) | ANNOTATE | One row in the RETURN leg's order (left = `toNodeNum`), all `lane: 'spine'`, labels **below**. Confirms §3.4.2's single-leg orientation rule |
| 8 | Direct, both legs (`route`/`routeBack` = `'[]'`, `snrBack = '[-40]'`) | ANNOTATE | 2 spine nodes, both `shared`, 1 row, 2 edges, distinct ids, opposite arrowheads |
| 9 | Identical forward and return paths | ANNOTATE | **The symmetric-stays-flat guard.** Exactly `n` nodes, all `shared: true`, all `lane: 'spine'`, `2(n-1)` edges, **one row**, no branch lane occupied. Extend to a 4-node path so it is not trivially satisfiable |
| 10 | `F = A→B→C→D`, `R = D→E→A` | **REWRITE** | Spine = `[A, D]` only. `B`,`C` **raised** (`lane: 'forward'`, cols 1,2 after 2 inserted columns); `E` **dropped** (`lane: 'return'`, col 1); `D` at col 3; `columns: 4`; **three rows** (forward 0, spine 1, return 2). Forward edges `A→B` and `C→D` now cross rows too — that is the whole fix |
| 11 | `F = A→B→C`, `R = C→X→Y→A` | **REWRITE** | Spine = `[A, C]`. `B` raised to `lane: 'forward'` col 2; `X`,`Y` dropped to `lane: 'return'` at cols 2,1 (reversed placement, right→left traversal); `C` ends at col 3; `columns: 4` (unchanged number, different meaning); three rows. Keep the existing monotonicity assertions `C.col > X.col > Y.col > A.col` |
| 12 | Loop within one leg `route = [B, C, B]`, `routeBack = [B]` | **REWRITE** | Spine = `[FROM, B, TO]` (first-occurrence-wins). `C` and the **second** `B` become `lane: 'forward'` branch nodes at cols 2,3; `TO` shifts to col 4; `columns: 5`; two rows (forward + spine). Keep asserting first-`B` is `shared`/spine and second-`B` is not, and that all edge ids stay distinct |
| 13 | Reserved nodes `route = [2, 999, 255, 65535, 1234]` | KEEP | Single leg; filtering and **unshifted SNR** assertions are untouched by this change |
| 14 | `BROADCAST_ADDR` in route (forward only) | ANNOTATE | Kept, `isUnknown: true`, gets its edge + SNR. Single leg ⇒ `lane: 'spine'` — assert this explicitly: the "unknown is never a spine node" rule (I6) is about **cross-leg dedup**, and a one-leg graph has no dedup to do |
| 15 | `snrTowards` SHORTER than the hop list | KEEP | `snr: null`, `snrUnknown: false` |
| 16 | `snrTowards` LONGER than the hop list | KEEP | Extra entries ignored; index `route.length` IS used |
| 17 | `snrTowards` contains `-128` | KEEP | `snr: null`, `snrUnknown: true` |
| 18 | Malformed JSON (`route = '{'`) | KEEP | `parseHopArray` → `[]`; leg still emitted as direct |
| 19 | Non-array JSON (`route = '5'`) | KEEP | Same as (18) |
| 20 | `fromNodeNum === toNodeNum` | KEEP | Forward-only variant: 2 spine nodes, 2 columns, one row, no throw. Keep the existing comment explaining "single ROW, not single column" |
| 21 | Legs sharing no node (hand-built, `buildStripGraphFromLegs`) | ANNOTATE | **No spine at all.** Forward leg wholly `lane: 'forward'` from col 0, return leg wholly `lane: 'return'` from col 0, rows 0 and 1, `columns: 2`, no throw. The existing `row === 1` / `col === 0` assertions still hold; add the lane assertions and one asserting `graph.nodes.every(n => n.lane !== 'spine')` |
| 22 | `BROADCAST_ADDR` in **both** legs | **REWRITE** | Two distinct `StripNode`s, neither `shared`, now on **opposite branch lanes**: the forward unknown is `lane: 'forward'` (row 0), the return unknown `lane: 'return'` (row 2), spine `[FROM, TO]` at row 1. The old assertion `returnUnknown.row === 1` becomes `=== 2`; assert on `lane`, not `row`. Keep the "genuine endpoint dedup still works" tail assertion |

#### New cases

| # | Input | Expected |
|---|---|---|
| 23 | **The BOCA G2 fixture — use it verbatim, it is the motivating bug.** `fromNodeNum` = Yble, `toNodeNum` = BOCA G2, `route = [Yrze, CS (SW SECTOR) V4, TRPK G2]`, `snrTowards = [42,-45,29,15]`, `routeBack = [Yrze]`, `snrBack = [37,44]` | Spine = `[Yble, Yrze, BOCA G2]` at cols 0, 1, 4. `CS` and `TRPK` are `lane: 'forward'` at cols 2, 3. **No return-lane node.** Two rows (forward 0, spine 1). `columns: 5`. The critical assertion: the return edge `BOCA G2 → Yrze` connects two **spine** nodes on the **same row** (`fromNode.row === toNode.row`), i.e. it no longer passes underneath `CS`/`TRPK`. Assert the forward SNRs land on the right edges too (10.5, −11.25, 7.25, 3.75) so the §1.4 pairing stays covered on a real payload |
| 24 | **Forward-only divergence, minimal.** `F = A→B→C`, `R = C→A` (fixture: `route = '[B]'`, `routeBack = '[]'` **with** a non-empty `snrBack` — an empty `routeBack` and empty `snrBack` is suppressed by `hasReturnPath`, see case 5) | Spine `[A, C]` at cols 0 and 2; `B` is `lane: 'forward'` col 1, row 0; spine row 1; **no return lane**; `columns: 3`. Return edge `C→A` is a same-row spine segment. This is the shape the old algorithm got wrong in the small |
| 25 | **Simultaneous divergence.** `F = A→B→C`, `R = C→X→A` | Both branch lanes populated. Three rows. `row(B) < row(A) < row(X)`; `B.lane === 'forward'`, `X.lane === 'return'`. Assert `B` and `X` may share a column (per-lane occupancy, §3.4.5) without colliding ids |
| 26 | **Legs share only the endpoints, multi-hop each side.** `F = A→B→C→D`, `R = D→X→Y→A` | Spine `[A, D]`; two column insertions; `B`,`C` on the forward lane and `Y`,`X` on the return lane, each set monotone in its leg's traversal direction; three rows; assert the strip did not grow more columns than needed (the two branch runs reuse the same columns on different lanes) |
| 27 | **Unknown hops branch while a genuine shared intermediate stays on the spine.** `route = [BROADCAST_ADDR, M]`, `routeBack = [M, BROADCAST_ADDR]` | The strongest form of the I6 guard: spine = `[from, M, to]` at cols 0, 2, 3 — `M` is a real shared hop and **must** stay on the spine — while the forward unknown goes to `lane: 'forward'` col 1 and the return unknown to `lane: 'return'` col 1. Three rows, `columns: 4`. Case 22 asserts the exemption; this asserts it does not over-fire and drag real shared hops off the spine with it |
| 28 | **Invariant sweep.** Run every fixture in this file through one helper | Asserts I1 (lane containment), I3/I4 (per-lane column uniqueness, id uniqueness), I5 (per-leg column monotonicity), I6 (unknowns never on the spine in a two-leg graph). One `it()` per invariant, iterating a shared fixture list — this is what catches a regression in a case nobody thought to enumerate |

#### Layout tests

| Test | Status | Action |
|---|---|---|
| `computes center/width/height arithmetic from fixed defaults` | RETUNE | `rowHeight` default 56 → 76, so `height` becomes `44 + 1*76 + 44 = 164`. `width` and `centers` are unchanged |
| `gives a row-crossing edge a 3-point polyline` | REWRITE + EXTEND | The case-10 fixture now also produces **forward** crossing edges. Assert every spine↔branch edge (both legs) is a 3-point polyline and every same-lane edge is 2-point |
| `anchors the forward SNR label above the row and the return label below` | KEEP | One-row fixture; still passes with the §3.5.1 row-center rule. **Add** a three-row companion asserting the stronger invariant: no forward-leg label anchors below the spine row's center, no return-leg label above it |
| `scales every dimension when a compact-style options override is passed` | RETUNE | The preset's `rowHeight: 44` now falls under the C3 floor (`2 * labelOffset` = 61 for `glyphSize 24 / nameHeight 11`). Raise the preset to `rowHeight: 64` and keep asserting exact arithmetic (`40 + 64 + 40`); `centers` are unchanged |
| `guards the default (non-compact) layout` (clearance) | RETUNE | Keep the assertion, update the opts' `rowHeight` to a legal value. **Generalize** into the C1 helper (§3.5.2) and run it over every multi-lane fixture, not just the one-row one |
| `guards the compact layout — the exact config that overlapped in live deployment` | RETUNE | Same: keep the config's intent (it is a real regression), raise `rowHeight` to the floor |
| `bumps an under-sized custom topBand/bottomBand up to the safe minimum` | KEEP | Unchanged; `minBand()` is untouched |
| **NEW** `bumps an under-sized custom rowHeight up to the safe minimum` | ADD | Pass `rowHeight: 1` on a three-row graph and assert C1 still holds — the mirror of the band-floor test |
| `separates the forward and return edge paths between the same node pair` | KEEP | One-row fixture; `LANE_OFFSET` behavior unchanged |
| `keeps the row-crossing branch edge a 3-point polyline that stays clear of both glyphs` | RETUNE | Case-10 fixture; raise the explicit `rowHeight` in `opts` to a legal value. Assertions are all relative and stay as they are. Extend the edge selection from `leg === 'return'` to all crossing edges |
| `offsets forward/return lanes horizontally for a purely vertical chord (dx===0 branch)` | **PRESERVE** | Hand-built graph literal — add the required `lane` field to each node (`'spine'` and `'return'`). Every assertion stays. This is the **only** coverage of `canonicalPerpendicular`'s `dx === 0` branch; do not drop or rewrite it |

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
}
```

The component is a pure function of `(graph, meta)` — no contexts, no
hooks except `useTranslation`, `useId`, and one `useMemo` around
`layoutTracerouteStrip`. That is what makes it cheap to test.

There is no `compact` prop (#4381 follow-up): the only consumer never varied
it in a way that tracked the panel's actual rendered width, so it always
rendered at default size in practice — dead code, removed. Narrow containers
are handled by `.scroller`'s horizontal scroll (§4.4), not a layout-numbers
switch. `layoutTracerouteStrip` itself still accepts arbitrary
`Partial<StripLayoutOptions>` overrides — that capability isn't removed, just
no longer wired to a component prop.

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
      <div className={cx(styles.node, laneClass(n.lane))} style={{ left: center.x, top: center.y }}
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
* **Three rows require essentially no component change.** The component already
  derives every pixel from `layout.centers` / `layout.edgePaths` /
  `layout.labelAnchors` and never reads `StripNode.row`, so widening rows from
  two to three is absorbed entirely by the pure layout module. The only
  addition is a `lane` class on each node div —
  `styles.laneForward | styles.laneSpine | styles.laneReturn` — which mirrors
  the existing `.above`/`.below` pattern on SNR labels: an assertable hook and a
  home for any future visual differentiation, with **no** styling of its own
  today. Do not branch component logic on `lane`; if a raised node ever needs to
  look different, that is a CSS rule, not a code path.

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

**Narrow widths.** No `compact` mode (#4381 follow-up — see §4.3): the strip
always renders at default size, and `.scroller`'s horizontal scroll (above)
absorbs a genuinely narrow container. A `@media (max-width: 768px)` block in
the module shrinks `.shortName`'s font one step for small viewports; that rule
is independent of container width and stays.

**Lane hooks.** Add three empty rules alongside `.above`/`.below`:

```css
/* Lane identity hooks. Deliberately empty — the vertical position already
 * comes from the pure layout module (`top`), and both branch lanes must keep
 * the SAME glyph treatment as the spine so a raised node still reads as a
 * real hop. These exist as assertable class names and as the place any future
 * differentiation belongs. */
.laneForward,
.laneSpine,
.laneReturn {
  /* intentionally empty */
}
```

**Tooltip band.** `topBand` reserves vertical room so a tooltip anchored upward
from the **topmost** row stays inside `.canvas` and is not clipped by
`overflow-y: hidden`. Tooltips on lower rows also anchor upward, into the gap
between rows, which the C3 `rowHeight` floor (§3.5.2) has now widened. A
tooltip on the spine or return row can still overlap the row above it while
open; that is accepted (it is a transient hover/focus popup with `z-index: 20`,
and it paints over). If a *clipped* tooltip is observed, increase `topBand` /
`rowHeight` — do **not** switch the scroller to `overflow: visible` (that
reintroduces page-level horizontal scroll).

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
| `src/utils/tracerouteStrip.test.ts` | node | `src/utils/tracerouteSegments.test.ts` | **All cases in §3.7**, one `it()` each, named after the case — including the invariant sweep (case 28). Plus the layout tests triaged in §3.7's "Layout tests" table: center/width/height arithmetic, crossing edges are 3-point polylines, label lane containment, the `minBand()` and `minRowHeight()` floors, `LANE_OFFSET` separation, and the vertical-chord `canonicalPerpendicular` branch. |
| `src/utils/tracerouteStripMeta.test.ts` | node | any util test | shortName/longName/nodeId fallbacks; `getEffectiveHops` passthrough per calculation mode; unmessagable flag; node absent from `nodes` produces no entry; no O(n²) `find` (assert by building a 1,000-node array and a 3-hop graph — a smoke perf guard, not a benchmark). |
| `src/components/traceroute/NodeGlyph.test.tsx` | jsdom | `src/components/HopCountDisplay.test.tsx` | Glyph category → SVG contains the expected silhouette marker (`repeaterTowerSvg`'s `<rect x="19" y="32"` for repeater family, the person path for companion); `standard` category falls back to `plainNodeDiscSvg` (a disc, not empty); `unknown` renders the placeholder; `unmessagable` adds the badge and omitting it does not; `color` reaches the SVG stroke. |
| `src/components/traceroute/TracerouteStrip.test.tsx` | jsdom | `src/components/HopCountDisplay.test.tsx` | Renders N node elements for an N-node graph; shared node rendered **once** (query by short name, expect exactly 1); a **return**-only divergent node drops below the spine (assert `lane === 'return'` and a larger computed `top` than a spine node); a **forward**-only divergent node is raised above the spine (assert `lane === 'forward'` and a *smaller* `top` — the regression test for the §3.4.0 bug at the DOM level); forward SNR label above and return below (assert the lane class); `snrUnknown` renders the "?" chip with its title; `snr === null` renders no label element; marker id is `useId`-suffixed (two strips on one page have different `marker-end` urls); every node is `tabIndex=0` and has an `aria-label` containing long name, role, and id; tooltip element exists in the DOM (not `display:none`) and is referenced by `aria-describedby`. |
| `src/components/map/markerIcons.test.ts` | node | itself | **Extend** (WP1): assert `roleGlyphMarkerSvg`/`getHopColor`/`roleGlyphInnerSvg` imported from `components/map/markerIcons` still produce output identical to the same functions imported from `utils/roleGlyphSvg` — the extraction guard. The existing byte-identical `createNodeIcon` fixtures already catch any accidental markup drift. |
| `src/components/MessagesTab.tracerouteStrip.test.tsx` | jsdom | **`src/components/MessagesTab.composeFocus.test.tsx`** (copy its full mock block: `useServerData`, `SettingsContext`, `MapContext`, `ToastContainer`, `useCsrfFetch`) | Integration: strip renders when `getRecentTraceroute` returns a row; **nothing renders** when `hasPermission('traceroute','write')` is false; the `messages.last_traced` age line still renders; pending badge for a fresh null-route row; failed badge for an old null-route row; a null-route row renders the "no response" text and no strip. |

Run before PR: `npm test` (full Vitest suite, 0 failures) and
`npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` (empty
output). No migration/schema work here, so the PG/MySQL containers are not
required.

---

## 8. Work packages (original PR — historical)

> **These four shipped in PR #4392.** The spine-model follow-up has its own
> packages in **§10**; start there.

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
5. **The spine model makes two- and three-row strips much more common.**
   Previously only a return-exclusive hop forced a second row. Now any
   asymmetry does — including the very ordinary "the return took a shorter
   path" case. Symmetric traceroutes stay one flat row, but expect the Node
   Details box to be taller more often. This is the intended trade: the old
   flat rendering was *wrong* (§3.4.0), not merely compact.
6. **`rowHeight` default rises 56 → 76** (§3.5.2 C3) so an SNR label between
   two rows clears both. A two-row strip is ~40px taller than it would have
   been; a one-row strip is unchanged. If that reads as too airy, the lever is
   `nameHeight`/`glyphSize` (which shrink `labelOffset`, and therefore the
   floor), not overriding `rowHeight` below the floor — the floor is enforced.

---

## 10. Addendum A — spine model follow-up (post-#4392)

Three packages. **Strictly serial**: B needs A's `lane`/`row`, C needs B's
geometry.

```
WP-A ──► WP-B ──► WP-C
```

> **Do not run these as parallel agents in one worktree.** WP-A and WP-B touch
> the same file (`src/utils/tracerouteStrip.ts` and its test), and `rtk`-wrapped
> `git commit` auto-stages the whole tree — two agents will sweep up each
> other's half-finished edits. One implementer per package, one at a time. (A
> single implementer may reasonably take A+B together; the split exists to keep
> each review small, not because the files are separable.)

### WP-A — spine construction + dual-lane placement

**Files:** `src/utils/tracerouteStrip.ts` (graph half),
`src/utils/tracerouteStrip.test.ts` (the `buildTracerouteStripGraph` describe).

**Do:** implement §3.1 (types: `StripLane`, `lane`, dense `row`, `id` keyed on
lane), §3.4.1–§3.4.8. Generalize `flushRun`/`insertColumns` to run per leg
against the spine, add the per-lane `freeCols` occupancy check, and add the
per-leg first-occurrence anchor guard. Update the module banner — it currently
documents the primary/secondary model and would become actively misleading.

**Preserve verbatim:** §3.2 parsing, §3.3 filtering, the hop↔sequence 1:1
correspondence, the unknown-hop dedup exemption and its firmware rationale
comment, the `buildStripGraphFromLegs` test seam.

**Acceptance:**
* §3.7 cases 1–28 all have a named passing test with the statuses in that
  table (KEEP cases must pass with **zero edits** to their assertions —
  if a KEEP case needs editing, the implementation is wrong).
* The invariant sweep (case 28) passes over every fixture: I1, I3, I4, I5, I6.
* The BOCA G2 fixture (case 23) produces a same-row spine edge for
  `BOCA G2 → Yrze`.
* Case 9 extended to a 4-node symmetric path still yields exactly one row.
* No React, no Leaflet, no `DeviceInfo` import; no second JSON parser;
  `tracerouteSegments.ts` unchanged.
* `npx tsc --noEmit` clean.

### WP-B — layout geometry for three rows

**Files:** `src/utils/tracerouteStrip.ts` (layout half),
`src/utils/tracerouteStrip.test.ts` (the three layout `describe` blocks).

**Do:** implement §3.5.1 (row-center-derived label anchors, gap-midpoint for
crossing edges), §3.5.2 C1–C3, §3.6 (`minRowHeight()` floor, `rowHeight`
default 56 → 76, `rowCount` from occupied lanes). Retune the layout tests per
§3.7's "Layout tests" table.

**Preserve verbatim:** `LANE_OFFSET`, `canonicalPerpendicular` (including the
`dx === 0` branch and its dedicated test), `pullToward`, the 2-point/3-point
path construction, `minBand()`, `nodeHalfHeight()`/`labelOffset()`, and the
purity contract — no DOM measurement, no `ResizeObserver`, no font metrics.

**Acceptance:**
* The C1 clearance helper passes over **every** §3.7 fixture, at default opts,
  at the compact preset, and with deliberately under-sized `rowHeight`/bands.
* No forward-leg label anchors at or below the spine row's center; no
  return-leg label at or above it (three-row fixture).
* The vertical-chord `canonicalPerpendicular` test passes with only a `lane`
  field added to its fixture.
* `layoutTracerouteStrip` is still a pure function of `(graph, opts)`.

### WP-C — renderer, CSS hooks, and live verification

**Files:** `src/components/traceroute/TracerouteStrip.tsx`,
`TracerouteStrip.module.css`, `TracerouteStrip.test.tsx`.

**Do:** add the `laneForward`/`laneSpine`/`laneReturn` class hooks (§4.3, §4.4)
and the component tests in §7. Verify in the dev container against a real
diverging traceroute.

**Acceptance:**
* A forward-exclusive node renders with a **smaller** computed `top` than a
  spine node; a return-exclusive node with a larger one.
* No `src/styles/nodes.css` diff. No `compact` prop reintroduced.
* `TracerouteBody`, `TracerouteHistoryModal`, `RouteSegmentTraceroutesModal`,
  `TracerouteWidget` have **zero diff** (`git diff --stat` proves it).
* Manual check at `http://localhost:8080`, full-width **and** split view, on the
  BOCA G2 traceroute: `CS`/`TRPK` sit above the spine, and the
  `BOCA G2 → Yrze` return arrow runs along the spine without passing under
  them.
* Full `npm test` green, 0 failures;
  `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` empty;
  `eslint-baseline.json` **not** regenerated; `npm run typecheck:tests` still
  reports exactly 359 errors.
