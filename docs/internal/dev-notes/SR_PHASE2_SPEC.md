# Statistical Route Visualization — Phase 2 spec (UI integration)

**Epic:** `docs/internal/dev-notes/STATISTICAL_ROUTE_EPIC.md`
**Phase 1 design (consumed here):** `docs/internal/dev-notes/SR_PHASE1_SPEC.md` (D1–D11)
**Convention reference:** `docs/internal/dev-notes/TRS_PHASE2_SPEC.md` (the previous
epic's phase 2 — hook shape, i18n rules, MessagesTab coexistence rules 1–7)
**Branch/worktree:** `feature/statistical-route-phase2` in
`/home/yeraze/Development/meshmonitor-statroute-p2`

Phase 1 shipped the counting model and the union layout as pure modules. Phase 2
puts them on screen: a "Statistical" entry in the traceroute picker, a statistical
render mode in the strip, and the MessagesTab wiring that joins them.

---

## 0. Confirmed decisions (settled — do not re-litigate)

From the epic interview, already binding:

- Surface: a new option in the existing `TracerouteParticipationPicker`. No new
  panel, no map change.
- Data window: all stored pair history. No time filter, no window UI.
- Pair scope: local node ↔ selected conversation node, either direction, via the
  existing `GET /api/traceroutes/history/:from/:to`. No new endpoint, no schema change.
- Direction: combined undirected. One neutral lane, no arrowheads, no dashed return.
- Encoding: opacity by share, plus hover tooltips with "seen in X of N routes (P%)".
- Copy links: hidden in statistical mode.

From Phase 1, also binding:

- The renderer branches on `graph.mode === 'statistical'`. It never reads `leg` as a
  direction claim (D8).
- `node.id` is the canonical node reference (D10). Never `unknownDepth`, never
  `nodeNum` — several unknown hops share one `nodeNum` (`BROADCAST_ADDR`).

---

## 1. Reuse inventory (mandatory first read)

### 1.1 Must reuse — this phase builds on these, it does not replace them

| What | Where | How Phase 2 uses it |
|---|---|---|
| `buildStatisticalStrip(rows, local, peer, opts?)` | `src/utils/tracerouteUnionLayout.ts:370-380` | The one seam. MessagesTab calls it; nothing else builds a union. |
| `buildUnionStripGraph` / `layoutTracerouteUnion` | `src/utils/tracerouteUnionLayout.ts:162, 276` | `layoutTracerouteUnion` is called by the strip component; `buildUnionStripGraph` only through the seam. |
| `UnionStripGraph` / `UnionStripNode` / `UnionStripEdge` | `src/utils/tracerouteUnionLayout.ts:105-131` | The renderer's statistical types. They extend the strip's own types, so the `graph` prop needs no widening. |
| `statOpacity`, `MIN_STAT_OPACITY` | `src/utils/tracerouteAggregate.ts:75, 401` | Already applied — `node.opacity` / `edge.opacity` are precomputed. The renderer maps nothing. |
| `AggregateTracerouteRow` | `src/utils/tracerouteAggregate.ts:84-92` | The hook's output row type. Structural, so history rows satisfy it as-is. |
| `TracerouteStrip` | `src/components/traceroute/TracerouteStrip.tsx:137` | Extended with an internal mode branch. No prop added, no prop changed. |
| `NodeGlyph` | `src/components/traceroute/NodeGlyph.tsx:39` | Statistical glyphs are the same glyphs. No new glyph component. |
| `buildStripNodeMeta` | `src/utils/tracerouteStripMeta.ts:42` | Takes a `TracerouteStripGraph`; a `UnionStripGraph` is one. Used unchanged. |
| `NodeCard` + `IdentityItems`/`SignalItems`/`PositionItem`/`LastHeardFooter`/`NodeActions` | `src/components/map/popups/` (via `TracerouteStrip.tsx:30-32`) | The statistical node popup is the same card plus one row. |
| `.node-popup-*` global classes | used by `renderEdgeTooltip`, `TracerouteStrip.tsx:453-493` | The statistical edge tooltip and the seen-in row use the same markup. |
| `TracerouteParticipationPicker` | `src/components/traceroute/TracerouteParticipationPicker.tsx:63` | Gains three optional props. Every existing call stays valid. |
| `useNodeTraceroutes` | `src/hooks/useNodeTraceroutes.ts:20-34` | The template for the new hook: query key shape, `staleTime` 60s, `gcTime` 5min, `refetchOnWindowFocus: false`, `enabled` gated on a resolved sourceId. |
| `useResolvedSourceId` | `src/hooks/useResolvedSourceId.ts:41-56` | Same reason as `useNodeTraceroutes`: MessagesTab can mount outside a `SourceProvider`. |
| `ApiService.getTracerouteHistory` | `src/services/api.ts:845-855` | The transport. Signature keeps its shape; only its return type is tightened. |
| `UiIcon` | `src/components/icons` | Every icon in new markup. No emoji, no Unicode stand-in. |
| `calculateDistance` / `formatDistance` | `src/utils/distance` (via `TracerouteStrip.tsx:22`) | The statistical edge tooltip reuses `edgeDistanceKm` verbatim. |
| `messages.traceroute_*` keys | `public/locales/en.json:477-504` | Reused, not re-added: `traceroute_unknown_node`, `traceroute_node_label_separator`, `traceroute_edge_endpoints_label`, `traceroute_edge_distance_label`, `traceroute_picker_label`, `traceroute_picker_aria`. |
| MessagesTab rules 1–7 | `src/components/MessagesTab.tsx:769-814, 2011-2114` | Extended, not rewritten. Section 2.3 states exactly which rule each addition touches. |
| `MessagesTab.tracerouteStrip.test.tsx` mock block | `src/components/MessagesTab.tracerouteStrip.test.tsx:31-130` | Copy it for the new integration test. It is the canonical MessagesTab harness. |
| Inline CSS custom property pattern | `src/components/Dashboard/DashboardSidebar.tsx:505` | The precedent for `style={{ '--x': v } as React.CSSProperties}`. |

### 1.2 New surface, each justified against the closest existing thing

| New | Closest existing | Why a new one |
|---|---|---|
| `src/hooks/useTraceroutePairHistory.ts` | `useNodeTraceroutes` | Different endpoint, different key, different row shape. Same conventions throughout. |
| `isUnionStripGraph()` type guard | `isMeshCoreManager` / `isMeshtasticManager` (`src/server/sourceManagerTypes.ts`) | The project bans `instanceof` and `any` casts for narrowing; a named predicate is the house pattern. |
| `.statEdge` / `.statNode` CSS classes | `.forwardEdge` / `.node` | `.statEdge` joins the existing stroke rule rather than restating it. `.statNode` carries only the opacity var. |
| `messages.traceroute_stat_*` keys | `messages.traceroute_*` | New sentences. Everything reusable is reused (table above). |

### 1.3 Explicitly NOT touched

- `src/utils/tracerouteStrip.ts`, `tracerouteAggregate.ts`, `tracerouteUnionLayout.ts`
  logic. The only edit anywhere in Phase 1's modules is the exported type guard
  in `tracerouteUnionLayout.ts` (§3.1).
- `src/components/traceroute/TracerouteStrip.test.tsx` — the single-route suite stays
  byte-identical. Statistical cases go in a sibling file.
- `TracerouteCopyLinks.tsx` and its CSS/test — hidden by the caller, not by itself.
- `src/server/**` — no endpoint, no permission, no schema change.
- `src/styles/nodes.css` and every other global sheet.
- The map, the dashboard traceroute widget, `TracerouteHistoryModal`.

---

## 2. Design decisions

### D12 — Component API: no new prop; the renderer narrows `graph`

`UnionStripGraph extends TracerouteStripGraph` (D10), so a union graph is already
assignable to `TracerouteStripProps.graph`. The component narrows it internally:

```ts
const statGraph = isUnionStripGraph(graph) ? graph : null;
```

and swaps only the layout call inside the existing memo
(`TracerouteStrip.tsx:148`):

```ts
const layout = useMemo(
  () => (isUnionStripGraph(graph) ? layoutTracerouteUnion(graph) : layoutTracerouteStrip(graph)),
  [graph],
);
```

Rejected: a `statistical?: { graph, layout, totalRoutes }` prop. It would give the
component two graph inputs, two layout inputs, and a reachable state where they
disagree. It also contradicts D8/D10, which name `graph.mode` as the discriminant.

Consequence, and the reason this shape wins: **the single-route path adds zero props,
zero prop-type changes, and zero dependency-array changes.** Every one of the 50+
existing strip tests keeps compiling and passing untouched.

`totalRoutes` reaches every tooltip through `statGraph.totalRoutes`. Counts and shares
reach them through the node/edge objects the render loops already walk. No second map,
no lookup by `nodeNum` — D10 pinned `id` to the aggregate's `id` exactly so this works.

**MessagesTab discards the seam's `layout`.** `buildStatisticalStrip` returns
`{ union, graph, layout }`; the wiring uses `union.totalRoutes` and `graph`, and lets
the component recompute the layout. That keeps `TracerouteStrip` a pure function of
`(graph, meta)` — the invariant its module banner states — at the cost of one extra
arithmetic pass over a few dozen nodes inside a memo. Do not "optimize" this by
threading a `layout` prop.

**Glyph size invariant.** The component renders glyphs at `DEFAULT_GLYPH_SIZE = 32`
(`TracerouteStrip.tsx:114`) and `DEFAULT_LAYOUT_OPTIONS.glyphSize` is also 32
(`tracerouteStrip.ts:622-629`). MessagesTab must therefore call
`buildStatisticalStrip` with **no `opts`**. Passing custom layout options would move
the geometry without moving the glyphs.

### D13 — Pick state: one discriminated value, derived back into the old names

MessagesTab replaces `pickedTracerouteId` state with a single discriminated pick, then
derives the old name from it:

```ts
type TraceroutePick = { kind: 'entry'; id: number } | { kind: 'statistical' };

const [pick, setPick] = useState<TraceroutePick | null>(null);
const pickedTracerouteId = pick?.kind === 'entry' ? pick.id : null;
const statisticalPicked = pick?.kind === 'statistical';
```

Rejected: a numeric sentinel (`-1`) inside `pickedTracerouteId`. A magic number that
must never collide with a DB row id is a trap for the next reader.

Rejected: a second `useState<boolean>` beside `pickedTracerouteId`. Two states that
must stay mutually exclusive will eventually both be set.

Because `pickedTracerouteId` survives as a derived const, **rules 1, 2 and 3 keep their
exact expressions** (`MessagesTab.tsx:776-803`). Only the two `setPickedTracerouteId(null)`
calls become `setPick(null)`, and the picker's `onSelect` becomes
`id => setPick({ kind: 'entry', id })`.

### D14 — Rules: S1–S6, layered on rules 1–7

Rules 1–7 come from `TRS_PHASE2_SPEC.md §6.4` and live at `MessagesTab.tsx:769-814,
2011-2114`. Phase 2 adds six, and states for each which existing rule it touches.

**S1 — when the pair history is fetched (AMENDED — supersedes the original design below
the line).** The hook is enabled on cheap VALIDITY signals only, with no participation-
count precondition:

```ts
const statisticalFetchEnabled =
  hasPermission('traceroute', 'read') &&
  currentNodeNum != null &&
  pickerNodeNum != null &&
  currentNodeNum !== pickerNodeNum;
```

`currentNodeNum` is `null` on an MQTT source (no origin node), so statistical mode is
Meshtastic-TCP-shaped by construction. That matches the epic: the aggregate is defined
over the local↔peer pair, and without a local node there is no pair. Cost of dropping
the count precondition: one `GET /api/traceroutes/history/:from/:to` per opened DM
conversation with both a local and peer node (rather than only for conversations that
already look promising) — bounded by the hook's `staleTime: 60_000` / `gcTime: 300_000`,
so re-opening the same conversation within a minute costs nothing further.

---

**Why the original design (below) was replaced.** The first cut of S1 tried to avoid
that per-conversation request by reusing a signal already in hand — the participation
picker's own list, fetched on every conversation open regardless:

```ts
// SUPERSEDED — kept for the historical record, do not reintroduce.
const canReadTraceroute = hasPermission('traceroute', 'read');
const pairEntryCount = entries.filter(e =>
  e.participation === 'endpoint' &&
  (e.fromNodeNum === currentNodeNum || e.toNodeNum === currentNodeNum)
).length;

const statisticalFetchEnabled =
  canReadTraceroute &&
  currentNodeNum != null &&
  pickerNodeNum != null &&
  currentNodeNum !== pickerNodeNum &&
  pairEntryCount >= 2;
```

The reasoning was: counting the picker list's endpoint rows is free, and "a pair with
≥ 2 aggregatable routes almost always shows ≥ 2 endpoint entries in the window" sounded
like a sound necessary condition. Live browser validation on the dev rig falsified that
assumption. The participation list spans `TRACEROUTE_DISPLAY_HOURS` = 7 days
(`src/utils/nodeHelpers.ts:16`, applied at `tracerouteRoutes.ts:128-133`), while the
history endpoint is deliberately unwindowed (epic binding decision, §0: "all stored
pair history, no time filter"). On the Sandbox source, the pair local `1129874776` ↔
peer `2732916556` had **25 stored traceroutes with route data — all 35–83 days old**.
Every one fell outside the 7-day participation window, so the list showed only 3
`'hop'`-participation entries (0 matching `'endpoint'` rows), `pairEntryCount` was
permanently 0, and the statistical option could never appear for exactly this pair —
a long-lived, well-observed pair, which is the case the feature exists for. A
precondition keyed to a *windowed* proxy list directly contradicts an *unwindowed*
feature; it wasn't a tuning problem, it was the wrong signal. See D14/S1 above for the
replacement.

**S2 — when the option is offered.** Build the union once, memoized:

```ts
const statistical = useMemo(() => {
  if (currentNodeNum == null || pickerNodeNum == null || !pairHistory?.length) return null;
  const { union, graph } = buildStatisticalStrip(pairHistory, currentNodeNum, pickerNodeNum);
  if (union.totalRoutes < 2 || graph.isEmpty) return null;
  const meta = buildStripNodeMeta(graph, nodes, { hopsCalculation: nodeHopsCalculation, traceroutes, currentNodeNum });
  return { graph, meta, totalRoutes: union.totalRoutes };
}, [pairHistory, currentNodeNum, pickerNodeNum, nodes, nodeHopsCalculation, traceroutes]);
```

The "N routes" in the option label is **`union.totalRoutes`** — the D2 denominator, the
same number every tooltip percentage divides by. Any other count (rows fetched, entries
listed) would make the label disagree with the tooltips.

`graph.isEmpty` is checked too, though `totalRoutes >= 2` already implies a drawable
graph. It is one comparison, and it makes the "never hand an empty graph to the strip"
rule local instead of inferred.

**S3 — a statistical pick suppresses the single-route chrome.**

```ts
const showStatistical = statisticalPicked && statistical != null;
```

When `showStatistical`, the box renders the statistical strip and **omits**: the age
line, the pending badge, the failed badge, the "No return path data" line, and
`TracerouteCopyLinks`. Those all describe one traceroute; an aggregate has none of
them. The picker itself stays, so the user can get back.

This modifies **rule 4** (badges follow the displayed row) by adding "unless a
statistical aggregate is displayed, in which case there is no row and no badge", and
**rule 5** (strip memo) by adding a second, parallel memo rather than branching the
first one.

**S4 — resets.** Rule 2 (partner change, `MessagesTab.tsx:776`) and rule 3 (a new poll
timestamp, `:781-785`) both clear the pick. With D13 they become `setPick(null)`, so
they clear a statistical pick for free. No new effect, no new dependency.

Rule 3's `void refetchParticipation()` stays as-is; it has no bearing on the pair-history
query since S1 (amended) no longer reads the participation list at all. The pair-history
query is not explicitly refetched there either — its own 60s `staleTime` means a
genuinely new pair route lands within a minute at worst.

**S5 — losing availability while picked.** `showStatistical` is derived, not stored, so
if `statistical` becomes `null` (the union's `totalRoutes` drops below 2, permission
revoked, the query is disabled) the box silently falls back to rule 1's `displayedTrace`
and the normal strip. No effect, no cleanup, no flash of an empty aggregate.

**S6 — rule 7 stays unchanged (invariant note AMENDED).** The box still renders on
`if (displayedTrace)` (`MessagesTab.tsx:2022`). Under the original S1, statistical
availability implied `pairEntryCount >= 2`, which implied `entries.length >= 2`, which
made `displayedTrace` non-null by rule 1 — the guard was provably already satisfied
whenever the option could appear. Amended S1 has no participation-list precondition, so
that implication no longer holds: `statistical` can become available (`union.totalRoutes
>= 2`) purely from pair history, with zero picker entries and, on MQTT, no poll row
either. In that combination `displayedTrace` is `null`, rule 7's guard fails, the box
does not render at all, and the statistical option — however available in principle —
has nowhere to surface. This is accepted, not fixed, in Phase 2: it only arises when
every stored traceroute for a pair is older than the picker's 7-day window (the
scenario live validation surfaced) AND no traceroute has been freshly polled this
session, which is a narrow intersection, and the box's existence is already conditioned
on having *something* to show — a bare statistical-only affordance with no row underneath
it would be a scope increase (a new render path, not just a wider guard) left to a
follow-up if it proves to matter in practice.

### D15 — Tooltip and popup content

One sentence carries the encoding everywhere:

> Seen in **{seen}** of **{total}** routes (**{percent}**%)

`percent = Math.round(share * 100)`. `total = graph.totalRoutes`. `seen = node.count`
or `edge.count`.

**i18next plural note.** i18next selects the plural form from `count`, but the plural
noun here tracks the **denominator**. So the denominator is passed as `count` and the
numerator as `seen`:

```ts
t('messages.traceroute_stat_seen_in', { seen: n.count, count: statGraph.totalRoutes, percent })
```

Getting this backwards renders "Seen in 1 of 15 route".

| Surface | Statistical content |
|---|---|
| Node popup, real node | The existing `NodeCard` — `IdentityItems`, `SignalItems`, `PositionItem`, `LastHeardFooter`, `NodeActions` — **plus** one seen-in row appended to the `.node-popup-grid`. Nothing removed: a hop's identity, signal and position are as useful in an aggregate as in one route. |
| Node popup, unknown hop | The minimal fallback card, with `longName` = "Unrecorded hop" and a body of one description line plus the seen-in row. **No hex id** — `paddedHexId(BROADCAST_ADDR)` is `!ffffffff`, which is noise, and D4 makes the identity positional, not a node. |
| Node glyph caption | Unchanged: `unknownNodeLabel` ("Unknown") under an unrecorded hop, same as the single-route strip. Only the tooltip gets the fuller wording. |
| Edge tooltip | Endpoints (with `↔`, not `→`) + distance when both ends have a fix + seen-in row. **No direction row, no SNR row** (D8). |
| Node aria-label | `[displayName, roleLabel, nodeId, seenIn]` joined by the existing separator. Unknown hop: `[unrecordedHopLabel, seenIn]`. |
| Edge aria-label | `[endpoints, distance, seenIn]`. No direction fragment. |
| Group aria-label | `messages.traceroute_stat_strip_label` ("Statistical traceroute paths") instead of `traceroute_strip_label`. |

Endpoints get the seen-in row too, at 100%. A uniform rule beats a special case, and
"Seen in 15 of 15 routes (100%)" confirms the denominator the other percentages use.

### D16 — Opacity is a CSS custom property, not an inline `opacity`

Nodes and edges carry `--stat-opacity`; the CSS module applies it.

```tsx
style={statStyle(n.opacity, { left: center.x, top: center.y })}
```
```css
.statNode { opacity: var(--stat-opacity, 1); }
.statNode:focus-visible { opacity: 1; }
.statEdge { stroke-opacity: var(--stat-opacity, 1); }
```

Why not a plain inline `opacity`:

- A wrapper at `opacity: 0.28` also dims its own focus ring
  (`.node:focus-visible`, `TracerouteStrip.module.css:60-64`). The custom property lets
  `:focus-visible` restore full opacity; a hardcoded inline value cannot be overridden
  by CSS at all.
- The floor is a visual decision. Keeping the "how much" in CSS leaves a theme able to
  adjust it; the component only supplies the number.
- It stays assertable: `el.style.getPropertyValue('--stat-opacity')`.

The value is `node.opacity` / `edge.opacity` verbatim — already floored and rounded by
`statOpacity` (D9). The renderer does no arithmetic on it.

The hit-target polyline (`.edgeHit`) is **not** dimmed. It is transparent anyway, and a
faint edge must stay as clickable as a strong one.

`style={{ '--stat-opacity': … } as React.CSSProperties}` follows
`DashboardSidebar.tsx:505`. It is wrapped in one small helper so the cast appears once.

### D17 — `limit = 200`

`GET /api/traceroutes/history/:from/:to` defaults to 50 and caps at 1000
(`tracerouteRoutes.ts:62, 75-78`), ordered newest-first
(`traceroutes.ts:163-164`), bidirectional, and source-scoped when `sourceId` is passed.

200 because:

- The epic asked for "all stored pair history". Per-pair retention already bounds the
  table, and 200 traceroutes to one peer is far past what retention keeps in practice.
- It matches the participation endpoint's own ceiling (`tracerouteRoutes.ts:137`), so
  the two lists behind one picker have the same order of magnitude.
- The aggregate's cost does not grow with row count in any visible way — the layout's
  width is set by distinct hop depths, not by rows — so a larger window buys better
  shares for the same picture. The payload is the only real cost, and 200 rows of
  route JSON is small.
- It stays well inside the 1000 cap, so a future retention bump cannot start returning
  400s.

**Permission gate matches.** The history route uses
`requirePermission('traceroute', 'read', { sourceIdFrom: 'query' })`
(`tracerouteRoutes.ts:58`) — the same resource/action the strip's own display gate
checks (`MessagesTab.tsx:2011`), and the same shape the participation route uses. S1
adds `hasPermission('traceroute', 'read')` to the enabled condition so a
write-without-read user never fires a request that would 403.

**Response shape.** The handler spreads the raw DB row and adds `hopCount`
(`tracerouteRoutes.ts:82-97`) — it is **not** the participation projection. So rows
carry `id`, `sourceId`, `fromNodeNum`, `toNodeNum`, `fromNodeId`, `toNodeId`, `route`,
`routeBack`, `snrTowards`, `snrBack`, `timestamp`, `channel`, plus whatever else the
`traceroutes` table holds, plus `hopCount`. `AggregateTracerouteRow`
(`tracerouteAggregate.ts:84-92`) is a structural subset of that, so history rows feed
`buildStatisticalStrip` directly with no adapter.

Two notes the implementer must not skip:

- **Normalize the node numbers anyway.** `getTraceroutesByNodes` runs
  `normalizeBigInts` (`traceroutes.ts:166`), so PG/MySQL BIGINTs arrive as numbers
  today. The hook still coerces with `Number(...)` on the four scalar fields it hands
  to the aggregate — one cheap `.map` that makes the frontend independent of a backend
  normalization detail. Aggregation compares `fromNodeNum === localNodeNum`; a string
  would silently exclude every row.
- **The history route does not channel-mask.** The participation route runs
  `maskTraceroutesByChannel` (`tracerouteRoutes.ts:148`); the history route does not.
  Statistical mode therefore inherits exactly the visibility the existing
  `TracerouteHistoryModal` already has through the same endpoint. This is pre-existing,
  it is out of scope (no server changes this phase), and it must be logged as a
  follow-up rather than silently fixed here.

### D18 — Picker gains optional props, never a rewritten callback

```ts
statistical?: { totalRoutes: number };   // presence enables the option
statisticalSelected?: boolean;
onSelectStatistical?: () => void;
```

Everything already there — `entries`, `selectedId`, `onSelect`, `nodes`, `timeFormat`,
`dateFormat` — keeps its meaning and its type. Rejected: a single
`onPick(pick: TraceroutePick)`, which would be tidier in isolation but would rewrite
every existing picker test for no behavior gain.

The "fewer than 2 entries renders nothing" rule (`TracerouteParticipationPicker.tsx:74`)
becomes "fewer than 2 **options**":

```ts
const optionCount = entries.length + (statistical ? 1 : 0);
if (optionCount < 2) return null;
```

With `statistical` undefined this is the old expression exactly. With it present, a
single stored route plus the aggregate is two real choices, so the picker appears — the
correct behavior, and it falls out of the rule rather than needing a clause.

---

## 3. File-by-file changes

### 3.1 `src/utils/tracerouteUnionLayout.ts` — MODIFY (WP2)

One addition, next to the public types (after line 131):

```ts
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
```

No other change in this file. No change at all in `tracerouteAggregate.ts` or
`tracerouteStrip.ts`.

### 3.2 `src/services/api.ts` — MODIFY (WP1)

Add the row type beside `TracerouteParticipationEntry` (after line 62):

```ts
/**
 * One row from `GET /api/traceroutes/history/:from/:to`. The handler spreads the
 * raw DB row and adds `hopCount` — it is NOT the participation projection, so it
 * carries every stored column. Only the fields consumers actually read are named
 * here; the index signature keeps the extra columns representable without `any`.
 */
export interface TracerouteHistoryEntry {
  id: number;
  timestamp: number;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId?: string;
  toNodeId?: string;
  route: string | null;
  routeBack: string | null;
  snrTowards: string | null;
  snrBack: string | null;
  channel?: number | null;
  hopCount: number;
  [key: string]: unknown;
}
```

Annotate the existing method's return (line 845). Nothing else about it changes —
same params, same defaults, same `fetch`, same URL:

```ts
async getTracerouteHistory(
  fromNodeNum: number,
  toNodeNum: number,
  limit: number = 50,
  sourceId?: string | null,
): Promise<TracerouteHistoryEntry[]> {
```

The index signature is what keeps `TracerouteHistoryModal.tsx:48`, the one other
consumer, compiling unchanged. Verify that with `tsc`, not by eye.

The raw `fetch` inside `api.ts` stays. The no-raw-`fetch` ban covers
`src/components/**` and `src/pages/**`; `ApiService` is the sanctioned transport.

### 3.3 `src/hooks/useTraceroutePairHistory.ts` — NEW (WP1)

```ts
/**
 * useTraceroutePairHistory (Statistical Route epic, phase 2) — every stored
 * traceroute between two nodes, either direction, on one source. Feeds the
 * statistical aggregate in the Node Details traceroute box.
 *
 * Mirrors `useNodeTraceroutes`: one-shot query (not the poll cache),
 * `useResolvedSourceId` rather than `useSource` (MessagesTab can mount outside a
 * SourceProvider), and `enabled` deferring the request until the source resolves.
 *
 * Callers gate this further — see SR_PHASE2_SPEC.md D14/S1. The hook itself never
 * decides whether an aggregate is worth fetching.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import apiService, { type TracerouteHistoryEntry } from '../services/api';
import type { AggregateTracerouteRow } from '../utils/tracerouteAggregate';
import { useResolvedSourceId } from './useResolvedSourceId';

/** SR_PHASE2_SPEC.md D17. Server default is 50, cap 1000. */
export const PAIR_HISTORY_LIMIT = 200;

/**
 * Coerce the four scalars the aggregate compares numerically. `normalizeBigInts`
 * already does this server-side for PG/MySQL BIGINT columns, so this is insurance,
 * not a fix: aggregation compares `row.fromNodeNum === localNodeNum`, and a string
 * would silently drop every row instead of failing loudly.
 */
export function toAggregateRows(rows: TracerouteHistoryEntry[]): AggregateTracerouteRow[] {
  return rows.map((row) => ({
    id: Number(row.id),
    fromNodeNum: Number(row.fromNodeNum),
    toNodeNum: Number(row.toNodeNum),
    route: row.route ?? null,
    routeBack: row.routeBack ?? null,
    snrBack: row.snrBack ?? null,
    timestamp: Number(row.timestamp),
  }));
}

export function useTraceroutePairHistory(
  fromNodeNum: number | null,
  toNodeNum: number | null,
  opts: { enabled?: boolean; limit?: number } = {},
) {
  const sourceId = useResolvedSourceId();
  const limit = opts.limit ?? PAIR_HISTORY_LIMIT;

  const query = useQuery<TracerouteHistoryEntry[]>({
    queryKey: ['traceroutePairHistory', sourceId, fromNodeNum, toNodeNum, limit],
    queryFn: () => apiService.getTracerouteHistory(fromNodeNum!, toNodeNum!, limit, sourceId),
    enabled:
      (opts.enabled ?? true) &&
      fromNodeNum != null &&
      toNodeNum != null &&
      fromNodeNum !== toNodeNum &&
      !!sourceId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const rows = useMemo(
    () => (query.data ? toAggregateRows(query.data) : undefined),
    [query.data],
  );

  return { ...query, rows };
}
```

`rows` is memoized so its identity is stable across renders — MessagesTab's aggregate
memo depends on it, and a fresh array every render would rebuild the union every render.

### 3.4 `src/components/traceroute/TracerouteStrip.tsx` — MODIFY (WP2)

**Rule for this whole file: every statistical behavior sits behind
`statGraph !== null`. No expression on the single-route path may change.**

**Imports** (after line 29):

```ts
import {
  isUnionStripGraph,
  layoutTracerouteUnion,
  type UnionStripEdge,
  type UnionStripGraph,
  type UnionStripNode,
} from '../../utils/tracerouteUnionLayout';
```

**Helper** (module scope, beside `cx`, line 116):

```ts
/** React's `CSSProperties` has no index signature for custom properties, so
 *  setting one needs a narrow cast. Kept in one place rather than at three call
 *  sites. Precedent: DashboardSidebar.tsx:505. */
function statStyle(opacity: number, base: React.CSSProperties): React.CSSProperties {
  return { ...base, '--stat-opacity': opacity } as React.CSSProperties;
}
```

**Narrow + layout** (replacing line 148):

```ts
// D12: the discriminant is `graph.mode`, never `leg`. Null on the single-route
// path, which then behaves exactly as before this change.
const statGraph: UnionStripGraph | null = isUnionStripGraph(graph) ? graph : null;

const layout = useMemo(
  () => (isUnionStripGraph(graph) ? layoutTracerouteUnion(graph) : layoutTracerouteStrip(graph)),
  [graph],
);
```

`statGraph` is derived on every render from the same `graph` reference the memo keys
on; it needs no memo of its own and appears in no dependency array.

**Shared sentence builder** (beside the other `t()` captions, after line 379):

```ts
const unrecordedHopLabel = t('messages.traceroute_stat_unrecorded_hop', 'Unrecorded hop');

/** "Seen in 12 of 15 routes (80%)". The DENOMINATOR is passed as `count`,
 *  because i18next picks the plural form from `count` and the plural noun here
 *  is "routes" (the total), not the numerator. */
const seenInText = (count: number): string | null => {
  if (!statGraph) return null;
  const total = statGraph.totalRoutes;
  if (total <= 0) return null;
  return t('messages.traceroute_stat_seen_in', {
    seen: count,
    count: total,
    percent: Math.round((count / total) * 100),
  });
};

/** The `.node-popup-item` row both tooltips append. Reuses the global popup
 *  classes the edge tooltip already uses — no new markup shape. */
const renderSeenInRow = (count: number) => {
  const text = seenInText(count);
  if (!text) return null;
  return (
    <div className="node-popup-item node-popup-item-full">
      <span className="node-popup-icon"><UiIcon name="telemetry" /></span>
      <span className={styles.srOnly}>{t('messages.traceroute_stat_seen_in_label', 'Occurrence')}: </span>
      <span className="node-popup-value">{text}</span>
    </div>
  );
};
```

`telemetry` is the icon set's only chart glyph (`BarChart3`,
`src/components/icons/UiIcon.tsx:223`). Reuse it. Do not add an icon for this row. The
endpoints row keeps `link` and the distance row keeps `ruler`, exactly as the
single-route edge tooltip already uses them.

