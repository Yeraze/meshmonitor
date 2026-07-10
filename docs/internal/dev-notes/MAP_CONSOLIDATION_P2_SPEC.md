# Map Consolidation — Phase 2 Implementation Spec (Delete the Map Analysis forks)

**Epic:** #4047 (see `MAP_CONSOLIDATION_EPIC.md`)
**Branch:** `feature/4047-p2-unfork-analysis` (cut from `origin/4049-map-refactor`, which already carries Phase 1's BaseMap shell)
**Deliverable of this phase:** re-converge the three "Map Analysis forks" onto shared components — legend, polar grid, position trails.
**Author:** Phase 2 Architect. Implementers are Sonnet agents. **Read §0 first — it changes what this phase actually is.**

---

## 0. PREMISE CORRECTION — ORCHESTRATOR DECISION REQUIRED (read before anything else)

The epic plan lists three "forks" to delete. **Verified against the code in this worktree (serena + reads), only one of the three is a fork, and it is only *partially* drifted. The other two are genuinely-different features, not drift.** Under the epic's own binding rule — *"Genuine functional differences (not drift) become explicit props / structure; only drift converges"* — the honest Phase-2 scope is far smaller than "delete three files."

| Epic claim | Ground truth (this worktree) | Verdict |
|---|---|---|
| `MapAnalysis/layers/PolarGridLayer.tsx` is a **~28 LOC fork** of `PolarGridOverlay` | **Not a fork.** It already `import PolarGridOverlay from '../../PolarGridOverlay'` and renders the shared component once per source (`ownPositions.map(op => <PolarGridOverlay center=… />)`). It is a **per-source adapter**, added by #3971 which *already* consolidated the grid. Zero rendering is duplicated. | **Already consolidated.** Nothing to re-merge. |
| `MapAnalysis/layers/PositionTrailsLayer.tsx` **reimplements** position-history rendering | **Different visualization.** It draws *many* nodes' trails as plain `<Polyline>`s, each a deterministic **hash color** (`colorForKey`→hsl), with click→selection + selection-dimming. `generatePositionHistoryArrows`/`getPositionHistoryColor` draw *one* node's fixes as **age-gradient** `<CircleMarker>` dots + heading triangles + rich popups. Incompatible color models; no shared rendering exists to extract. | **Functional difference, not drift.** Merging is a regression. |
| `MapAnalysis/MapLegend.tsx` (~162 LOC) forks shared `MapLegend.tsx` (~196 LOC) | **Different legend.** Shared legend = static line-type key (hop gradient bar, neighbor bi/uni line samples, "Other Lines") in a `DraggableOverlay`, driven by `overlayColors`. Analysis legend = **layer-driven** key (`.map-analysis-legend`, sections gated by which analysis *layers* are enabled: Markers/Hop-Shading/Coverage-Heatmap/etc.), hardcoded palette, fixed bottom-left. The two are ~90% disjoint in content and CSS. **The only genuine drift is the Node-Types section** (both render node-type glyphs, but the analysis one hand-rolls an SVG that is byte-identical to the shared `roleGlyphMarkerSvg` helper). | **Functional difference + one small drift.** Full merge = a monster prop surface. Only the Node-Types glyph dedupe is safe & in-scope. |

**Why the SNR overlap does NOT count here:** both legends have an "SNR (dB)" section with the same 4-band hardcoded palette. That is *real* drift — but the epic explicitly reserves **all SNR color-scale work for Phase 3** ("Do NOT touch … the SNR color scales — those are Phases 3–6"). Converging the SNR legend now would collide with Phase 3's theme-aware 4-band scale. **Out of scope for Phase 2.**

**Why node-marker/glyph convergence is bounded:** node markers are Phase 6 ("Fold MeshCoreMap's custom `L.divIcon` into `mapIcons.ts`"). The one thing safe to do now is a *pure dedupe* of the analysis legend's inline glyph onto the existing shared `roleGlyphMarkerSvg` helper with **no color/size change** — this is not a marker redesign.

### The decision the orchestrator must make

Phase 2's exit criterion "the three fork files deleted" was written on the mistaken assumption that all three were drift-forks. They are not. Two options:

- **Option A — Recommended: retarget Phase 2 to the honest work.** Deliver the one genuine consolidation (analysis-legend Node-Types glyph → shared `roleGlyphMarkerSvg`), and **document** that the polar-grid fork was already eliminated by #3971 and that the trails/legend "forks" are deliberate functional divergences kept per the epic's own drift-vs-functional rule. Update the epic exit criteria to "forks reconciled" rather than "three files deleted." This is small (≈1 file changed) but correct and leaves the codebase strictly better.
- **Option B — Literal compliance: physically delete all three files.** Achievable but each deletion is churn-to-regression: PolarGridLayer → inline its loop into `MapAnalysisCanvas` (neutral churn); PositionTrailsLayer & analysis MapLegend → cannot delete without re-homing genuinely-different code into the shared components, which *expands* their prop surface and risks the very "one canonical look" the epic wants to protect. **I recommend against B for Trails and Legend.**

§§1–4 below fully spec **Option A** so implementers can execute immediately on approval. §4.4 and §6 note what Option B would additionally require, so the orchestrator can price it.

---

## 1. Reuse inventory + exhaustive fork-vs-shared DIFF (the heart of the phase)

Verified via `find_symbol`/`find_referencing_symbols`/reads. Line numbers are current-tree.

### 1.1 Shared `PolarGridOverlay` — `src/components/PolarGridOverlay.tsx`
- **Props:** `{ center: { lat; lng }; color?: string }` (`:7-19`). `color` is a per-source override (Unified/Dashboard draws one grid per source in that source's color); omitted ⇒ theme `overlayColors.polarGrid`. Fully self-contained: `useMap()`, `useSettings()`, zoom tracking, rings/sectors/labels.
- **Consumers (3):** `NodesTab.tsx:2515` (`center={ownNodePosition}`); `Dashboard/DashboardMap.tsx:596` (per-source, with `color`); `MapAnalysis/layers/PolarGridLayer.tsx:24` (per-source, no `color`).
- **Test:** `src/components/PolarGridOverlay.test.tsx`.

### 1.2 Fork #2 `MapAnalysis/layers/PolarGridLayer.tsx` (28 LOC)
- **What it is:** an adapter. `useMapAnalysisCtx()` → `config.sources`; `useOwnNodePositions(config.sources)` → `[{sourceId,lat,lng}]`; renders `<PolarGridOverlay center=… />` per own-node position. **No `color` passed** (per-source coloring reserved for Dashboard).
- **Mounted:** `MapAnalysisCanvas.tsx:106-108`, gated `config.layers.polarGrid.enabled`, in `<Pane name="polarGrid" zIndex 550>`.
- **DIFF vs shared:** **none in rendering** — it *is* the shared component, invoked N times. The only "extra" is the per-source own-node resolution (`useOwnNodePositions`), which is Map-Analysis-specific data wiring, **not** a rendering difference. `useOwnNodePositions` (`src/hooks/useOwnNodePositions.ts`) reuses already-cached canvas data (`useDashboardUnifiedData` + `useSourceStatuses`) — **adds no network round-trips**.
- **Classification:** `functional (already-shared adapter)` → **keep.** No convergence possible; there is nothing forked.

### 1.3 Position-history helpers — `src/utils/mapHelpers.tsx`
- `getPositionHistoryColor(index, total, colorOld?, colorNew?) : string` (`:307-318`) — **age gradient**; interpolates old→new by `index/(total-1)`. Defaults cyan-blue→orange-red; NodesTab passes `overlayColors.positionHistory{Old,New}`.
- `generatePositionHistoryArrows(historyItems, colors[], maxArrows=30, distanceUnit='km') : ReactElement[]` (`:406+`) — renders a `<CircleMarker>` **dot at every fix** (#3791) colored by `colors[i]`, plus subsampled heading triangles, plus per-fix hover tooltip + click popup (speed/heading/hops/SNR).
- **Consumers:** `NodesTab.tsx:550,608` (single selected node's history: per-segment `<Polyline>` colored by `getPositionHistoryColor` + `generatePositionHistoryArrows` dots/arrows/popups); `MeshCore/MeshCoreMap.tsx:472` (`getPositionHistoryColor` only).
- **Test:** `src/utils/mapHelpers.test.tsx`.

### 1.4 Fork #3 `MapAnalysis/layers/PositionTrailsLayer.tsx`
- **What it renders:** for **every** node in scope with ≥2 fixes, one `<Polyline>` connecting its fixes (sorted by ts). Color = `colorForKey(\`${sourceId}:${nodeNum}\`)` → `hsl(hash%360,70%,55%)` (**deterministic per node, NOT age**). `weight:2`, `opacity: selectionOpacity(0.7, isNodeEmphasized(...))`. `click` → `setSelected({type:'trail',…})`. Respects the time-slider window + `config.selectedNodeIds` dimming.
- **Data:** `usePositions({enabled: layer.enabled, sources, lookbackHours})` — **self-gates** on `enabled`, so no fetch when the layer is off.
- **Mounted:** `MapAnalysisCanvas.tsx:98-100`, gated `config.layers.trails.enabled`, `<Pane name="trails" zIndex 400>`.
- **Feature-by-feature DIFF vs `generatePositionHistoryArrows`/`getPositionHistoryColor`:**

  | Aspect | PositionTrailsLayer (fork) | mapHelpers position-history | Class |
  |---|---|---|---|
  | Scope | **many nodes at once** | **one selected node** | functional |
  | Geometry | one `<Polyline>` per node | per-segment `<Polyline>` + per-fix `<CircleMarker>` | functional |
  | Color model | **per-node hash** (`colorForKey`) | **per-segment age gradient** (`getPositionHistoryColor`) | functional (incompatible) |
  | Dots / heading arrows | none | dot at every fix + subsampled triangles | functional |
  | Popups / tooltips | none (whole-trail click→inspector) | rich per-fix popup + hover tooltip | functional |
  | Selection dimming | `selectionOpacity` + `selectedNodeIds` | n/a | functional |
  | Time-slider window | yes | n/a | functional |
  - **Shared code actually extractable:** essentially none. The only conceptual overlap ("order a node's fixes by time") is ~3 lines and differs in shape (trails groups across nodes; helpers receive a pre-filtered single-node array).
- **Classification:** `functional difference` → **keep.** Not a reimplementation of the helpers in any meaningful sense.

### 1.5 Shared `MapLegend` — `src/components/MapLegend.tsx` (196 LOC)
- **Props:** `{ positionHistory?: PositionHistoryData; unmappedCount?: number; showNodeTypes?: boolean }` (`:29-36`). Wrapped in `DraggableOverlay`; localStorage collapse (`mapLegendCollapsed`); driven by `useSettings().overlayColors`.
- **Always-on content:** Hops **gradient bar** (`overlayColors.hopColors`), Neighbors (bidirectional solid / one-way dashed **line samples**), "Other Lines" (traceroute + IP dashed line samples).
- **Optional content:** Node Types (`showNodeTypes`) via `roleGlyphMarkerSvg(category, NODE_TYPE_LEGEND_COLOR='#cba6f7', 20)` over `MESHCORE_CATEGORIES.filter(c!=='standard')`; Position History gradient + times (`positionHistory`); unmapped count.
- **Consumers (3):** `NodesTab.tsx:2279` (`positionHistory`, `unmappedCount`); `MeshCore/MeshCoreMap.tsx:529` (`showNodeTypes`); `Dashboard/DashboardMap.tsx:589` (no props). **Analysis canvas imports the *other* `./MapLegend`.**
- **CSS:** `src/components/MapLegend.css`. **Test:** `src/components/MapLegend.test.tsx`.

### 1.6 Fork #1 `MapAnalysis/MapLegend.tsx` (162 LOC)
- **Props:** none. Reads `useMapAnalysisCtx().config`; local (non-persisted) `collapsed`; `useVisibleNodeTypeCategories()`.
- **Structure:** fixed `.map-analysis-legend` (bottom-left, `src/styles/map-analysis.css`); sections rendered **iff the matching analysis layer is enabled**: Markers (single `#6698f5` swatch "Node"), Node Types, **Hop Shading** (6 discrete swatches), **SNR (dB)** (4-band hardcoded), Neighbor Links (opacity swatches + caption), **Coverage Heatmap** (gradient bar), Position Trails (caption only). Returns `null` when no relevant layer is on.
- **Feature-by-feature DIFF vs shared MapLegend:**

  | Section | Analysis fork | Shared legend | Class |
  |---|---|---|---|
  | Wrapper / position | fixed `.map-analysis-legend`, bottom-left | `DraggableOverlay .map-legend-wrapper`, top-right | functional (different chrome) |
  | Collapse state | ephemeral `useState` | localStorage-persisted | functional |
  | Gating model | per-**enabled-layer** sections | fixed sections + 3 optional props | functional |
  | Hops | 6 **discrete** swatches (Hop Shading) | **gradient bar** | functional (different encoding; analysis has no gradient equivalent) |
  | Markers / Neighbors / Coverage Heatmap / Trails-caption | analysis-only content | **no shared counterpart** | functional (nothing to converge to) |
  | **SNR (dB)** | 4-band hardcoded `#22c55e/#eab308/#f97316/#ef4444` (+ Unknown) | *(shared legend has no SNR section)* | **drift — but Phase 3 territory; OUT OF SCOPE** |
  | **Node Types** | `RoleIcon`: **hand-rolled inline `<svg width=20 height=20 viewBox="0 0 48 48"><circle r=20 …/>${roleGlyphInnerSvg(c,'#6698f5')}</svg>`**, categories from `useVisibleNodeTypeCategories()` filtered `categoryGlyphFamily(c)!=='standard'` | `roleGlyphMarkerSvg(c,'#cba6f7',20)`, categories `MESHCORE_CATEGORIES.filter(c!=='standard')` | **DRIFT → CONVERGE (§2)** |

- **Key finding on Node Types:** `RoleIcon` (fork `:13-27`) produces markup **byte-identical** to `roleGlyphMarkerSvg(category, color, 20)` (`src/utils/mapIcons.ts:63-73`) — same `<svg 20×20 viewBox 0 0 48 48>`, same `<circle cx24 cy24 r20 fill white opacity .95 stroke color sw2>`, same inner glyph via `roleGlyphInnerSvg`. It is a literal copy-paste that predates/parallels the shared helper. Replacing it with the helper (passing its existing color `#6698f5` and size `20`) is a **pixel-identical dedupe**.
- **CSS:** `src/styles/map-analysis.css` (`.map-analysis-legend*`). **Test:** none (no `MapAnalysis/MapLegend.test.tsx` exists — verified).

---

## 2. Convergence decisions

Only one genuine, in-scope drift exists in Phase 2:

**D1 — Analysis legend Node-Types glyph → shared `roleGlyphMarkerSvg`.**
- **Winner:** the shared helper `roleGlyphMarkerSvg` (already the canonical glyph source used by markers + the shared legend).
- **Appearance:** **unchanged** — the fork's `RoleIcon` markup is identical; we keep its color `#6698f5` and size `20`. This removes a duplicated inline SVG, not a redesign.
- **Justification:** dedupe of a byte-identical hand-roll; converges the *implementation* without converging the *color* (the color difference #6698f5 vs #cba6f7 is a per-surface accent that Phase 6 owns when it canonicalizes marker colors — do not touch it now).

**Explicitly deferred (NOT Phase 2), with rationale:**
- **SNR legend 4-band** (both legends) → Phase 3 (theme-aware canonical SNR scale). Converging now would be immediately re-done and would touch the forbidden SNR scale.
- **Polar-grid rendering** → already converged (#3971). Nothing to decide.
- **Trails vs history rendering** → deliberate functional divergence; no canonical look to pick (they are different views).
- **Legend chrome** (DraggableOverlay/top-right vs fixed/bottom-left, persisted vs ephemeral collapse, layer-driven vs prop-driven) → functional; converging them would merge two different UX models into one over-parameterized component. Keep separate.

No differences in this phase are ambiguous enough to need a per-item orchestrator ruling **beyond the §0 scope decision**. Flag §0 up; everything else follows the epic's drift-vs-functional rule mechanically.

---

## 3. File-by-file changes (Option A — recommended)

### Modified
1. **`src/components/MapAnalysis/MapLegend.tsx`**
   - Delete the local `RoleIcon` component (`:12-27`) and the now-unused `roleGlyphInnerSvg` import.
   - Add `import { roleGlyphMarkerSvg } from '../../utils/mapIcons';`.
   - In the Node-Types section (`:105-108`), replace `<RoleIcon category={c} />` with a span that renders the shared helper, keeping color `#6698f5` + size `20` and the existing `.map-analysis-legend-swatch` class:
     ```tsx
     <span
       className="map-analysis-legend-swatch"
       style={{ background: 'transparent', width: 20, height: 20, display: 'inline-block' }}
       aria-hidden="true"
       dangerouslySetInnerHTML={{ __html: roleGlyphMarkerSvg(c, '#6698f5', 20) }}
     />
     ```
   - Keep `categoryGlyphFamily`, `NODE_TYPE_CATEGORY_META`, `useVisibleNodeTypeCategories`, the `legendCategories` filter, and every other section **unchanged**. (Do **not** touch the SNR section — Phase 3.)
   - Net: the glyph markup is now sourced from the shared helper; visual output identical.

### Documented (no code)
2. **`docs/internal/dev-notes/MAP_CONSOLIDATION_EPIC.md`** — append a Phase-2 log entry recording: polar-grid fork already eliminated by #3971 (PolarGridLayer is an adapter, kept); trails + analysis-legend are functional divergences kept per the drift-vs-functional rule; only the Node-Types glyph was deduped. (The orchestrator normally writes the phase log; the architect supplies this text.)

### NOT deleted (with justification — this is the crux of §0)
- `src/components/MapAnalysis/layers/PolarGridLayer.tsx` — already delegates to shared `PolarGridOverlay`; it is the per-source adapter. Deleting = inlining a 3-line loop into `MapAnalysisCanvas` for no dedupe gain.
- `src/components/MapAnalysis/layers/PositionTrailsLayer.tsx` — genuinely different visualization; no shared rendering to fold into.
- `src/components/MapAnalysis/MapLegend.tsx` — genuinely different legend; merging into shared `MapLegend` would balloon its prop surface.

> If the orchestrator chooses **Option B** anyway, see §4.4 + §6.4 for the additional work and the regressions it incurs.

---

## 4. Test plan

### 4.1 New — `src/components/MapAnalysis/MapLegend.test.tsx` (add; none exists today)
A focused test that pins the Node-Types dedupe so a future glyph change can't silently diverge again. Mock `react-i18next` (passthrough `t`), `./MapAnalysisContext` `useMapAnalysisCtx` (return a config with `layers.markers.enabled=true`, `layers.hopShading.enabled=false`), and `./useVisibleNodeTypeCategories` (return e.g. `['repeater','sensor']`). Assert:
- With markers enabled + non-standard categories present, the Node-Types section renders one row per category and each contains an inline `<svg>` (the glyph). Optionally assert the swatch `innerHTML` equals `roleGlyphMarkerSvg(category,'#6698f5',20)` by importing the real helper — this is the regression guard for D1.
- `if (!anyShown) return null` path still returns nothing when every layer is disabled.

### 4.2 Update — none required for the shared components
`src/components/MapLegend.test.tsx`, `src/components/PolarGridOverlay.test.tsx`, `src/components/MapAnalysis/layers/PositionTrailsLayer.test.tsx`, and `src/utils/mapHelpers.test.tsx` are **untouched** under Option A (no behavior changes to those units). Do not edit them.

### 4.3 Existing MapAnalysis tests that encode fork behavior
- `PositionTrailsLayer.test.tsx` — encodes the fork's *own* behavior (one poly per node, time-window exclusion, selection dimming). Under Option A these stay green untouched; under Option B they would all have to be rewritten or deleted (see §4.4).
- `MapAnalysisCanvas.test.tsx` — mounts the canvas; confirm it still renders after the legend edit (it should; the legend change is internal). No expectation encodes `RoleIcon`.

### 4.4 If Option B (literal deletion) is chosen — additional test impact (for pricing only)
- **PolarGridLayer deleted:** inline its loop into `MapAnalysisCanvas`; no dedicated test exists, but `MapAnalysisCanvas.test.tsx` must still pass and `useOwnNodePositions` now runs unconditionally at canvas top (acceptable — no extra network, but verify the memo deps).
- **PositionTrailsLayer deleted:** its 3 tests (`PositionTrailsLayer.test.tsx`) must be deleted or fully re-homed; any shared multi-node-trail rendering added to `mapHelpers` needs equivalent new tests. **High churn, net regression risk.**
- **Analysis MapLegend deleted:** the 7 layer-driven sections must move into shared `MapLegend` behind new props; `MapLegend.test.tsx` grows substantially and the shared component gains a large conditional surface. **Not recommended.**

### 4.5 Suite gate
Full Vitest suite (assert `success:true` via `--reporter=json`, per the rtk-summary gotcha in project memory) + `tsc` + `npm run lint:ci` (no baseline growth; watch for a stray unused `roleGlyphInnerSvg`/`RoleIcon` after the edit). Pure frontend; no DB/API/system-test surface.

---

## 5. Work packages (Sonnet-sized)

This is a deliberately small phase (§0). **One work package under Option A.**

### WP1 — Analysis-legend Node-Types glyph dedupe *(Option A; no dependencies)*
**Files:**
- `src/components/MapAnalysis/MapLegend.tsx` (edit — §3 item 1)
- `src/components/MapAnalysis/MapLegend.test.tsx` (new — §4.1)

**Do:** replace the hand-rolled `RoleIcon` inline SVG with shared `roleGlyphMarkerSvg(c,'#6698f5',20)`; remove the now-dead `RoleIcon` + `roleGlyphInnerSvg` import; add the regression test. Touch nothing else in the file (SNR section stays — Phase 3).
**Acceptance:**
- Analysis legend Node-Types rows render the identical glyph (browser-verify: enable Map Analysis with a MeshCore source / node-types visible; the legend glyphs look unchanged).
- No unused import/symbol left (`lint:ci` clean; `tsc` clean).
- New test green; full suite `success:true`; no baseline growth.
- **Browser-validate:** Map Analysis view — legend renders for each enabled layer exactly as before (markers swatch, hop-shading, SNR, neighbors, heatmap, trails caption, node-types glyphs), collapse toggle works.

### (Conditional) WP2 — Literal fork deletion *(only if orchestrator picks Option B)*
Not specced in detail here because the architect recommends against it for Trails + Legend. If ordered, it splits into: (2a) inline+delete PolarGridLayer into `MapAnalysisCanvas`; (2b) re-home PositionTrailsLayer rendering into a shared layer/helper + rewrite its 3 tests; (2c) fold the 7 analysis-legend sections into shared `MapLegend` behind new props + expand its tests. **Flag back to the orchestrator before starting — 2b/2c carry real regression risk to the "one canonical look" goal.**

---

## 6. Risks & gotchas

### 6.1 Do not touch the SNR legend section (Phase 3 boundary)
Both legends hardcode the 4-band SNR palette. It is tempting to "converge" it now, but the epic reserves the SNR scale for Phase 3 (theme-aware). Editing it here creates a merge collision and violates the phase boundary. Leave `src/components/MapAnalysis/MapLegend.tsx` SNR section byte-for-byte.

### 6.2 Keep the analysis legend's color `#6698f5` (do not adopt the shared `#cba6f7`)
The dedupe passes the fork's existing `#6698f5` into `roleGlyphMarkerSvg`. Passing the shared legend's `#cba6f7` would visibly recolor the analysis legend glyphs — a drift the epic did not ask for and which Phase 6 (marker-color canonicalization) owns. Verify the browser glyphs are unchanged.

### 6.3 `MapAnalysisCanvas` mounts layers conditionally — don't disturb it
Layers are gated `config.layers.<x>.enabled && <Layer/>` inside named `<Pane>`s with specific z-indexes (`markers 600`, `polarGrid 550`, `snrOverlay 420`, `trails 400`, `heatmap 350`, …). WP1 touches none of this. If Option B inlines PolarGridLayer, the `<PolarGridOverlay>` loop must stay inside `<Pane name="polarGrid" zIndex 550>` or the grid will paint over markers.

### 6.4 Option B hook-hoist caveat (if chosen)
Both adapters gate expensive work by *conditional mount*. `usePositions` self-gates on `enabled`, but `useOwnNodePositions` does not take an `enabled` flag — inlining PolarGridLayer runs it on every canvas render (no extra network, but its memo runs regardless). More importantly, inlining PositionTrailsLayer's `usePositions` at canvas top is only safe if you pass `enabled: config.layers.trails.enabled`. Neither inlining yields consolidation value; both are pure churn.

### 6.5 CSS lives in two separate files — no cascade coupling
Analysis legend styles are in `src/styles/map-analysis.css` (`.map-analysis-legend*`); shared legend in `src/components/MapLegend.css`. WP1 changes no class names (keeps `.map-analysis-legend-swatch`), so no CSS edits. (General reminder from project memory: `nodes.css` has a cascade-order trap where base `.map-controls` is declared *after* the mobile `@media` block — irrelevant to this phase but do not add legend rules to `nodes.css`.)

### 6.6 No new `any`; no raw `fetch`; pure frontend
The dedupe adds no `any` (helper is typed) and no data fetching. Raw-`fetch` ban and DB/`sourceId` rules are trivially satisfied — Phase 2 touches no backend/API/DB surface.

### 6.7 serena project root vs worktree
The activated serena project points at the primary checkout (`/home/yeraze/Development/meshmonitor`), **not** this worktree. Implementers must Read/Edit the worktree paths (`/home/yeraze/Development/meshmonitor-4047-p2/...`) directly; do not let serena edits land in the wrong checkout.

---

## 7. Exit-criteria mapping

**Under Option A (recommended):**
- [ ] Analysis legend Node-Types glyph sourced from shared `roleGlyphMarkerSvg` (drift removed) — WP1.
- [ ] Polar-grid "fork" documented as already-consolidated (#3971); adapter kept.
- [ ] Trails + analysis-legend documented as deliberate functional divergences (epic drift-vs-functional rule).
- [ ] Epic exit criteria amended from "three files deleted" to "forks reconciled."
- [ ] New `MapAnalysis/MapLegend.test.tsx` green; `tsc` + full Vitest (`success:true`) + `lint:ci` clean.
- [ ] Browser-validated: Map Analysis legend/grid/trails render equivalently.

**Under Option B (only if ordered):** additionally the three files physically deleted, with the test rewrites + regression review in §4.4/§5 WP2.
