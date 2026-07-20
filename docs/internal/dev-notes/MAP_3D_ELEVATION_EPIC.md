# 3D Map & Elevation Epic (#3826)

**Issue:** #3826 — Feature consideration: 3D map mode for elevation display and indoor venue support
**Started:** 2026-07-20
**Orchestrator:** /epic harness (Fable)

## Goal

Deliver the two viable tracks from issue #3826:

1. **Interim elevation track:** integrate the existing terrain/link-profile machinery (epic #4111, fully merged) with neighbor links in Map Analysis — per-link distance, endpoint ground elevation, and one-click terrain profile.
2. **3D map mode:** a real 3D terrain view (MapLibre GL standalone, not the Leaflet adapter) surfaced as a 2D/3D toggle on the Map Analysis page, with DEM terrain, node markers, neighbor links, and traceroute paths.

## Interview decisions (2026-07-20)

- **Scope:** both tracks (interim + 3D).
- **3D surface:** Map Analysis page gets a 2D/3D toggle. Other maps (Nodes, Dashboard, Embed) stay 2D — future follow-ups.
- **DEM tiles for the browser:** served via a **server proxy** endpoint (`/api/elevation/tiles/...`) honoring the admin-configured `elevationSourceUrl` (hides keys, reuses server tile cache). Direct client fetch of public terrarium rejected.
- **Indoor venue / custom 3D tilesets: OUT OF SCOPE.** Closing comment on #3826 should note it as a possible future follow-up (3D buildings via fill-extrusion would be the cheap first step).
- **Phase structure:** user chose to merge the originally separate "tile proxy" and "3D foundation" phases into one PR → 3 phases total.

## Prior art this epic builds on (do not duplicate)

- **Elevation backend (#4111 Ph1, PR #4143):** `src/server/services/elevationProvider.ts` (TerrariumTileProvider w/ LRU tile cache, JsonPointProvider, SSRF guard, `-500..9000m` clamp), `elevationService.ts` (`computeProfile`), `elevationRoutes.ts` (`POST /api/elevation/profile`, `POST /api/elevation/test`), settings keys `elevationEnabled` / `elevationSourceUrl`.
- **Link Profile UI (#4111 Ph2/Ph3, PRs #4147/#4151, follow-ups #4156/#4170):** `src/hooks/useElevationProfile.ts`, `useElevationEnabled.ts`, `src/utils/linkProfile.ts` + `linkBudget.ts` + `greatCircle.ts`, `src/components/MapAnalysis/LinkProfileController.tsx` / `LinkProfileDrawer.tsx` / `LinkProfileHoverLayer.tsx`, `MapAnalysisContext.tsx` (`linkProfileMode`, `linkEndpoints`, `linkVerdict`).
- **Map shell (#4047):** `src/components/map/BaseMap.tsx` (Leaflet; raster/vector branch), `src/components/map/layers/NeighborLinksLayer.tsx`, `src/utils/neighborLinks.ts`.
- **Map Analysis workspace:** `src/pages/MapAnalysisPage.tsx`, `MapAnalysisCanvas.tsx`, `AnalysisInspectorPanel.tsx` (neighbor branch shows only SNR today), `useMapAnalysisData.ts`, `analysisApi.ts`.
- **Key datum decision (KEEP):** link-profile math uses DEM ground elevation + antenna AGL, deliberately ignoring node GPS altitude (GPS-vs-DEM datum mismatch; see `LINK_PROFILE_TOOL_SPEC.md` §0/§2.2).
- `maplibre-gl` ^5.24.0 is already a dependency (currently only used through the Leaflet adapter for flat vector tiles).

## Phases

### Phase 1 — Neighbor-link terrain integration ✅

Branch: `feature/3826-neighbor-link-terrain`

Scope:
- Map Analysis inspector (`AnalysisInspectorPanel` neighbor branch): show link distance and, when elevation is enabled, endpoint ground elevations.
- "View terrain profile" action on a selected neighbor link → feeds both endpoints into the existing LinkProfile drawer flow (reuse `MapAnalysisContext` link-profile state; do NOT build a parallel drawer).
- Works for both Meshtastic and MeshCore neighbor links when both endpoints have positions; graceful absence otherwise.
- Gated on `elevationEnabled` (`useElevationEnabled`).

Exit criteria:
- Selecting a neighbor link shows distance (+ elevations when enabled) and a working profile action that opens the existing drawer with correct endpoints.
- Vitest coverage for the inspector changes + any new pure helpers; full suite green.
- Browser-validated on the dev container.

### Phase 2 — DEM tile proxy + 3D map foundation ⬜

Branch: `feature/3826-3d-map-foundation`

Scope:
- **Backend:** `GET /api/elevation/tiles/:z/:x/:y` proxying terrarium raster-dem tiles from the configured `elevationSourceUrl` (reuse `TerrariumTileProvider` URL/fetch/SSRF logic and caching; define behavior when the configured source is a JSON point provider — expected: fall back to default terrarium URL or 404 with a machine code, architect decides). Rate-limited, `optionalAuth`, gated on `elevationEnabled`. Response envelope rules apply to JSON errors (binary tile body on success).
- **Frontend:** standalone MapLibre GL map component (new, sibling to Leaflet `BaseMap` — e.g. `src/components/map/Base3DMap.tsx`), with: current raster tileset as basemap source, `raster-dem` terrain from the proxy, hillshade layer, pitch/bearing navigation + terrain exaggeration control.
- 2D/3D toggle on Map Analysis; 3D mode renders node markers (minimum viable layer set). Toggle state persists (localStorage or context, consistent with existing Map Analysis prefs).
- 3D unavailable states handled: elevation disabled, vector-only custom tileset (raster fallback), JSON point source.

Exit criteria:
- Tile proxy endpoint tested (route tests via harness) incl. gating + fallback behavior.
- 3D toggle renders pitched terrain with hillshade + node markers on the dev container; 2D mode unchanged/regression-free.
- Full suite green; browser-validated with screenshots.

### Phase 3 — 3D layers + polish ⬜

Branch: `feature/3826-3d-layers-polish`

Scope:
- Neighbor links and traceroute paths rendered in 3D mode.
- Selection/inspector wiring in 3D (click node/link → `AnalysisInspectorPanel`, incl. the Phase 1 terrain-profile action).
- Settings surface as needed (e.g. default exaggeration) — remember `VALID_SETTINGS_KEYS` + `SettingsTab` handleSave dep array.
- Docs: README/docs updates for the 3D mode + elevation proxy; update this epic doc; closing comment plan for #3826 noting indoor support as future work.

Exit criteria:
- Feature parity in 3D for nodes/neighbor-links/traceroutes incl. selection.
- Docs merged; full suite green; browser-validated.
- Issue #3826 closable with a summary + follow-up notes.

## Status log

- 2026-07-20: Epic started. Interview complete, phases agreed (3 phases; user merged tile-proxy + 3D-foundation into Phase 2).
- 2026-07-20: Phase 1 implemented (spec: `NEIGHBOR_LINK_TERRAIN_SPEC.md`). Frontend-only; new `neighborLinkEndpoints.ts` resolver + inspector wiring. Key decisions during the phase: endpoint elevations reuse `useElevationProfile` with the drawer's exact query key (one fetch per link, drawer open is a cache hit — verified live, request count stayed at 1); `LinkEndpoint.id` uses `unifiedNodeKey` for byte-for-byte parity with `linkEndpointCandidates`. Browser-validated on the dev container: MeshCore link (distance/elevations/profile action + drawer w/ auto-seeded frequency), Meshtastic link (distance via nodeNum resolution), and elevation-disabled gating (distance only, zero elevation requests). Full suite 10,427/0. Note: dev DB had no `/api/analysis/neighbors` rows initially — Meshtastic live check came from an MQTT-broker-source neighbor link.