**`displayNameForNodeId`** (line 392): in the placeholder branch, return
`unrecordedHopLabel` when `statGraph` is set, instead of
`` `${unknownNodeLabel} ${paddedHexId(node.nodeNum)}` ``. Every unknown statistical hop
has `nodeNum === BROADCAST_ADDR`, so the hex is `!ffffffff` for all of them — a shared,
meaningless string in a sentence about one specific position.

**`edgeSummary`** (line 435): branch. Statistical builds
`[endpoints, distance, seenIn]` with `messages.traceroute_stat_edge_endpoints`
(`{{from}} ↔ {{to}}`) and no direction fragment. The join, the filter, and the
separator key are shared with the existing path — extract the tail, do not copy it.

**`renderEdgeTooltip`** (line 453): when `statGraph` is set, render endpoints (with the
`↔` key and the existing `traceroute_edge_endpoints_label` sr-only label), the distance
row unchanged, and `renderSeenInRow(edge.count)`. Skip the direction row and the SNR
row. Signature widens to accept `StripEdge | UnionStripEdge`; read `count` only after
narrowing.

**Visible edges** (lines 519-533):

```tsx
{graph.edges.map((e) => {
  const path = layout.edgePaths.get(e.id);
  if (!path) return null;
  const points = path.map((p) => `${p.x},${p.y}`).join(' ');
  const stat = statGraph ? (e as UnionStripEdge) : null;
  return (
    <polyline
      key={e.id}
      className={stat ? styles.statEdge : e.leg === 'forward' ? styles.forwardEdge : styles.returnEdge}
      points={points}
      // D8: no arrowhead in statistical mode — the edge makes no direction claim.
      markerEnd={stat ? undefined : `url(#${arrowId})`}
      style={stat ? statStyle(stat.opacity, {}) : undefined}
    />
  );
})}
```

The `<marker>` def (lines 503-513) stays in the DOM unconditionally. It is referenced by
nothing in statistical mode and removing it conditionally would churn the single-route
DOM for no gain.

**Edge hit targets** (lines 540-565): unchanged apart from `edgeSummary`, which already
branches. Not dimmed (D16).

**SNR labels** (lines 568-599): add one guard at the top of the callback:

```tsx
// D8: no SNR labels in statistical mode. Union edges already carry
// `snr: null, snrUnknown: false`, so this is belt-and-braces — but the rule is
// "branch on mode", not "trust the data".
if (statGraph) return null;
```

**Node loop** (lines 601-677): three additions inside the existing callback.

```tsx
const statNode = statGraph ? (n as UnionStripNode) : null;
const seenIn = statNode ? seenInText(statNode.count) : null;

