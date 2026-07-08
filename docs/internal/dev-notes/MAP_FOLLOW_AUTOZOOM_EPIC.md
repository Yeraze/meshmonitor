# Epic — Follow Nodes on the Map (Auto-center / Auto-zoom)

**Issue:** #3788 — "[FEAT] Ability to follow nodes on the map"
**Orchestrator model:** Opus 4.8
**Started:** 2026-07-08

## Goal

Let a user pick a set of sources & nodes on the existing **Map Analysis**
workspace (`/analysis`) and have the map keep them in view as they move:

- **Follow mode** — on each position update, recenter the map to the *average
  center* of the selected nodes' current positions, preserving zoom.
- **Auto-zoom** — on each update, fit the map to the bounding box of the
  selected nodes' current positions with a **15% margin**.
- Selection also drives visual emphasis: selected nodes render at full
  emphasis, unselected nodes are **dimmed but still visible**.
- Multi-source by design: current positions come from the cross-source merge
  (`useDashboardUnifiedData` → `mergeUnifiedSourceData`, dedup by
  `mt:<nodeNum>` / `mc:<publicKey>`), so a node's position is the freshest fix
  seen by any source (incl. MQTT).

## Interview decisions (2026-07-08)

1. **Home:** Extend the existing `/analysis` `MapAnalysisPage` workspace — NOT a
   new Dashboard panel or standalone page. Maximum reuse of `MapAnalysisContext`,
   `SourceMultiSelect`, `PositionTrailsLayer`, `NodeMarkersLayer`,
   `useMapAnalysisConfig` (localStorage persistence).
