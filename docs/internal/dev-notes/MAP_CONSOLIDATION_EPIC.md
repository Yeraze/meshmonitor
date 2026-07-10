# Map Consolidation Epic — Issue #4047

**Status:** In progress (started 2026-07-10)
**Tracking issue:** https://github.com/Yeraze/meshmonitor/issues/4047
**Orchestration:** /epic harness — one phase = one merged PR, phases strictly sequential.

**Branch strategy (user decision 2026-07-10):** all phase PRs target the long-lived
integration branch **`4049-map-refactor`** (cut from main at 3e3d50f8), NOT main.
Phase worktrees branch FROM `origin/4049-map-refactor` (so each phase builds on the
merged prior phases). Main receives ONE final PR merging the combined integration
branch after all phases complete and are validated together. Keep `4049-map-refactor`
periodically synced with main (merge main INTO it) to avoid a giant final conflict.

## Goal

Consolidate MeshMonitor's 10 independent Leaflet map implementations (~8,000 LOC) into a
shared `BaseMap` shell + composable layer library under `src/components/map/`, so fixes to
markers, popups, spiderfy, tiles, and traceroute rendering land everywhere by construction.

## Interview decisions (2026-07-10)

| Decision | Answer |
|---|---|
| Scope/order | As filed: shell first, then forks, traceroutes, popups, layer library. Follow/fit-bounds controller (old "Phase 6") **deferred to a future issue** — not in this epic. |
| Canonical SNR→color scale | **4-band** (≥5 green / ≥0 yellow / ≥-5 orange / <-5 red), made **theme-aware** (hex values move into the theme palette, not hardcoded). Nodes map changes from its 3-band scale. |
| Embed map | **Align fully** — extend the embed traceroute API to carry SNR/leg data and render through the shared layer. (Own phase, due to backend scope.) |
| Visual convergence | **One canonical look per feature** everywhere. Per-map differences survive only as deliberate layer parameters (Map Analysis occurrence weighting, widget hover-highlight, arrows on/off). No case-by-case appearance approvals needed. |

## Ground-truth survey (2026-07-10)

- 10 `MapContainer` instances: NodesTab (~1,500 LOC map code), DashboardMap (977),
  MeshCoreMap (756), MapAnalysisCanvas + 10 layers (~1,600), TracerouteWidget (641),
  EmbedMap (660), GeofenceMapEditor (541), BBoxMapEditor (362), DefaultMapCenterPicker (114),
  EmbedSettings inline picker (~120).
- Shared today: `MeasureDistanceController`, `SpiderfierController`/`useMarkerSpiderfier`,
  `TilesetSelector`, `GeoJsonOverlay`, `MapLegend`, `PolarGridOverlay`, `mapIcons.ts`,
  `mapHelpers.tsx`, `tilesets.ts`, `useTraceroutePaths`.
- Forks: `MapAnalysis/MapLegend.tsx`, `MapAnalysis/layers/PolarGridLayer.tsx`,
  `PositionTrailsLayer` (reimplements position-history rendering).
- Traceroutes: 5 independent renderers, 3 SNR color scales, 4 dash conventions,
  3 weight formulas; DashboardMap never renders the return leg; EmbedMap segments are
  server-computed (`/api/embed/:id/traceroutes`).