// Unknown statistical hops are positional (D4): "Unrecorded hop", never a
// name and never the shared !ffffffff placeholder id.
const accessibleName = (
  statNode && isPlaceholder
    ? [unrecordedHopLabel, seenIn]
    : [displayName, roleLabel, nodeId, seenIn]
)
  .filter((part): part is string => !!part)
  .join(t('messages.traceroute_node_label_separator', ', '));
```

and on the wrapper `<div>`:

```tsx
className={cx(styles.node, laneClassFor(n.lane), statNode && styles.statNode)}
style={statNode
  ? statStyle(statNode.opacity, { left: center.x, top: center.y })
  : { left: center.x, top: center.y }}
```

Nothing else in the loop changes. Glyph, short name, focus, keyboard handler, and
`onOpenNodeDetails` all keep working — a real node in an aggregate is still a node you
may want to open.

**`hoverCard`** (lines 315-374): two changes.

- Placeholder branch: when `statGraph` is set, the model's `longName` is
  `unrecordedHopLabel`, the body is a description line
  (`messages.traceroute_stat_unrecorded_hop_desc`) plus `renderSeenInRow(count)`, and
  `IdentityItems` is **not** rendered (there is no honest id to show).
- Real-node branch: append `renderSeenInRow(count)` inside the existing
  `.node-popup-grid`, after `PositionItem`.

The hovered node's `count` comes from the hovered `UnionStripNode`, looked up by
`hover.id` through the existing `nodeById` map (line 383) — **by `id`, never by
`nodeNum`** (D10). The memo's dependency list gains `statGraph` and `nodeById`; add
them, do not disable the lint rule.

**Group label** (line 496): `aria-label={statGraph ? t('messages.traceroute_stat_strip_label', 'Statistical traceroute paths') : stripLabel}`.

### 3.5 `src/components/traceroute/TracerouteStrip.module.css` — MODIFY (WP2)

Join the existing stroke rule rather than restating it (lines 34-39):

```css
.forwardEdge,
.returnEdge,
.statEdge {
  fill: none;
  stroke: var(--ctp-pink);
  stroke-width: 2;
}
```

Then append, after `.returnEdge` (line 44):

```css
/* Statistical mode (SR_PHASE2_SPEC.md D16): one neutral lane — solid, no dash,
 * no arrowhead. Occurrence share arrives as `--stat-opacity`, already floored at
 * MIN_STAT_OPACITY by `statOpacity()`; this file never computes it. */
