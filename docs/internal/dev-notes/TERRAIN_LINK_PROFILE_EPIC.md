# Terrain Link Profile Epic (issue #4111)

**Goal:** Two-point terrain-elevation-profile + Fresnel-zone link-planning tool in Map Analysis,
comparable to site.meshtastic.org: pick two points (nodes or arbitrary map points), fetch DEM
elevation samples along the great-circle path, render a terrain profile chart with Fresnel-zone
ellipse + earth curvature, and compute a full link budget (FSPL, TX power, antenna gains, cable
loss, RX sensitivity → link margin + obstruction verdict). Source-agnostic (Meshtastic + MeshCore).

**Orchestration:** /epic harness. Orchestrator = this session (Fable). One Opus architect +
Sonnet implementers per phase. Each phase = one merged PR.

## Interview decisions (2026-07-16)

1. **DEM source — custom-tileset-style:** default provider is AWS Terrarium tiles
   (`s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, SRTM-derived, no key),
   but the user can configure a different elevation source, with basic **Testing and Detection**
   support (like the tile-server test pattern in `src/server/routes/tileServerTest.ts`).
   All fetches server-side via `safeFetch` (ssrfGuard); browser never talks to third parties.
2. **Chart UI:** bottom drawer panel sliding over the map (site.meshtastic.org style); map stays
   visible with the picked path highlighted.
3. **RF scope:** FULL link budget — frequency auto-derived per source (Meshtastic region enum →
   center MHz; MeshCore radio preset freq; manual MHz override), per-endpoint antenna height above
   ground, TX power, antenna gains, cable loss, RX sensitivity (default derivable from modem
   preset/SF) → link margin verdict.
4. **Phases:** 3, as below.

## Key reuse inventory (from code survey)

- Two-point picker UX: `src/components/MeasureDistanceController.tsx` + `src/utils/measureDistance.ts`
  (`MeasurePoint`, `nearestPoint`); wired in `src/components/MapAnalysis/MapAnalysisCanvas.tsx:69-74`.
- Toolbar tool-button pattern: `MapAnalysisToolbar.tsx` Measure button (lines ~172-182);
  transient mode state in `MapAnalysisContext.tsx` (measureMode pattern).
- Charts: recharts `ComposedChart` per `src/components/TelemetryChart.tsx` (Area terrain fill +
  Line LOS/Fresnel bounds).
- Server outbound HTTP: `src/server/utils/ssrfGuard.ts` `safeFetch`; test-a-URL route pattern:
  `src/server/routes/tileServerTest.ts`; fetch-then-store: `mapStyleRoutes.ts`.
- Map layers: `src/components/MapAnalysis/layers/*` pattern; `BaseMap` children.
- Frequency data: Meshtastic `deviceConfig.lora` (region/modemPreset/overrideFrequency, server.ts);
  MeshCore `src/components/MeshCore/radioPresets.ts` (freq MHz table).
- Settings: `VALID_SETTINGS_KEYS` in `src/server/constants/settings.ts`; SettingsTab handleSave dep-array gotcha.
- API envelope: `ok()/fail()` from `src/server/utils/apiResponse.ts`.
- Route tests: `createRouteTestApp()` harness.
- **No existing DEM/elevation/Fresnel plumbing anywhere — greenfield.**

## Phases

### Phase 1 — Backend elevation service ⬜
Branch: `feature/elevation-backend` (worktree ../meshmonitor-elevation-backend)

- Elevation provider abstraction: default Terrarium tile provider (PNG decode server-side) +
  configurable custom provider (terrarium-style `{z}/{x}/{y}` URL template AND/OR JSON
  elevation API; auto-detect type from URL shape).
- Tile/sample cache (in-memory LRU; size-bounded).
- `GET/POST /api/elevation/profile`: input two endpoints (+ sample count), server computes
  great-circle sample points, fetches/decodes DEM, returns elevation array + per-sample distance.
  Envelope helpers, permission-gated consistent with analysis routes.
- Elevation source settings keys (custom URL, enable flag) in `VALID_SETTINGS_KEYS`;
  test/detect endpoint (`.../test`) probing a known tile/point, like tileServerTest.
- Full Vitest coverage: provider decode, sampling math, cache, route tests via harness.
- **Exit criteria:** API returns correct profiles for known coordinates (unit-tested with mocked
  fetches); custom-source test endpoint works; suite green; merged.

### Phase 2 — Link Profile tool in Map Analysis ⬜
Branch: `feature/link-profile-tool` (worktree ../meshmonitor-link-profile)

- Pure math utils (`src/utils/` mirroring measureDistance.ts): Fresnel zone radius (n=1),
  FSPL, earth-curvature bulge, link-budget (margin = TXpwr + gains − losses − FSPL vs RX sens),
  obstruction detection (terrain vs 60% first-Fresnel clearance). Unit tests against known values
  (e.g. issue's example: 33.3 km @ 915 MHz → FSPL ≈ 122.1 dB).
- `LinkProfileController` (sibling of MeasureDistanceController): pick two points — snap to node
  OR arbitrary map point (modifier/no-snap fallback).
- Bottom drawer panel with recharts profile: terrain Area (curvature-adjusted), LOS line,
  Fresnel ellipse bounds, obstruction highlighting; stats readout (distance, FSPL, margin, verdict).
- Link-budget input panel: freq (default 915 MHz w/ manual override), antenna heights,
  TX power, gains, cable loss, RX sensitivity (preset-derived default).
- Toolbar button + context mode state; component/unit tests.
- **Exit criteria:** end-to-end in browser: pick two nodes → drawer shows profile + Fresnel +
  budget verdict; matches site.meshtastic.org for a reference link; suite green; merged.

### Phase 3 — Polish, auto-frequency, docs ⬜
Branch: `feature/link-profile-polish`

- Per-source frequency auto-detection: Meshtastic region enum → center MHz map (honor
  overrideFrequency); MeshCore radio preset freq; UI shows provenance ("from source config").
- RX sensitivity default from Meshtastic modem preset where available.
- Map overlay: picked path colored by obstruction result.
- Edge cases: missing DEM data (ocean/voids), antimeridian crossing, same-point selection,
  very long paths (sample-count clamp).
- Elevation-source settings UI (SettingsTab) w/ test button, if not landed in Ph1/2.
- Docs: README/docs feature section; CLAUDE.md/dev-notes updates if invariants added.
- **Exit criteria:** frequency auto-populates per source; graceful degradation on missing data;
  docs published; suite green; merged.

## Status log

- 2026-07-16: Epic created; interview complete; Phase 1 dispatched.