- Popups: 3 families — `NodePopup`, `DashboardNodePopup` (Dashboard + Map Analysis since
  #3692), `MapNodePopupContent` (NodesTab only).
- Only NodesTab supports MapLibre vector tiles (`VectorTileLayer`).
- Leaflet default-icon fix duplicated in `App.tsx` and `EmbedSettings.tsx`.

**Phase restructure (user directive 2026-07-10):** rendering unification broadened beyond
traceroutes — node markers and node popups are pulled forward as their own phases. Data
shown in popups and role icons legitimately differ by source technology (Meshtastic vs
MeshCore); those differences become explicit parameters/composition of ONE system, never
parallel implementations. New order: P3 traceroutes → P4 node markers → P5 popups →
P6 embed traceroute alignment → P7 residual layers + big maps on BaseMap.

## Phases

### [x] Phase 1 — `BaseMap` shell (`feature/4047-p1-basemap-shell`)
Create `src/components/map/BaseMap.tsx`: `MapContainer` + raster `TileLayer` /
`VectorTileLayer` selection via `tilesets.ts` + optional `TilesetSelector` + resize/center
handling + Leaflet default-icon fix, theme-aware defaults. Migrate the four simple maps
(DefaultMapCenterPicker, EmbedSettings inline picker, BBoxMapEditor, GeofenceMapEditor);
architect may include the big maps' shells if low-risk, else they adopt in later phases as
each is touched.
**Exit criteria:** BaseMap exists with tests; ≥4 maps migrated; every migrated map still
renders tiles/markers/draw tools identically (browser-validated); typecheck + full Vitest
suite green; vector-tile support works through the shell.

### [x] Phase 2 — Reconcile the Map Analysis "forks" (`feature/4047-p2-unfork-analysis`)
**Premise corrected on investigation (2026-07-10, user-approved retarget):** of the three
claimed forks, only one contains real drift.
- `layers/PolarGridLayer.tsx` — NOT a fork: a thin per-source adapter that already renders
  the shared `PolarGridOverlay` (consolidated by #3971). No action; document.
- `layers/PositionTrailsLayer.tsx` — genuinely different feature (multi-node trails,
  hash-color per node) vs the shared single-node age-gradient history. Deliberate
  divergence; document in-file.
- `MapAnalysis/MapLegend.tsx` — layer-driven legend, ~90% disjoint from the shared static
  `MapLegend`; the one real drift is `RoleIcon` hand-wrapping `roleGlyphInnerSvg` in its
  own SVG shell duplicating `roleGlyphMarkerSvg`. Dedupe that; document the rest.
**Scope:** glyph dedupe in the analysis legend + divergence-documenting comments in all
three files + this epic-doc correction. See `MAP_CONSOLIDATION_P2_SPEC.md` (Option A).
**Exit criteria:** analysis legend renders pixel-identical node-type glyphs through the
shared helper (browser-validated); the three files carry not-a-fork/deliberate-divergence
comments; suite green.

### [x] Phase 3 — Traceroute unification, app maps (`feature/4047-p3-traceroute-unify`)
(a) Canonical 4-band theme-aware SNR→color scale + one weight + one dash convention in
`mapHelpers`; delete `DashboardMap.snrToColor`, `MapAnalysis.snrQualityColor`, hardcoded
palettes; the Map Analysis legend SNR section consumes the canonical mapping. (b) Shared
`src/components/map/layers/TraceroutePathsLayer.tsx` owning geometry, curvature, arrows,
forward/return legs, MQTT/unknown-SNR dashing — parameterized for weight strategy
(usage/occurrence/SNR), arrows, direction-vs-SNR color mode, hover-highlight. Consumed by
NodesTab (base + selected route), DashboardMap (gains return legs), Map Analysis,
TracerouteWidget.
**Exit criteria:** one SNR scale everywhere; all four app maps render traceroutes through
the shared layer; #1862/#2051/#2931 behaviors preserved in one place with tests;
browser-validated on all four views; suite green.

### [ ] Phase 4 — Node marker unification (`feature/4047-p4-marker-unify`)
One icon factory in `src/components/map/` unifying `createNodeIcon` (Meshtastic
hop-colored) and MeshCoreMap's hand-rolled `L.divIcon` around `roleGlyphMarkerSvg`
(MeshCore role glyphs) behind one API; one shared `NodeMarkersLayer` (spiderfy + icon
cache built in, generalized from MapAnalysis's) consumed by NodesTab, DashboardMap,
MeshCoreMap, MapAnalysis. Source-tech icon differences are parameters of the one factory.
**Exit criteria:** no hand-rolled node-marker divIcon outside the factory; the four maps
render markers through the shared layer; spiderfy behavior preserved (incl. the
obscured-marker fix, commits 40b6b1e6/ade691b1); browser-validated; suite green.

### [ ] Phase 5 — Popup unification (`feature/4047-p5-popup-unify`)
One popup family: shared card chrome + composable data sections. Meshtastic sections
(hops/SNR/battery/hardware) vs MeshCore sections (path length/scope/etc.) become section
composition, not separate components. NodesTab migrates off `MapNodePopupContent` (delete
it); MeshCore popup content joins the family; `NodePopup`/`DashboardNodePopup` reconciled.
**Exit criteria:** `MapNodePopupContent` deleted; one popup family renders all maps'
popups with no capability loss; browser-validated per source tech; suite green.

### [ ] Phase 6 — Embed traceroute alignment (`feature/4047-p6-embed-traceroutes`)
Extend `/api/embed/:id/traceroutes` to carry per-segment SNR + leg/direction data
(backward-compatible), render EmbedMap traceroutes through the shared
TraceroutePathsLayer with the canonical SNR scale.
**Exit criteria:** public embeds show the same traceroute visuals as the app; old embed
clients don't break; API + rendering tests; browser-validated via an embed iframe;
suite green.

### [ ] Phase 7 — Residual layer library + big maps on BaseMap (`feature/4047-p7-layer-library`)
Promote neighbor links, waypoints, accuracy regions, position trails into
`src/components/map/layers/`; DashboardMap, MeshCoreMap, MapAnalysis, NodesTab compose
them and adopt the BaseMap shell; NodesTab migrates **last**. May split into multiple PRs
— flag to orchestrator first.
**Exit criteria:** no inline layer reimplementations in the big four; all maps on BaseMap;
browser-validated on every map view; suite green.

## Deferred (future issues, not this epic)

- Shared follow/fit-bounds controller (generalize `FollowController`/`followMath` + five
  hand-rolled fit-bounds implementations).

## Phase log

(Per-phase: PR link, deviations, decisions — appended as phases complete.)

### Phase 3 (2026-07-10) — Traceroute unification, app maps
- Delivered: canonical 4-band theme-aware SNR scale (WCAG-AA-verified light palette);
  `src/utils/tracerouteSegments.ts` (leaflet-free single home for #1862/#2051/#2931 +
  sentinel constants + `isValidRouteNode` + `buildLiveNodePositionMap` +
  `averageNonSentinelSnr`); shared `src/components/map/layers/TraceroutePathsLayer.tsx`
  (4 color modes incl. `mqttColor`, 3 weight strategies, canonical `'3,6'` dash,
  curvature number-or-fn, arrows, temporal fade, highlight, React.memo). All four app
  renderers migrated: NodesTab (base+selected), DashboardMap (return legs + /4 SNR
  scaling fix + MQTT dash), TracerouteWidget (theme legs), MapAnalysis (thin adapter,
  legend on canonical palette).
- Latent bugs fixed along the way: Dashboard colored by UN-scaled SNR; snapshot
  positions dropped at lat/lng exactly 0 (truthy checks); live positions same (now
  shared helper, Null-Island guard retained); Dashboard never rendered return legs.
- 8-angle review + verify found 2 introduced regressions (return-only traceroutes;
  widget MQTT weight) and 1 unapproved visual change (MQTT color distinction lost) —
  all fixed; MQTT color is now canonical on ALL maps via `mqttColor` (previously
  NodesTab-only). 10 findings total, all fixed (see PR).
- Visible changes shipped: NodesTab 3→4 band; no-data segments noData-gray dashed
  (was solid mauve); Dashboard gains return legs + MQTT color/dash; widget legs use
  theme traceroute pink (direction via arrows); Analysis dash '4,6'→'3,6'.
- Browser-validated on all four surfaces against pre-migration baselines (screenshots
  in session scratchpad); suite 9,431 tests green; lint ratchet clean.
- Note for Phase 6 (embed): EmbedMap still fixed-mauve server-computed segments.
- Deferred (parity, not regressions): eager per-segment popup construction (recharts
  trees built for all segments); popup laziness would be a perf follow-up.

### Phase 2 (2026-07-10) — Reconcile the Map Analysis "forks"
- **Premise corrected (user-approved retarget):** PolarGridLayer was never a fork (#3971
  adapter over shared PolarGridOverlay); PositionTrailsLayer is a deliberately different
  visualization (multi-node hash-colored trails vs single-node age-gradient history);
  the analysis MapLegend is a layer-driven legend ~90% disjoint from the shared static one.
- Delivered: analysis-legend `RoleIcon` deduped onto shared `roleGlyphMarkerSvg` (render-
  identical, DOM-verified); not-a-fork / deliberate-divergence header comments in
  MapAnalysis/MapLegend.tsx and PositionTrailsLayer.tsx; regression test pinning the
  legend glyphs to the shared helper. Spec: `MAP_CONSOLIDATION_P2_SPEC.md`.
- Note for Phase 3: the analysis legend's SNR section reflects the 4-band palette — when
  Phase 3 centralizes the SNR scale, this legend must consume the canonical mapping.

### Phase 1 (2026-07-10) — BaseMap shell
- Delivered: `src/components/map/BaseMap.tsx` + `leafletDefaultIcon.ts` + tests; migrated
  DefaultMapCenterPicker, EmbedSettings preview picker, BBoxMapEditor, GeofenceMapEditor.
  Big-map shell adoption deferred to later phases per spec (`MAP_CONSOLIDATION_P1_SPEC.md`).
- **Decision — theme-aware default deferred:** no theme→tileset mapping exists in the
  codebase; wiring one into BaseMap would have visibly changed the four OSM editors
  (Phase-1 violation). BaseMap defaults to `DEFAULT_TILESET_ID` unconditionally; a future
  opt-in `themeAwareDefault` prop is documented in the spec for big-map adoption.
- **Decision — canonical default marker = Leaflet PNG.** The two deleted icon-fix copies
  fought over the global `L.Icon.Default`; due to ES module eval order (EmbedSettings
  evaluates before App.tsx top-level code), the App.tsx SVG teardrop actually won at
  runtime. The only bare default `<Marker>` in the codebase (EmbedSettings preview)
  therefore visibly changed from the 24px SVG teardrop to the standard 25×41 Leaflet PNG
  pin — verified in browser; accepted as corrective under the canonical-look decision.
- TilesetSelector renders as a SIBLING outside MapContainer (matches NodesTab ground
  truth); BaseMap returns a fragment and must never own a wrapper div.
- Validation: full Vitest suite success:true (2,866 suites / 9,325 tests / 0 failed);
  typecheck + lint:ci clean; browser-validated all four surfaces (tiles, click-to-place,
  circle draw + handles, two-corner bbox draw + hint transitions) with no new console
  errors.