.statEdge {
  stroke-opacity: var(--stat-opacity, 1);
}
```

and after `.node:focus-visible` (line 64):

```css
/* The wrapper dims as a unit, glyph and short name together, so a rare hop reads
 * faint end to end. A custom property rather than an inline `opacity` precisely
 * so the focus rule below can win — a hardcoded inline value could not be
 * overridden, and a 0.28 focus ring is not a focus ring. */
.statNode {
  opacity: var(--stat-opacity, 1);
}

.statNode:focus-visible {
  opacity: 1;
}
```

Nothing else in this file changes. No global sheet is touched.

### 3.6 `src/components/traceroute/TracerouteParticipationPicker.tsx` — MODIFY (WP3)

```ts
/** The `<select>` value for the statistical aggregate. A string, because a
 *  `<select>` value is a string and every entry option is a numeric id — the two
 *  spaces cannot collide. */
export const STATISTICAL_OPTION_VALUE = 'statistical';

export interface TracerouteParticipationPickerProps {
  entries: TracerouteParticipationEntry[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  nodes: DeviceInfo[];
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  /** Present when the pair has an aggregate worth offering (>= 2 routes,
   *  SR_PHASE2_SPEC.md D14/S2). Absent leaves this component exactly as it was. */
  statistical?: { totalRoutes: number };
  statisticalSelected?: boolean;
  onSelectStatistical?: () => void;
}
```

Body changes:

```ts
const optionCount = entries.length + (statistical ? 1 : 0);
if (optionCount < 2) return null;
```

```tsx
value={
  statisticalSelected
    ? STATISTICAL_OPTION_VALUE
    : selectedId != null ? String(selectedId) : ''
}
onChange={e => {
  if (e.target.value === STATISTICAL_OPTION_VALUE) onSelectStatistical?.();
  else onSelect(Number(e.target.value));
}}
```

The hidden `Latest` placeholder condition becomes `selectedId == null && !statisticalSelected`.

The statistical option renders **first**, above the dated entries — it summarises all of
them, so it belongs at the top of the list, and putting it there keeps the entries'
newest-first order untouched:

```tsx
{statistical && (
  <option value={STATISTICAL_OPTION_VALUE}>
    {t('messages.traceroute_picker_statistical', { count: statistical.totalRoutes })}
  </option>
)}
```

`buildOptionLabel` is untouched. No CSS change in
`TracerouteParticipationPicker.module.css`.

### 3.7 `src/components/MessagesTab.tsx` — MODIFY (WP4)

**Imports** (beside lines 24-28):

```ts
import { buildStatisticalStrip } from '../utils/tracerouteUnionLayout';
import { useTraceroutePairHistory } from '../hooks/useTraceroutePairHistory';
```

**Pick state** (replacing line 773):

```ts
/** What the traceroute box is showing: a specific stored row, the statistical
 *  aggregate, or nothing picked — in which case rule 1's newest-of-both applies.
 *  One discriminated value rather than two flags, so the two states cannot both
 *  be set (SR_PHASE2_SPEC.md D13). */
type TraceroutePick = { kind: 'entry'; id: number } | { kind: 'statistical' };

const [pick, setPick] = useState<TraceroutePick | null>(null);
const pickedTracerouteId = pick?.kind === 'entry' ? pick.id : null;
const statisticalPicked = pick?.kind === 'statistical';
```

Declare `TraceroutePick` at module scope near `DisplayedTraceroute` (line 93).

**Rules 2 and 3** (lines 776 and 781-785): `setPickedTracerouteId(null)` →
`setPick(null)`. Nothing else in either effect changes, including their dependency
arrays.

**Rule 1** (lines 796-803): unchanged, verbatim. `pickedTracerouteId` is now derived
but reads identically.

**S1/S2** (new, after the strip memo at line 814):

```ts
// S1 (AMENDED — see D14/S1) — gated on cheap VALIDITY signals only: no
// participation-count precondition. Live rig validation showed a real,
// long-lived pair (25 stored routes, all 35-83 days old) never satisfying
// a count-based gate keyed to the picker's 7-day participation window.
const { rows: pairHistory } = useTraceroutePairHistory(currentNodeNum, pickerNodeNum, {
  enabled:
    hasPermission('traceroute', 'read') &&
    currentNodeNum != null &&
    pickerNodeNum != null &&
    currentNodeNum !== pickerNodeNum,
});

// S2 — build the union once. `buildStatisticalStrip` also returns a layout; the
// strip component recomputes it from the graph, exactly as it does for a
// single-route graph, so the component stays a pure function of (graph, meta).
// Do NOT pass layout options here: the component paints glyphs at its own
// DEFAULT_GLYPH_SIZE, which matches DEFAULT_LAYOUT_OPTIONS.glyphSize.
const statistical = useMemo(() => {
  if (currentNodeNum == null || pickerNodeNum == null || !pairHistory?.length) return null;
  const { union, graph } = buildStatisticalStrip(pairHistory, currentNodeNum, pickerNodeNum);
  if (union.totalRoutes < 2 || graph.isEmpty) return null;
  const meta = buildStripNodeMeta(graph, nodes, {
    hopsCalculation: nodeHopsCalculation,
    traceroutes,
    currentNodeNum,
  });
  return { graph, meta, totalRoutes: union.totalRoutes };
}, [pairHistory, currentNodeNum, pickerNodeNum, nodes, nodeHopsCalculation, traceroutes]);

// S5 — derived, not stored: losing availability while picked falls back to the
// rule-1 row with no effect and no cleanup.
const showStatistical = statisticalPicked && statistical != null;
```

`hasPermission` is a destructured prop (`MessagesTab.tsx:283`), so it is already in
scope here. `entries`, `currentNodeNum` and `pickerNodeNum` all resolve above line 814
too — these three declarations go straight after the strip memo, together.

**Picker call** (lines 2046-2057): add three props, change `onSelect`.

```tsx
<TracerouteParticipationPicker
  entries={entries}
  selectedId={showStatistical ? null : (displayedTrace.id ?? null)}
  onSelect={id => setPick({ kind: 'entry', id })}
  nodes={nodes}
  timeFormat={timeFormat}
  dateFormat={dateFormat}
  statistical={statistical ? { totalRoutes: statistical.totalRoutes } : undefined}
  statisticalSelected={showStatistical}
  onSelectStatistical={() => setPick({ kind: 'statistical' })}
/>
```

**Strip** (lines 2058-2074):

```tsx
{showStatistical ? (
  <TracerouteStrip
    graph={statistical.graph}
    meta={statistical.meta}
    timeFormat={timeFormat}
    dateFormat={dateFormat}
    distanceUnit={distanceUnit}
    onOpenNodeDetails={handleStripNodeDetails}
  />
) : stripGraph && stripMeta && !stripGraph.isEmpty ? (
  … existing single-route branch, byte-identical …
) : (
  … existing "No response received" branch …
)}
```

**S3 suppressions:**

- "No return path data" (lines 2075-2079): prefix the condition with `!showStatistical &&`.
- `TracerouteCopyLinks` (lines 2080-2088): wrap in `{!showStatistical && ( … )}`.
- The `traceroute-age` div and both badges (lines 2089-2109): wrap in
  `{!showStatistical && ( … )}`.

Rule 7's guard (line 2022) and the read gate (line 2011) are unchanged.

### 3.8 `public/locales/en.json` — MODIFY (WP2 owns this file)

Add after `messages.traceroute_picker_relayed` (line 504). English only; other locales
fall through, as in Phase 1 and TRS Phase 2.

```json
"messages.traceroute_stat_strip_label": "Statistical traceroute paths",
"messages.traceroute_stat_seen_in_one": "Seen in {{seen}} of {{count}} route ({{percent}}%)",
"messages.traceroute_stat_seen_in_other": "Seen in {{seen}} of {{count}} routes ({{percent}}%)",
"messages.traceroute_stat_seen_in_label": "Occurrence",
"messages.traceroute_stat_edge_endpoints": "{{from}} ↔ {{to}}",
"messages.traceroute_stat_unrecorded_hop": "Unrecorded hop",
"messages.traceroute_stat_unrecorded_hop_desc": "The traceroute did not record which node relayed here.",
"messages.traceroute_picker_statistical_one": "Statistical ({{count}} route)",
"messages.traceroute_picker_statistical_other": "Statistical ({{count}} routes)"
```

Plural keys carry no inline default at the call site — `_one`/`_other` cannot be
expressed positionally. That matches `messages.traceroute_picker_hops_*`
(`TracerouteParticipationPicker.tsx:56`). Every non-plural key above gets the inline
English default at its call site, per house style.

Reused, not re-added: `messages.traceroute_unknown_node`,
`messages.traceroute_node_label_separator`, `messages.traceroute_edge_endpoints_label`,
`messages.traceroute_edge_distance_label`, `messages.traceroute_picker_label`,
`messages.traceroute_picker_aria`.

---

## 4. Test plan

### 4.1 `src/hooks/useTraceroutePairHistory.test.tsx` — NEW (WP1)

jsdom, `renderHook` inside a `QueryClientProvider` with retries off. Mock
`../services/api` and `./useResolvedSourceId`.

- calls `getTracerouteHistory(from, to, 200, sourceId)` — asserts D17's limit
- `enabled` false while `useResolvedSourceId()` returns `undefined`; no call fires
- no call when `fromNodeNum` is null; when `toNodeNum` is null; when the two are equal
- no call when `opts.enabled` is false, even with everything else resolved
- query key includes sourceId, both node numbers and the limit; two different pairs do
  not share a cache entry
- `opts.limit` overrides `PAIR_HISTORY_LIMIT`
- `toAggregateRows`: string-typed `fromNodeNum`/`toNodeNum`/`timestamp` (the PG/MySQL
  BIGINT shape) come back as numbers
- `toAggregateRows`: `undefined` `route`/`routeBack`/`snrBack` normalize to `null`
- `rows` keeps a stable identity across a re-render with unchanged data

### 4.2 `src/components/traceroute/TracerouteStrip.statistical.test.tsx` — NEW (WP2)

New file. **`TracerouteStrip.test.tsx` is not edited.** Copy its `react-i18next`
override and its `makeMeta` helper; build graphs with `buildStatisticalStrip` over
fixture rows rather than by hand, so the tests exercise the real seam.

*Mode branch*
- a statistical graph renders `.statEdge` polylines and no `.forwardEdge`/`.returnEdge`
- no `markerEnd` on any visible statistical edge
- no SNR label element anywhere, including for a fixture whose rows carry `snrBack`
- the group's `aria-label` is the statistical one
- a single-route graph rendered through the same component still produces arrowheads
  and SNR labels — the branch does not leak

*Opacity (D16)*
- every node div carries `--stat-opacity` equal to its `UnionStripNode.opacity`
- every visible edge carries `--stat-opacity` equal to its `UnionStripEdge.opacity`
- a share-1.0 node reads `1`; the rarest node reads `MIN_STAT_OPACITY` when its share
  rounds there
- `.edgeHit` targets carry no `--stat-opacity`
- node divs carry `.statNode`; a single-route render does not

*Tooltips*
- hovering a real node shows the node card **and** "Seen in 3 of 5 routes (60%)"
- hovering an endpoint shows 100%
- the percentage rounds (2 of 3 → 67%)
- hovering an unrecorded hop shows "Unrecorded hop", the description line, the seen-in
  line, and **no** `!ffffffff` and no node name anywhere in the popup
- hovering an edge shows endpoints with `↔`, the seen-in line, and **no** direction row
  and **no** SNR row
- an edge whose two ends both have positions still shows the distance row
- two unrecorded hops at different depths produce two distinct popups (asserts the
  `id`, not `nodeNum`, keying — D10)

*Accessibility parity*
- node `aria-label` ends with the seen-in sentence; unrecorded-hop labels contain no
  hex id
- edge `aria-label` contains endpoints and seen-in, and contains neither "Forward" nor
  "Return"
- focusing a node sets `aria-describedby`; blurring clears it
- `Enter` on a focused real node with a `userId` still calls `onOpenNodeDetails`
- tabbing reaches both node divs and edge hit targets, same as single-route mode

### 4.3 `src/components/traceroute/TracerouteParticipationPicker.test.tsx` — EXTEND (WP3)

Append one `describe('statistical option')`. Existing blocks stay untouched.

- absent `statistical`: every existing behavior holds, including "1 entry renders nothing"
- 1 entry + `statistical` → the picker renders, with 2 options
- 0 entries + `statistical` → still `null` (one option is not a choice)
- the statistical option renders first, above the dated entries
- its label reads "Statistical (12 routes)"; `totalRoutes: 1` reads "(1 route)"
- choosing it calls `onSelectStatistical` and **not** `onSelect`
- choosing a dated entry calls `onSelect` with the numeric id and **not**
  `onSelectStatistical`
- `statisticalSelected` makes the select show the statistical option, and the hidden
  "Latest" placeholder does not appear

### 4.4 `src/components/MessagesTab.tracerouteStatistical.test.tsx` — NEW (WP4)

Mock block copied from `MessagesTab.tracerouteStrip.test.tsx:31-130`, with
`useNodeTraceroutes` returning fixture entries and `useTraceroutePairHistory` mocked
per case.

*Fetch gate (S1, amended — validity-only, no participation-count precondition)*
- a valid pair (both node numbers resolved, distinct, `traceroute:read` granted) →
  `useTraceroutePairHistory` is called with `enabled: true`, with `currentNodeNum` and
  the picker node number — asserted with **zero** participation entries, to prove the
  count precondition is gone
- `currentNodeNum` null (the MQTT shape) → `enabled: false` and no statistical option
- `traceroute:write` without `traceroute:read` → `enabled: false`
- a self-pair (`currentNodeNum === pickerNodeNum`) → `enabled: false`

*Option availability (S2)*
- history yielding `totalRoutes >= 2` → the option appears, labelled with that number
- history yielding exactly 1 aggregatable route → no option
- history of only failed rows (no `route`, no `routeBack`) → no option
- the label's N equals `union.totalRoutes`, not the number of rows fetched

*Pick behavior (S3)*
- choosing it renders the statistical strip and hides the single-route strip
- copy links disappear
- the age line and both badges disappear
- "No return path data" disappears
- the picker stays visible, showing the statistical option as selected
- choosing a dated entry afterwards restores the single-route strip, copy links, age
  and badges

*Resets (S4)*
- switching conversation partner clears a statistical pick
- a new `recentTrace.timestamp` clears a statistical pick and restores the rule-1 row
- neither reset breaks the existing rule 2/rule 3 behavior for an entry pick

*Fallback (S5)*
- statistical becomes unavailable while picked → the box falls back to the rule-1 row
  with no crash and no empty strip

*Non-regression*
- with no statistical option available, the box is byte-for-byte the behavior the
  existing `MessagesTab.tracerouteStrip.test.tsx` asserts (spot-check the age line,
  badges, copy links and read gate)

### 4.5 `src/services/api.test.ts` — EXTEND (WP1)

- `getTracerouteHistory(111, 222, 200, 'src-a')` builds
  `…/history/111/222?limit=200&sourceId=src-a`
- `sourceId` omitted leaves the query off entirely (existing behavior, pinned)

### 4.6 Suite level

- `npx tsc --noEmit` clean, including `TracerouteHistoryModal.tsx` after the api.ts
  return-type change
- full Vitest suite green, 0 failures — confirm `success: true` in the JSON reporter,
  not just the pass count
- `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` empty
- `git diff --stat` shows **no change** to `TracerouteStrip.test.tsx`,
  `tracerouteStrip.ts`, `tracerouteAggregate.ts`, `TracerouteCopyLinks.tsx`, or any
  file under `src/server/`

---

## 5. Work packages

Sequential. Each is one Sonnet implementer. File ownership is exclusive — no two
packages edit the same file.

### WP1 — Transport and hook

**Depends on:** nothing.
**Owns:** `src/services/api.ts`, `src/services/api.test.ts`,
`src/hooks/useTraceroutePairHistory.ts` (new),
`src/hooks/useTraceroutePairHistory.test.tsx` (new).
**Spec:** §3.2, §3.3, §4.1, §4.5.

Acceptance:
- `TracerouteHistoryEntry` exported; `getTracerouteHistory` returns it; its body is
  otherwise unchanged
- `TracerouteHistoryModal.tsx` compiles with no edit
- the hook mirrors `useNodeTraceroutes` on key shape, `staleTime`, `gcTime`,
  `refetchOnWindowFocus` and the sourceId gate
- `PAIR_HISTORY_LIMIT === 200`
- `toAggregateRows` coerces the four numeric fields and normalizes absent legs to `null`
- `rows` identity is stable across re-render
- new tests pass; full suite and `lint:ci` green

### WP2 — Strip statistical mode, CSS, i18n

**Depends on:** nothing (Phase 1 modules are merged). May run before WP1.
**Owns:** `src/utils/tracerouteUnionLayout.ts` (type guard only),
`src/components/traceroute/TracerouteStrip.tsx`,
`src/components/traceroute/TracerouteStrip.module.css`,
`src/components/traceroute/TracerouteStrip.statistical.test.tsx` (new),
`public/locales/en.json` (**all** new keys, including the picker's — WP3 must not touch
this file).
**Spec:** §3.1, §3.4, §3.5, §3.8, §4.2.

Acceptance:
- `isUnionStripGraph` exported; the renderer narrows through it and never reads `leg`
  as a direction claim
- `TracerouteStripProps` is unchanged — no prop added, no prop type widened
- `git diff` shows zero changes to `TracerouteStrip.test.tsx`, and it passes untouched
- statistical render: `.statEdge`, no arrowheads, no SNR labels, `--stat-opacity` on
  nodes and edges, `.statNode` focus override present
- tooltips carry the seen-in sentence with the denominator as `count`
- unrecorded-hop popups show no hex id and no node name
- no `any`; `react-hooks/exhaustive-deps` count for this file does not grow in
  `eslint-baseline.json`
- new tests pass; full suite and `lint:ci` green

### WP3 — Picker statistical option

**Depends on:** WP2 (the i18n keys must exist).
**Owns:** `src/components/traceroute/TracerouteParticipationPicker.tsx`,
`src/components/traceroute/TracerouteParticipationPicker.test.tsx`.
**Must not touch:** `public/locales/en.json`.
**Spec:** §3.6, §4.3.

Acceptance:
- three optional props added; the six existing props keep their names and types
- with `statistical` undefined the component's behavior and DOM are unchanged, and
  every existing test in the file passes with no edit
- `optionCount < 2` replaces `entries.length < 2`
- the statistical option renders first and dispatches `onSelectStatistical`
- new tests pass; full suite and `lint:ci` green

### WP4 — MessagesTab wiring

**Depends on:** WP1, WP2, WP3.
**Owns:** `src/components/MessagesTab.tsx`,
`src/components/MessagesTab.tracerouteStatistical.test.tsx` (new).
**Spec:** §3.7, §4.4.

Acceptance:
- pick state is one `TraceroutePick | null`; `pickedTracerouteId` and
  `statisticalPicked` are derived
- rules 1, 4 (non-statistical path), 6 and 7 keep their exact expressions; rules 2 and
  3 change only their setter call
- S1 (amended): the gate is validity-only — `enabled: true` fires for any valid,
  distinct, permitted pair regardless of participation-entry count; `enabled: false`
  for no local node (MQTT), a self-pair, or missing `traceroute:read`
- S3 hides the age line, both badges, the no-return line and the copy links
- S5 falls back with no effect and no crash
- `useTraceroutePairHistory` is called unconditionally at MessagesTab's top level (no
  mount-gated wrapper component, no lifted state) — same house convention as the
  pre-existing `useNodeTraceroutes` call
- `MessagesTab.tracerouteStrip.test.tsx` passes with no edit; `MessagesTab.composeFocus.test.tsx`
  and `MessagesTab.txDisabled.test.tsx` pass with exactly one added `vi.mock` line each
  (mirroring their existing `useNodeTraceroutes` stub) and no other change
- new tests pass; full suite and `lint:ci` green

### WP5 — Live validation, docs, PR

**Depends on:** WP4.
**Owns:** `docs/internal/dev-notes/STATISTICAL_ROUTE_EPIC.md` (phase record and
deviations log), any user-facing docs the feature warrants.
**Spec:** §6.

Acceptance:
- dev container built from this branch and verified running this code
- browser validation (chrome-devtools) covers: the option appearing on a pair with
  history, the strip rendering with visibly graded opacity, node and edge tooltips
  showing real percentages, an unrecorded-hop tooltip, copy links and badges gone, and
  the pick resetting when the conversation partner changes
- real-mouse hover, not synthetic `dispatchEvent` — the strip's hit targets are
  hit-tested SVG strokes
- epic plan's Phase 2 box ticked, phase record written, deviations logged
- PR opened, CI green, merged

---

## 6. Risks, and how this spec closes them

| Risk | Closure |
|---|---|
| The statistical branch regresses the single-route strip | No prop change, no dependency-array change, a sibling test file, and an explicit `git diff --stat` acceptance check (§4.6) |
| The renderer reads `leg` as direction | D8 is restated at every call site that touches `leg`; §4.2 asserts no arrowheads and no direction word in any aria-label |
| Unknown hops collapse into one | D10's `id` keying is preserved by the existing loops; §4.2 has a named two-unrecorded-hops test |
| A history request per conversation open | **Amended, accepted rather than closed**: S1 originally gated on the already-fetched participation list to avoid this, but that gate's premise (a windowed proxy list standing in for the unwindowed history) was disproven by live validation — a real 25-route, 35-83-day-old pair never passed it. S1 now fires on every valid pair, bounded only by the hook's 60s `staleTime`/5min `gcTime`; §4.4 asserts `enabled: true` fires even with zero participation entries, and `enabled: false` still holds for the three validity failures (no local node, self-pair, no read permission) |
| Plural sentence reads "1 of 15 route" | D15 names the denominator `count`; §4.2 asserts both the singular and plural renderings |
| PG/MySQL BIGINT strings silently empty the aggregate | `toAggregateRows` coerces; §4.1 has a named string-input test |
| Opacity dims the focus ring | D16 uses a custom property so `:focus-visible` can restore it; §4.2 asserts the class is present |
| The label's N disagrees with the tooltips | Both come from `union.totalRoutes`; §4.4 asserts it is not the fetched-row count |
| History rows are not channel-masked | Pre-existing and inherited from `TracerouteHistoryModal`; documented in D17 and logged as a follow-up, not fixed here (no server changes this phase) |
