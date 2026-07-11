# Map Consolidation — Phase 7 Spec: Residual layer library + big maps on BaseMap

**Epic:** #4047 (see `MAP_CONSOLIDATION_EPIC.md`)
**Branch:** `feature/4047-p7-layer-library` (from `origin/4049-map-refactor`, contains Phases 1–6)
**Phase goal (binding):** Promote the remaining inline layers into `src/components/map/layers/`
(neighbor links, accuracy regions, waypoints), have DashboardMap / MeshCoreMap / MapAnalysis /
NodesTab compose the shared layers AND adopt the BaseMap shell, and adopt BaseMap for EmbedMap
(deferred from Phase 6). NodesTab migrates **last**.
**Exit:** no inline layer reimplementations in the big four; all maps on BaseMap; browser-validated
on every map view; suite green.

> **Orchestrator flag (read first — this phase splits):** the decomposition is ~14 work packages
> and the aggregate diff will exceed ~2.5k lines. Per the epic-doc allowance ("May split into
> multiple PRs — flag to orchestrator first") and the phase-brief PR-split rule, **this spec
> recommends a 2-PR split** (§8.1). Also **one design decision is escalated** (§6.1 neighbor-link
> look convergence) rather than decided unilaterally. Approve both before implementation starts.

---

## 1. Method & ground truth

Every candidate below was read in full (NodesTab 2841 L; DashboardMap 824 L; EmbedMap 732 L;
MeshCoreMap 602 L; MapAnalysisCanvas + its 11 layers; mapHelpers). Each is classified — per the
Phase-2 lesson — as **{duplicated → promote}**, **{single-consumer → leave/relocate}**, or
**{divergent-by-design → document}**. Nothing is force-unified.

The **proven promotion pattern** in this epic is the descriptor-based shared layer (Phase 4
`src/components/map/layers/NodeMarkersLayer.tsx`) with thin per-consumer adapters that map data →
descriptors and supply the consumer-specific bits (icon/popup/click). Phase 4 shipped it as a
**pure refactor with an empty visible-changes list**, byte-parity enforced by fixtures. Phase 7
reuses that exact playbook.

### 1.1 What is ALREADY shared (no work, or relocation only)

| Concern | Shared today | Phase-7 action |
|---|---|---|
| Node markers | `map/layers/NodeMarkersLayer` (P4) — all 4 big maps + none-for-Embed | none (Embed stays inline markers, see §6.5) |
| Node popups | `map/popups/*` (P5) — Dashboard, MapAnalysis, MeshCore, NodesTab | none |
| Traceroute paths | `map/layers/TraceroutePathsLayer` (P3) — NodesTab (via `useTraceroutePaths` hook in App.tsx), Dashboard, MapAnalysis, TracerouteWidget, EmbedMap (P6) | none |
| Waypoint markers | `PerSourceWaypoints` in `MapAnalysis/layers/WaypointsLayer.tsx` — consumed by MapAnalysis, Dashboard (`DashboardWaypoints`), NodesTab (via `DashboardWaypoints`) | **relocate** to `map/layers/` (§4.3) |
| Position-history helpers | `mapHelpers.tsx`: `getPositionHistoryColor`, `generatePositionHistoryArrows`, `generateHeadingAwarePath` | none (see §5) |
| Tile shell | `map/BaseMap.tsx` (P1) — 4 simple editors only | **big-four + Embed adopt** (§3) |

### 1.2 Candidate scorecard

| Candidate | Consumers (inline unless noted) | Verdict |
|---|---|---|
| **Neighbor links (Meshtastic)** | NodesTab L2519–2648; DashboardMap L561–608; MapAnalysis `NeighborLinksLayer` (layer); EmbedMap L430–462 | **duplicated → promote** (§4.1) |
| **Neighbor links (MeshCore)** | DashboardMap L553–559; MapAnalysis `MeshCoreNeighborLinksLayer` (layer); MeshCoreMap L457–470 | **duplicated → promote** (same layer, §4.1) |
| **Accuracy precision cells** | MapAnalysis `AccuracyRegionsLayer` (layer); DashboardMap L500–521; NodesTab L2444–2505 | **duplicated → promote** (§4.2) |
| **Waypoints** | `PerSourceWaypoints` (shared, wrong dir) | **relocate only** (§4.3) |
| **MeshCore path (hop-count) lines** | MeshCoreMap L442–455 | **divergent-by-design → document** (§5.1) |
| **Estimated-uncertainty circles** | NodesTab L2412–2442 | **single-consumer → leave inline** (§5.2) |
| **Position history — single-node rich** | NodesTab L532–609 (+ shared arrows helper) | **single-consumer → leave** (§5.3) |
| **Position history — multi-node trails** | MapAnalysis `PositionTrailsLayer`; MeshCoreMap L434–440 | **divergent-by-design → document** (§5.3) |
| **BaseMap shell** | NodesTab / Dashboard / MeshCore / MapAnalysis / Embed | **adopt** (§3) |

---

## 2. BaseMap gap analysis + API additions

BaseMap (`src/components/map/BaseMap.tsx`, P1) already owns MapContainer, the raster-vs-vector
tile branch (`tilesetId` + `customTilesets` + `styleJson`, resolved **once**), the gated
`MapResizeHandler` (`resizeTrigger`), the sibling `TilesetSelector` (`showTilesetSelector` +
`onTilesetChange`), and typed passthroughs (`mapRef`, `className`, `mapStyle`, `scrollWheelZoom`,
`doubleClickZoom`, `zoomControl`, `attributionControl`). It is persistence-agnostic and **never
calls `useSettings()`** (critical for Embed, §6.5).

Read of all five shells confirms **exactly one genuine gap**:

### 2.1 API addition — key the tile layer by resolved tileset id
DashboardMap keys its `<TileLayer key={tilesetId} …>` (DashboardMap L464) to force a clean layer
remount on tileset swap. BaseMap currently renders `<TileLayer>` / `<VectorTileLayer>` **without a
key**, so a Dashboard→BaseMap migration would silently drop that remount. **Add an internal
`key={resolvedId}`** to both branches of BaseMap's tile render (BaseMap L104–119).
- Safe for the 4 Phase-1 editors: they omit `tilesetId` ⇒ `resolvedId` is the constant
  `DEFAULT_TILESET_ID` ⇒ key is stable ⇒ no remount, no behavior change.
- Benefits every adopter (tileset swaps clear stale raster/vector layers deterministically).
- Update `BaseMap.test.tsx` to assert the tile element carries `key`/remounts on `tilesetId`
  change (assert via a fresh element identity or a data-attr proxy, since jsdom can't see React keys
  directly — pin it by asserting the raster/vector branch element re-mounts when `tilesetId` flips).

### 2.2 Non-gaps (explicitly verified — no BaseMap change)
- **VectorTileLayer + styleJson** (NodesTab-only): already in BaseMap. NodesTab passes
  `tilesetId={activeTileset}`, `customTilesets`, `styleJson={activeStyleJson ?? undefined}`.
- **Resize/invalidateSize**: BaseMap's gated `resizeTrigger` covers NodesTab's
  `MapResizeHandler`. Dashboard/MeshCore/Embed have none ⇒ omit `resizeTrigger` ⇒ handler not
  mounted (unchanged).
- **All view controllers stay `children`.** `MapCenterController`, `MapPositionHandler`,
  `ZoomHandler`, `TracerouteBoundsController`, `DefaultCenterController`, `WaypointMapEventBridge`
  (NodesTab), `MapBoundsUpdater` (Dashboard), `MeasureDistanceController`, `FollowController`
  (MapAnalysis) are all `useMap()` children — they render inside BaseMap's `{children}` unchanged.
  **Follow/fit-bounds is NOT touched** (epic-deferred): `FollowController`/`MapBoundsUpdater`/
  `TracerouteBoundsController` move verbatim into `children`, no generalization.
- **MeshCore key-remount recenter**: MeshCoreMap forces re-fit by keying its MapContainer
  `key={`${center}-${zoom}`}` (MeshCoreMap L413). With BaseMap, the caller keys the **BaseMap
  element** (`<BaseMap key={…} …>`) to remount the whole shell — same effect, no BaseMap change.
- **themeAwareDefault**: still not needed — every big map passes an explicit `tilesetId` from
  settings. Leave the P1 documented-but-unbuilt hook alone.

---

## 3. BaseMap adoption — per-map plan

All five adopt the pattern: `<BaseMap {...shellProps}>{controllers + overlays + layers}</BaseMap>`,
with map-specific NON-map siblings (placeholders, legends-outside, loading/error) left in the caller.

### 3.1 MapAnalysisCanvas (simplest — do first as the reference migration)
`MapAnalysisCanvas.tsx` is already fully layer-composed with a `<Pane>` z-order stack. Wrap:
- `<BaseMap center={center} zoom={zoom} tilesetId={mapTileset} customTilesets={customTilesets}
  showTilesetSelector onTilesetChange={setMapTileset}>` … existing `<Pane>`/controller children …
  `</BaseMap>`, kept inside the existing `<div className="map-analysis-canvas">`. `TimeSliderControl`
  / `MapLegend` / `FollowResumeButton` stay as siblings (they render outside MapContainer today).
- Removes the hand-rolled `MapContainer`+`TileLayer`+`getTilesetById`+sibling `TilesetSelector`
  (MapAnalysisCanvas L63–68, L110).

### 3.2 DashboardMap
- Shell props: `center={[defaultCenter.lat, defaultCenter.lng]} zoom={10} tilesetId={tilesetId}
  customTilesets={customTilesets} zoomControl showTilesetSelector={showTileSelector}
  onTilesetChange={setMapTileset}`.
- Children: `MapBoundsUpdater`, `MeasureDistanceController`, `NodeMarkersLayer`, the shared
  `TraceroutePathsLayer` ×2, `DashboardWaypoints`, `PolarGridOverlay` ×N, `GeoJsonOverlay`,
  `MapLegend`, and the promoted `NeighborLinksLayer` + `AccuracyRegionsLayer` adapters (§4).
- The `key={tilesetId}` remount is now handled by BaseMap (§2.1) ⇒ drop the inline TileLayer key.

### 3.3 MeshCoreMap
- Caller keys the shell: `<BaseMap key={`${center[0]}-${center[1]}-${zoom}`} center={center}
  zoom={zoom} tilesetId={mapTileset} customTilesets={customTilesets}
  showTilesetSelector={showTileSelector} onTilesetChange={setMapTileset}>`.
- Children: `MeasureDistanceController`, `MapLegend`, `GeoJsonOverlay`, `NodeMarkersLayer`,
  the history `<Polyline>`s (stay inline, §5.1/§5.3), the **hop-count path** `<Polyline>`s (stay
  inline + documented, §5.1), and the promoted MeshCore `NeighborLinksLayer` adapter (§4.1).
- Keep the `meshcore-map-pane` wrapper `<div>` around BaseMap.

### 3.4 EmbedMap (P6-deferred adoption)
- Shell props: `center={[centerLat, centerLng]} zoom={centerZoom} tilesetId={config.tileset}
  customTilesets={[]} zoomControl attributionControl` (Embed sets `attributionControl` explicitly).
  `getTilesetById(config.tileset, [])` resolves **identically** to the local `getEmbedTileset`
  (both hit `TILESETS[id]`/`DEFAULT_TILESET_ID`) — verified. No `showTilesetSelector` (Embed has no
  switcher; default false).
- **Context-free guarantee holds**: BaseMap never reads `useSettings()`, so it is safe inside the
  Embed bundle (no `SettingsProvider`). Palette stays `getSchemeForTileset(config.tileset)` in
  EmbedMap.
- Children: `GeoJsonOverlay`, shared `TraceroutePathsLayer`, inline neighbor `NeighborLinksLayer`
  adapter (§4.1), inline node `<Marker>`s (§6.5).
- Siblings/wrapping kept in EmbedMap: the `<style>{embedPopupCss}</style>` block, the loading/error
  states (render before BaseMap), and the bespoke hop-count legend overlay (L574–601).

### 3.5 NodesTab (LAST — its own PR, §8.1)
- Shell props: `center={mapDefaults.center} zoom={mapDefaults.zoom} tilesetId={activeTileset}
  customTilesets={customTilesets} styleJson={activeStyleJson ?? undefined}
  showTilesetSelector={shouldShowData() && showTileSelector} onTilesetChange={setMapTileset}
  resizeTrigger={`${showPacketMonitor}-${isNodeListCollapsed}-${packetMonitorHeight}`}`.
- Children: every controller (`MapCenterController`, `TracerouteBoundsController`,
  `DefaultCenterController`, `WaypointMapEventBridge`, `ZoomHandler`, `MapPositionHandler`,
  `MeasureDistanceController`), every overlay (`MapLegend`, `PolarGridOverlay`, `GeoJsonOverlay`,
  `DashboardWaypoints`), `NodeMarkersLayer`, the shared traceroute layers (via the local re-render
  wrappers, §7.4), the promoted `NeighborLinksLayer` + `AccuracyRegionsLayer` adapters, the inline
  estimated-uncertainty `<Circle>` (§5.2), and the position-history elements (§5.3).
- Kept as NodesTab siblings (outside BaseMap): the `no node locations` overlay (L2663–2671) and the
  `map-placeholder` overlay (L2672–2679).
- Removes the hand-rolled `MapContainer` (L2354–2377) + sibling `TilesetSelector` (L2657–2662),
  which duplicate BaseMap almost exactly.

---

## 4. Layer-by-layer promotion design

### 4.1 `NeighborLinksLayer` — NEW `src/components/map/layers/NeighborLinksLayer.tsx`

**Duplication being removed:** 7 inline/near-inline renderings of "one `<Polyline>` per neighbor
edge between two positioned nodes" — plus, in 2 of them, direction arrows; plus, in several,
identical `snrToOpacity` helpers and unordered-pair dedup.

**Design — descriptor-based, mirroring `NodeMarkersLayer` (PURE REFACTOR):** the shared layer owns
the mechanics; each consumer supplies fully-styled descriptors so its exact current look is
preserved byte-for-byte.

```ts
export interface NeighborLinkDescriptor {
  key: string;
  positions: [[number, number], [number, number]];
  pathOptions: L.PathOptions;      // color / weight / opacity / dashArray — consumer-owned
  className?: string;              // e.g. NodesTab's `neighbor-line node-X node-Y` hover hook
  arrows?: {                       // NodesTab-only today; optional
    color: string;
    fractions?: number[];         // default [0.25, 0.5, 0.75]
  };
  children?: React.ReactNode;      // <Popup>… (Dashboard/NodesTab/Embed) — omit for select-only
  eventHandlers?: L.LeafletEventHandlerFnMap; // MapAnalysis click→setSelected
}
export function NeighborLinksLayer({ links }: { links: NeighborLinkDescriptor[] }): JSX.Element;
```

The layer renders, per descriptor: the `<Polyline positions pathOptions className eventHandlers>`
with `children` inside, and (when `arrows`) the non-interactive `<Marker icon={createArrowIcon(
bearing, arrows.color)} interactive={false}>` decorations at the interpolated fractions (bearing
math extracted from NodesTab L2583–2589 into a shared helper).

**Shared helpers — NEW `src/utils/neighborLinks.ts`** (leaflet-free where possible):
- `snrToNeighborOpacity(snr: number | null): number` — the `null→0.4, clamp((snr+10)/20,0.2,1)`
  form used verbatim by DashboardMap L95, MapAnalysis `NeighborLinksLayer`/`MeshCoreNeighborLinksLayer`,
  MeshCoreMap. (NodesTab uses a different 4-tier SNR→weight/opacity table L2556–2562 — that stays in
  the NodesTab adapter as its `pathOptions` computation; do NOT force it onto the shared helper.)
- `dedupByUnorderedPair<T>(items, keyA, keyB)` — the canonical `a<b?"a~b":"b~a"` dedup used by
  DashboardMap meshtastic (#3777) and MeshCore segments (L344), MapAnalysis, etc.
- `neighborArrowFractions` + `bearingBetween(a, b)` for the arrow decorations.

**Per-consumer adapters (each keeps its exact look — empty visible-changes):**
- **MapAnalysis** `NeighborLinksLayer.tsx` + `MeshCoreNeighborLinksLayer.tsx` → become thin
  adapters: keep all data wiring (`useNeighbors`/`useMeshCoreNeighbors`, cross-source #3792
  fallback, time-window filter) and emit descriptors with `pathOptions` = today's values
  (`transportColor`/`#06b6d4`, weights 1/1.5, dash `'4 4'`/`'6 4'`, opacity `snrToNeighborOpacity`)
  and `eventHandlers.click → setSelected(...)`, no `children`.
- **DashboardMap** meshtastic links → adapter emitting `pathOptions` = today (transport color
  `blue`/`#22c55e`/`#f97316`, bidirectional `w2/o.6` solid vs `w1/o.6` dash `'5, 5'`),
  `children={<DashboardNeighborPopup link={link} />}`, `dedupByUnorderedPair`.
- **DashboardMap** MeshCore links → adapter emitting `#06b6d4/w1.5/o=snrToNeighborOpacity/dash '6 4'`,
  no children.
- **MeshCoreMap** neighbor lines → adapter emitting `#06b6d4/w1.5/o.7/dash '6 4'` +
  `children={<Tooltip sticky>{label}</Tooltip>}`.
- **EmbedMap** → adapter emitting `#f5a623/w3/o.7/dash '5,5'` + inline `<Popup>` children.
- **NodesTab** → adapter emitting `pathOptions` from its 4-tier SNR table + `overlayColors.neighborLine`,
  `className` for hover-dim, `arrows` (unidirectional only), `children={<Popup>…rich…</Popup>}`,
  zoom-gated (`mapZoom < neighborInfoMinZoom → []`).

Result: zero inline neighbor `<Polyline>` in the big four + Embed; each surface pixel-identical.
See §6.1 for the escalated question of whether to ALSO converge the looks in this phase.

### 4.2 `AccuracyRegionsLayer` — NEW `src/components/map/layers/AccuracyRegionsLayer.tsx`

**Duplication:** MapAnalysis `AccuracyRegionsLayer` and DashboardMap L500–521 render an **identical**
gray precision-cell `<Rectangle>` (`#888`, `fillOpacity 0.08`, `opacity 0.5`, `weight 1`) computed
from `precisionCellBounds` + `hasAccuracyCell`; NodesTab L2444–2505 renders the same rectangle
**hop-colored** (`getHopColor`) instead of gray.

**Design — props-based (data-shaped, like the MapAnalysis layer):**
```ts
export interface AccuracyRegionDescriptor {
  key: string;
  bounds: [[number, number], [number, number]];
  pathOptions?: L.PathOptions;   // default = canonical gray {#888, 0.08, 0.5, weight 1}
}
export function AccuracyRegionsLayer(
  { regions }: { regions: AccuracyRegionDescriptor[] }
): JSX.Element;
```
The layer maps `regions → <Rectangle>`; the default `pathOptions` is the canonical gray so
MapAnalysis/Dashboard adapters pass only `{key, bounds}`. NodesTab passes its hop-colored
`pathOptions` per region (deliberate parameter — the box ties visually to its hop-colored marker).
- **MapAnalysis** `AccuracyRegionsLayer.tsx` → thin adapter over the new shared layer (keeps
  `useAnalysisNodes` + un-offset `resolveNodeLatLng` center note).
- **DashboardMap** → adapter (keeps `getNodeLatLng` true-center + `hasAccuracyCell` filter).
- **NodesTab** → adapter (keeps its precision-bits bounds math L2464–2485 or, preferably, switches
  to the shared `precisionCellBounds` if outputs match — verify equality; if they differ, keep
  NodesTab's inline bounds math and only share the `<Rectangle>` render).

`precisionCellBounds`/`hasAccuracyCell` already live in `src/utils/precisionOffset` — reuse, do not
duplicate.

### 4.3 `WaypointsLayer` — RELOCATE to `src/components/map/layers/WaypointsLayer.tsx`

Waypoints are **already shared** via `PerSourceWaypoints` — they just live in the MapAnalysis
directory. Move the file (`PerSourceWaypoints`, `emojiDivIcon`, `ensureEmojiPresentation`,
`formatExpire`, `SourceInfo`, `WaypointPopupActions`, and the default `WaypointsLayer` export) to
`src/components/map/layers/WaypointsLayer.tsx`. Update the three importers
(`MapAnalysisCanvas`, `DashboardWaypoints`, and transitively NodesTab via `DashboardWaypoints`).
- Pure move; **no behavior change, no visible change.** Keep `WaypointsLayer.test.tsx` alongside.
- Optionally leave a one-line re-export shim at the old path if churn is a concern — but prefer a
  clean move + import updates (only 2 direct importers).

---

## 5. Divergent-by-design & single-consumer — documented, NOT promoted

### 5.1 MeshCore hop-count path lines (MeshCoreMap L442–455) — DIVERGENT
Star topology from the local node to each contact, colored **and** dashed by `pathLen`
(`PATH_COLORS` direct/short/long/unknown; solid for 0-hop, dash `'8 4'` otherwise). No analogue on
any other map (nothing else draws local→node lines keyed on path-length). **Leave inline; add a
header/inline comment** citing the Phase-2 lesson and epic §Phases. This is the "hop-count concept"
the phase brief flagged as likely divergent — confirmed divergent.

### 5.2 NodesTab estimated-position uncertainty `<Circle>` (L2412–2442) — SINGLE-CONSUMER
Only NodesTab renders estimated-position uncertainty radii (`estimatedUncertainty * 1000` m,
hop-colored, `fillOpacity 0.1`, `opacity 0.4`, `weight 2`, dash `'5, 5'`). No second consumer ⇒
**leave inline** (promotion would be a speculative one-consumer abstraction). It moves into BaseMap
`children` unchanged during the NodesTab shell adoption. (Optional tidy: co-locate it as a private
`EstimatedUncertaintyCircles` component within NodesTab to shrink the JSX — cosmetic, low priority.)

### 5.3 Position history / trails — THREE deliberately different visualizations
- **NodesTab** (L532–609): single **selected** node, per-segment age gradient
  (`getPositionHistoryColor`), spline vs straight (`generateHeadingAwarePath`), points-only mode,
  per-fix dots + ≤30 heading arrows + per-segment popups (`generatePositionHistoryArrows`).
  Single-consumer of this rich single-node form. **Leave** (the reusable pieces are already shared
  helpers in `mapHelpers`).
- **MapAnalysis `PositionTrailsLayer`**: **many** nodes, one hash-colored polyline each,
  whole-trail click-select, no arrows. Already documented divergent-by-design in Phase 2
  (§1.4 of P2 spec) — **respect that verdict; no change.**
- **MeshCoreMap** (L434–440): **many** MeshCore nodes, arrowless age-gradient trail segments;
  reuses only `getPositionHistoryColor`. Distinct from both. **Leave inline; add a one-line comment**
  noting the multi-node/arrowless divergence and that it deliberately reuses only the color helper.

No shared rendering can be extracted here without fusing genuinely different features (single-vs-
multi node, arrows-vs-none, age-gradient-vs-hash-color). Evidence has not changed since Phase 2, so
the Phase-2 divergence verdict stands.

---

## 6. Approved visible changes & escalations

**Default posture: PURE REFACTOR, empty visible-changes list** (Phase-4 playbook). The descriptor/
props promotions in §4 preserve every surface's exact look; the BaseMap adoptions in §3 preserve
tiles/controllers. The following are the only items with any visible surface:

### 6.1 ESCALATED DECISION — neighbor-link look convergence (NOT decided here)
The epic interview decided "one canonical look per feature everywhere." Neighbor links currently
diverge in RF color (`overlayColors.neighborLine` amber on NodesTab, `blue` on Dashboard, `#06b6d4`
on MapAnalysis, `#f5a623` on Embed), dash (`'5, 5'` vs `'4 4'` vs `'6 4'`), and SNR→weight/opacity
encoding. §4.1's descriptor design **eliminates the code duplication while preserving each look**,
satisfying the "no inline reimplementations" exit criterion at minimum risk.

- **Recommendation:** ship §4.1 as a **pure refactor first** (empty visible changes). Treat full
  look-convergence (transportClass coloring + one dash + one SNR encoding everywhere) as a **small,
  clearly-scoped follow-up** — it is a visible change to **public embeds** and the long-established
  NodesTab look, and bundling it into the already-large NodesTab PR raises risk. **Orchestrator
  decides** whether to (a) defer convergence to a follow-up issue, or (b) fold a defined
  approved-visible-changes list into PR-A/PR-B. If (b), the canonical proposal is: RF `#06b6d4`,
  MQTT `#22c55e`, UDP `#f97316` (the Dashboard/MapAnalysis transport palette, ideally lifted into
  `overlayColors` like the P3 SNR scale), dash `'6 4'`, `snrToNeighborOpacity`, bidirectional →
  solid+`weight 2`, arrows NodesTab-only.

### 6.2 Waypoints relocation (§4.3): no visible change (pure move).
### 6.3 Accuracy regions (§4.2): no visible change (canonical gray preserved for MapAnalysis/Dashboard;
NodesTab keeps hop-color via `pathOptions`).
### 6.4 BaseMap tile-key (§2.1): no visible change (validated against the 4 editors + adopters).
### 6.5 EmbedMap node markers stay INLINE — NOT migrated to `NodeMarkersLayer`.
The exit criterion targets the **big four**; Embed is a separate, context-free bundle. Its inline
`<Marker>`+`<Tooltip>`+`<Popup>` has no spiderfy/age-fade and a bespoke self-contained popup; forcing
it onto `NodeMarkersLayer` (which assumes app CSS/spiderfy/descriptors) is scope creep with visible
risk. **Document Embed markers as an accepted single-consumer inline** in this spec; leave for a
future issue if ever wanted. (Embed's neighbor links DO promote, §4.1, because that's cheap.)

---

## 7. Test plan

Follow the epic's established test posture: unit/fixture tests for shared layers + adapters; full
Vitest suite green (0 failures); browser validation on every map view.

### 7.1 New shared-layer tests
- `map/layers/NeighborLinksLayer.test.tsx`: renders N descriptors → N `<Polyline>`; `pathOptions`
  passthrough (color/weight/opacity/dashArray); `className` applied; `arrows` produces the expected
  non-interactive arrow markers at the fractions with `createArrowIcon`; `children` (popup) mounts;
  `eventHandlers.click` fires. Empty list → nothing.
- `utils/neighborLinks.test.ts`: `snrToNeighborOpacity` boundary table (null→0.4, −10→0.2 floor,
  +10→1 ceil, mid); `dedupByUnorderedPair` collapses A~B/B~A; `bearingBetween` cardinal cases.
- `map/layers/AccuracyRegionsLayer.test.tsx`: regions → `<Rectangle>` with default gray vs supplied
  `pathOptions`; empty → nothing.
- `map/layers/WaypointsLayer.test.tsx`: **moved** with the file; adjust import paths only.

### 7.2 Adapter parity tests (pixel-parity guard, Phase-4 style)
For each migrated consumer, assert the emitted descriptors reproduce the pre-migration
`pathOptions`/arrows/children. Where a consumer has an existing render test
(`AccuracyRegionsLayer.test`, `NeighborLinksLayer.test` in MapAnalysis, DashboardMap tests,
EmbedMap render tests from P6), update it to run against the adapter and keep asserting the same
Polyline/Rectangle props. Add a NodesTab neighbor-adapter unit test pinning the 4-tier SNR
weight/opacity table and the unidirectional-arrow gate.

### 7.3 BaseMap adoption tests
- Extend `BaseMap.test.tsx` for §2.1 (tile remount on `tilesetId` change).
- For each adopting map, keep/adjust its existing render test to assert it still renders the tile
  branch (mock `VectorTileLayer` + `getTilesetById` per the P1 pattern) and mounts its children
  (markers/layers/controllers). Assert Embed still works with **no `SettingsProvider`** (mount under
  a bare tree — regression guard that BaseMap didn't sneak in a `useSettings()`).

### 7.4 Housekeeping
- NodesTab's local re-render wrappers `TraceroutePathsLayer`/`SelectedTracerouteLayer` (L145–155)
  **shadow the shared layer's name** and are pass-throughs of pre-built nodes. **Rename** to
  `TraceroutePathsContainer`/`SelectedTracerouteContainer` (clarity only; not a promotion). Verify
  the `React.memo` custom-compare in NodesTab's `arePropsEqual` (L2797+) still references them.

### 7.5 Browser validation matrix (exit criterion — every view)
Validate on the dev container (`docker-compose.dev.yml`, load `http://localhost:8080`), against
pre-migration screenshots:
1. **NodesTab** — tiles (raster + a vector tileset), markers + spiderfy fan (obscured-marker
   fix #3685/40b6b1e6/ade691b1 intact), neighbor lines + arrows + hover-dim + popup, accuracy
   rectangles (hop-colored) + estimated `<Circle>`s, position history (spline + points-only +
   dots/arrows/popup), waypoints, traceroute base + selected, tileset selector, resize on
   packet-monitor toggle, measure tool.
2. **DashboardMap** — markers + fan, meshtastic neighbor links (bidirectional solid vs dashed) +
   `DashboardNeighborPopup`, MeshCore neighbor links, accuracy rectangles, waypoints, traceroute
   ×2, polar grid, tileset swap (verify §2.1 remount).
3. **MapAnalysisCanvas** — all Panes/z-order intact, neighbor (mt + MeshCore) click→inspector,
   accuracy squares beneath offset markers, waypoints, trails, follow controller unaffected.
4. **MeshCoreMap** — markers (role badges — re-verify live per the P4 note, both meshcore sources
   were down in P4 validation), hop-count path lines (colors + dash), neighbor lines, position
   history trails, recenter-on-select (BaseMap key remount), measure, legend.
5. **EmbedMap** — via a real embed iframe: tiles, inline markers + popup, traceroute (canonical
   SNR palette from P6), neighbor links, geojson, hop legend — with NO app CSS/SettingsProvider
   (console clean; remember the P6 gotcha: neighbor/traceroute fetch gates on the profile's
   `showPaths`/`showNeighborInfo` flags).

Console must be clean on every view. Any meshcore source down at validation time → note it and
re-verify when one connects (as P4 did).

---

## 8. Work packages & dependency graph

### 8.1 PR-split proposal (ORCHESTRATOR DECISION)
~14 WPs, aggregate diff > 2.5k lines. **Recommend 2 PRs**, matching the epic's "NodesTab last":

- **PR-A — Layer library + Dashboard/MeshCore/Analysis/Embed** (WP1–WP10, WP14): promote the
  shared layers, migrate the three non-NodesTab big maps + Embed onto them and onto BaseMap.
- **PR-B — NodesTab sweep** (WP11–WP13): NodesTab consumes the shared layers and adopts BaseMap
  (the riskiest single file, isolated), plus the local-wrapper rename. Depends on PR-A merged.

Both target `4049-map-refactor`. If the orchestrator prefers one PR, the WP order is unchanged;
the split is purely a review-surface risk reduction.

### 8.2 Work packages

**Foundation (no consumer risk):**
- **WP1** — `utils/neighborLinks.ts` (`snrToNeighborOpacity`, `dedupByUnorderedPair`,
  `bearingBetween`, arrow fractions) + tests. *(no deps)*
- **WP2** — `map/layers/NeighborLinksLayer.tsx` (descriptor layer + arrow rendering) + tests.
  *(deps: WP1)*
- **WP3** — `map/layers/AccuracyRegionsLayer.tsx` (props layer, canonical gray default) + tests.
  *(no deps)*
- **WP4** — Relocate `WaypointsLayer` → `map/layers/`; update 2 importers + moved test. *(no deps)*
- **WP5** — BaseMap §2.1 tile-key addition + `BaseMap.test.tsx` update. *(no deps)*

**Consumer migration onto shared layers (PR-A):**
- **WP6** — MapAnalysis `NeighborLinksLayer` + `MeshCoreNeighborLinksLayer` → thin adapters over
  WP2; `AccuracyRegionsLayer` → adapter over WP3; update MapAnalysis layer tests. *(deps: WP2,WP3)*
- **WP7** — DashboardMap neighbor links (mt + MeshCore) + accuracy rectangles → adapters over
  WP2/WP3; update Dashboard tests. *(deps: WP2,WP3)*
- **WP8** — MeshCoreMap neighbor lines → adapter over WP2; document hop-count path lines +
  position-history divergence (§5.1/§5.3). *(deps: WP2)*
- **WP9** — EmbedMap neighbor links → adapter over WP2; document inline markers (§6.5). *(deps: WP2)*

**BaseMap adoption (PR-A):**
- **WP10** — MapAnalysisCanvas, DashboardMap, MeshCoreMap, EmbedMap adopt BaseMap (§3.1–3.4);
  update each render test. *(deps: WP5; WP6–WP9 for the same files where layers also change —
  sequence per file to avoid churn)*

**NodesTab (PR-B):**
- **WP11** — NodesTab neighbor links → adapter over WP2 (4-tier SNR pathOptions, arrows, hover
  className, popup, zoom gate) + accuracy rectangles → adapter over WP3 (hop-colored pathOptions);
  keep estimated `<Circle>` inline. *(deps: WP2,WP3 merged in PR-A)*
- **WP12** — NodesTab adopts BaseMap (§3.5); placeholders stay siblings. *(deps: WP5,WP11)*
- **WP13** — Rename local `TraceroutePathsLayer`/`SelectedTracerouteLayer` wrappers (§7.4);
  co-locate estimated-uncertainty circles (optional). *(deps: WP12)*

**Cross-cutting:**
- **WP14** — Divergence-doc comments (MeshCore hop-count + trails, PositionTrailsLayer already
  done in P2) + epic Phase-7 log entry on completion. *(folds into PR-A/PR-B as touched)*

Critical path: WP1→WP2→{WP6,WP7,WP8,WP9,WP11}; WP5→WP10/WP12. WP3/WP4/WP5 parallel to WP1/WP2.

---

## 9. Risks

- **Neighbor-link parity drift (highest).** 7 renderers with subtle per-map styling. Mitigation:
  descriptor pattern keeps `pathOptions` consumer-owned (no forced convergence); adapter parity
  tests pin each; browser-validate every surface. Do NOT let convergence (§6.1) sneak in unapproved.
- **Spiderfy / marker-ref regressions.** BaseMap adoption reparents markers under a new shell.
  The #3685 marker-registration-timing and obscured-marker fix (40b6b1e6/ade691b1) bind anything
  touching markers — but Phase 7 does NOT change `NodeMarkersLayer`; markers just move into
  `children`. Verify fans still open on NodesTab/Dashboard/MapAnalysis/MeshCore post-adoption.
- **nodes.css cascade.** If any promoted layer's popup/marker CSS is touched, respect the
  `nodes.css` cascade-order gotcha (base `.map-controls` declared AFTER the mobile `@media` block).
  Phase 7 should need no `nodes.css` change (waypoint popup reuses existing `.node-popup-*`).
- **EmbedMap context-free break.** BaseMap must never gain a `useSettings()` call; guard with a
  no-`SettingsProvider` mount test (§7.3). Palette stays `getSchemeForTileset`.
- **Tile remount behavior (§2.1).** Verify the new tile `key` doesn't cause a visible re-flash on
  the 4 Phase-1 editors (it won't — constant id) or on normal pan/zoom (key only changes on tileset
  swap).
- **MeshCore recenter via BaseMap key.** Moving the remount key from MapContainer to the BaseMap
  element must still re-fit on node-select; browser-validate.
- **NodesTab size/PR-B blast radius.** 2841-line file, ~6 map concerns changing. Mitigation: PR-B
  isolates it; migrate concern-by-concern (neighbor, accuracy, shell) with the suite green between.
- **`precisionCellBounds` equality (NodesTab).** If NodesTab's inline bounds math (L2464–2485)
  differs numerically from `utils/precisionOffset.precisionCellBounds`, keep NodesTab's math and
  share only the `<Rectangle>` render — verify with a fixture before switching.

---

## 10. Orchestrator decisions requested

1. **Approve the 2-PR split** (§8.1): PR-A (layer library + Dashboard/MeshCore/Analysis/Embed),
   PR-B (NodesTab). *(Recommended.)*
2. **Neighbor-link convergence (§6.1):** ship the promotion as a **pure refactor** and defer full
   look-convergence to a follow-up issue *(recommended)*, OR fold the canonical
   transport-color/dash/SNR convergence into this phase as a defined approved-visible-changes list
   (touches public embeds + NodesTab). Pick one.
3. **Confirm EmbedMap keeps inline node markers** (§6.5) — not migrated to `NodeMarkersLayer` this
   phase. *(Recommended.)*
4. **Confirm position history stays un-promoted** (§5.3) — three divergent-by-design visualizations,
   Phase-2 verdict unchanged, only comments added. *(Recommended.)*
5. **WaypointsLayer relocation** (§4.3): clean move + import updates *(recommended)* vs. leave a
   re-export shim at the old path.


---

## Orchestrator resolutions (gate review 2026-07-10)

- **2-PR split APPROVED**: PR-A = layer library + BaseMap tile-key addition + Dashboard/
  MeshCore/MapAnalysis/EmbedMap adoptions; PR-B = NodesTab (last). Both PRs target
  4049-map-refactor.
- **§6.1 → pure-refactor promotion now; neighbor-link visual convergence DEFERRED** to a
  scoped follow-up issue (it changes public embeds + established looks; deserves its own
  decision). Recorded in the epic doc's Deferred section. Exit criterion "no inline
  reimplementations" is satisfied by the promotion.
- §10 confirmations: EmbedMap keeps its inline markers (embed marker unification NOT in
  scope); position history stays per the Phase-2 divergence verdict; WaypointsLayer =
  clean move with importers updated (no shim — internal component).
- Phase-4 marker/spiderfy rules and the nodes.css cascade gotcha remain binding.