2. **Selection semantics:** **Dim unselected, keep visible.** When the selection
   is non-empty, unselected node markers + trails are de-emphasized (reduced
   opacity); selected nodes stay full-emphasis. Follow/Auto-zoom operate on the
   selected set only. (An empty selection = today's behavior, nothing dimmed.)
3. **Manual-pan conflict:** While Follow is active, a manual pan/zoom **pauses**
   Follow and surfaces a "Resume follow" affordance; the map does not yank back
   on the next update until the user resumes.
4. **Phase split:** 2 phases (below).

## Reuse anchors (from Stage-0 survey — do not rebuild these)

- **Workspace shell:** `src/pages/MapAnalysisPage.tsx` (`ToastProvider > SettingsProvider > MapAnalysisProvider > [MapAnalysisToolbar, MapAnalysisCanvas, AnalysisInspectorPanel]`).
- **Config + selection state:** `src/components/MapAnalysis/MapAnalysisContext.tsx` (`useMapAnalysisCtx`) spreads `useMapAnalysisConfig()` and adds `selected`/`nodeFilter`. Config persisted to `localStorage['mapAnalysis.config.v1']` via `src/hooks/useMapAnalysisConfig.ts` (`MapAnalysisConfig` at :40-52).
- **Toolbar + source multi-select:** `src/components/MapAnalysis/MapAnalysisToolbar.tsx`, `SourceMultiSelect.tsx`, `NodeSearchControl.tsx`, `NodeTypeFilterControl.tsx`.
- **Canvas + layers:** `src/components/MapAnalysis/MapAnalysisCanvas.tsx` (`MapContainer` at :43, pane stack :49-75). Markers: `layers/NodeMarkersLayer.tsx` (live positions via `useDashboardUnifiedData`, :145). Trails: `layers/PositionTrailsLayer.tsx` (one `Polyline` per `sourceId:nodeNum`, fed by `usePositions`).
- **View controllers to mirror:** `MapBoundsUpdater` (one-shot `fitBounds`, `DashboardMap.tsx:136-155`), `src/components/MapCenterController.tsx` (`setView` to target), `src/components/ZoomHandler.tsx`, `MapPositionHandler.tsx`. All are `useMap()` children returning `null` — droppable into the Analysis `MapContainer`.
- **Live position feed:** `useDashboardUnifiedData(sources, enabled)` (`src/hooks/useDashboardData.ts:436`), `refetchInterval: DASHBOARD_POLL_INTERVAL = 15_000`. Merge: `mergeUnifiedSourceData` (:332), position = newest record with both lat+lng.
- **History/trajectory:** `GET /api/analysis/positions` (cross-source, cursor-paginated, `since` window) via `analysisApi.fetchPositionsPage` + `useMapAnalysisData.usePositions`.
- **No backend change expected** — all data endpoints already exist. This is a frontend-only epic unless a phase surfaces a real gap.

## Node identity note

Selected-node set must key on the same identity the merge uses:
`mt:<nodeNum>` for Meshtastic, `mc:<publicKey>` for MeshCore (see
`mergeUnifiedSourceData`). Do NOT assume a bare `nodeNum` is unique across
protocols.

---

## Phases

### Phase 1 — Node selection & emphasis  ✅ (browser-validated; PR pending)
Add an explicit node multi-select to the Analysis toolbar (scoped to the chosen
sources), stored as `selectedNodeIds` in `MapAnalysisConfig` (persisted).
`NodeMarkersLayer` + `PositionTrailsLayer` dim unselected nodes when the
selection is non-empty; selected nodes stay full-emphasis. Empty selection =
unchanged behavior.

**Exit criteria:**
- A node multi-select control in the toolbar lists nodes from the currently
  selected sources (respects existing source/type/search filters), with
  select-all / clear.
- Selecting nodes dims unselected markers **and** trails; deselecting restores.
- `selectedNodeIds` persists across reload (localStorage config).
- Keyed on `mt:`/`mc:` identity; MeshCore + Meshtastic both selectable.
- New/extended Vitest coverage green; typecheck clean; browser-validated.
- Ships as a standalone, useful feature ("pick and highlight nodes").

### Phase 2 — Follow & Auto-zoom  ✅ (browser-validated; PR pending)
Add "Follow" and "Auto-zoom" toggles to the toolbar. New `useMap()` view
controller(s) that, on each 15s position update, compute the selected nodes'
current positions and:
- **Follow:** `map.setView(averageCenter, currentZoom)`.
- **Auto-zoom:** `map.fitBounds(L.latLngBounds(points).pad(0.15))`.
- **Both on:** auto-zoom governs center+zoom (fitBounds implies its own center);
  Follow is a no-op while Auto-zoom is on.
- **Manual pan/zoom** while Follow active → pause; show "Resume follow".
- Toggles persist in `MapAnalysisConfig`.

**Exit criteria:**
- Toggles present, persisted, independently operable.
- Follow recenters to average center on update, keeps zoom.
- Auto-zoom fits selected nodes' current positions + 15% margin on update.
- Manual pan pauses Follow with a working Resume affordance.
- Empty selection or single node handled sanely (no NaN bounds, single-point =
  center at current zoom).
- Rate-limited so rapid multi-node updates don't cause jitter.
- New/extended Vitest coverage green; typecheck clean; browser-validated.

---

## Status log

- 2026-07-08 — Stage 0 complete: issue read, code surveyed (2 Explore agents),
  interview done, plan written. Next: Phase 1 Stage 1 (worktree).
- 2026-07-08 — Phase 1 implemented across WP-A/B+C/D (identity helper +
  `selectedNodeIds` config; shared `useAnalysisNodes` hook + `NodeMultiSelect`
  picker + marker dimming; trail dimming). Full Vitest suite green after a
  side-hotfix (PR #4008) repaired unrelated reboot-deps tests broken by the
  #4004 unified-registry refactor on main. Browser-validated on the deployed
  build: picker renders in the toolbar; selecting 2 nodes drove
  `selectedNodeIds:["mt:4134514556","mt:3274688221"]`, dimmed 1528 markers to
  0.3 while keeping selected at 1.0, and the selection + dimming persisted
  across reload (pill "2 selected"). No Phase-1 console errors.
  Deviation from plan: interview chose **dim-unselected (keep visible)** over
  hide-unselected, so Phase 1 emphasizes rather than filters. Next: ship
  Phase 1 PR after #4008 merges + rebase; then Phase 2 (Follow & Auto-zoom).
- 2026-07-08 — Phase 1 shipped: PR #4010 merged to main (`5bcb4ffc`). (Aside: the
  main-red hotfix I opened, #4008, was superseded by the maintainer's #4007 —
  closed as dup; Phase 1 rebased onto the fixed main, full suite green.)
- 2026-07-08 — Phase 2 implemented across WP-A/B/C/D (config `followMode`/`autoZoom`
  + transient `followPaused`; pure `followMath.ts`; `FollowController` useMap child
  with moveend-gated manual-pan pause + `{animate:false}`/rAF programmatic-flag
  lifecycle + `planAutoZoom`; toolbar toggles + `FollowResumeButton` overlay). Full
  Vitest suite green (2744/2744 suites, 0 failures); typecheck + lint:ci clean.
  Browser-validated on the deployed build: Follow recentered [25,-95]z9 →
  [25.978,-80.137]z9 (avg of selection, zoom preserved); Auto-zoom fit a wide
  select-all from z14 → z0; near-coincident pair correctly stayed put (single-case,
  no zoom-to-max); a user zoom paused + showed "Resume follow" + did NOT yank back;
  Resume re-engaged (refit to z0); toggles persisted across reload. No feature
  console errors. Note: implementers WP-C left work uncommitted once (committed by
  orchestrator) — no correctness impact. Next: ship Phase 2 PR; epic complete after merge.
