# MeshCore Parity P5 — Map parity (#6260)

Part of the parity epic (`MESHCORE_PARITY_EPIC.md`). Line refs checked against `main` @ 30bc7ae8b;
paths relative to `src/`.

**Mesh impact: none.** Every new endpoint is a GET read; no repository write path changes; no new
manager state, timer, scheduler or notification. Local markers keep their no-transmit pin
(`mapMarkerRoutes.noTransmit.test.ts`). Trace Path keeps its existing TX and gating; P5 only draws
what it already stores. **No migration.**

## Maintainer decisions (2026-11-08)
1. **Estimated positions: compute on read**, per source, no table, no scheduler. Solve with the shared
   `solveNodePosition` from `meshcore_neighbors` + resolved `meshcore_hop_snr` links. Global
   `estimated_positions` stays Meshtastic-only (CLAUDE.md carve-out gains a note).
2. **Hop shading** uses the contact's `path_len`.
3. **Traceroute Explorer for MeshCore: split to a follow-up issue.** P5 still draws MeshCore traces on
   the Map Analysis traceroute layer (2D+3D) and the contact panel.
4. **Playback** shows for any selected contact with Show Position History on and ≥2 fixes.
5. **Stationary nodes:** add one current fix per node (`meshcore_nodes` lat/lon, `timestamp = lastHeard`,
   when `lastHeard >= sinceMs`) to heatmap/coverage/positions.
6. **Solar overrides** key on the synthetic `nodeNumFromPubkey` (same as telemetry). ~1 in 2³¹ collision
   with a Meshtastic nodeNum: accepted, documented.
7. **Local markers** on MeshCore reuse the per-source `waypoints` grant; description in
   `types/permission.ts` becomes "map waypoints and local markers".

## Binding rule
One configurable implementation for all sources. Shared pieces get protocol-aware adapters; no
MeshCore copies. Inline single-consumer blocks that gain a second consumer get promoted.

## Identity
MeshCore rows reuse the synthetic `nodeNumFromPubkey()` (`server/services/meshcoreTelemetryPoller.ts:557`)
so `nodeNum`-keyed client code compiles. Every row ALSO carries `publicKey` and `nodeKey`
(`mc:<pk>` / `mt:<n>`, per `utils/nodeIdentity.ts:52`). **Identity, emphasis and joins use `nodeKey`,
never the synthetic number.** Map Analysis routes keep their raw `res.json` contract; new routes use
`ok()/fail()`.

## Findings

### 1. MeshCoreMap shared layers (`components/MeshCore/MeshCoreMap.tsx`)
| Layer | Evidence | Action |
|---|---|---|
| Local markers | `map/layers/MapMarkersLayer.tsx` `LocalMarkers({sourceId, actions})`; route `server/routes/mapMarkerRoutes.ts:23-29` (per-source `waypoints`); authoring inline `NodesTab.tsx:835-871`, hint `3520-3527`, modal `3529-3535` | Extract hook, mount |
| Cross-source links | Server serves MeshCore (`crossSourceLinkRoutes.ts:136-175`, two-source rule + `buildMeshCorePositionFilter`); `CrossSourceLinksLayer` needs `sourceIds` (NodesTab `3413-3419`) | Mount. Skip `TracerouteConfirmedLinksLayer` (Meshtastic `traceroutes`) |
| Clustering | `map/layers/NodeMarkerCluster.tsx`; `resolveClusterZoomThreshold(mapZoomGateThreshold, mapClusteringEnabled)` (`utils/mapZoomAnimation.ts:74`, `NodesTab.tsx:706`) | Wrap markers. **Gotcha:** #5964 pending popup opens on marker `add`, a clustered marker is never added; selection zoom (`MeshCoreMap.tsx:600`, hard-coded 12) → `resolveClusteredMapCenterTargetZoom(12, threshold)` (`mapZoomAnimation.ts:109`) |
| 3D | `map/Map3DView.tsx` supports `visibleMeshCoreKeys` (`:58`); Dashboard proves it (`DashboardMap.tsx:553-600, 1021-1042`); setup duplicated `DashboardMap.tsx:310-322`, `NodesTab.tsx:1211-1218, 2303` | Extract `useMap3DToggle`, mount |
| Playback | `map/AssetPlaybackBar.tsx:32-47` generic (`PlaybackFix`, `utils/trackPlayback.ts:17`); `MapInstanceBridge` private to `NodesTab.tsx:294`; MeshCoreMap drops timestamps (`:525-528`) the route returns (`meshcoreContactsRoutes.ts:149-157`) | Keep timestamps, mount for selected contact |

### 2. Trace Path on map
- Panel is a text table (`MeshCoreContactDetailPanel.tsx:1189-1239`); `TracePathResult` at
  `MeshCore/hooks/useMeshCore.ts:72`. `useResolvedRouteHops` returns `rows[].position`
  (`MeshCore/useResolvedRouteHops.ts:76-95`). An inline flow map exists in
  `MeshCoreMessageRouteModal.tsx:55-77, 86-120, 162-197` — extract it.
- `meshcore_hop_snr`: one row per hop `(sourceId, traceTag, authCode, hopIndex)` with `initiated`.
  No "latest trace for X" reader yet (`db/repositories/meshcoreHopSnr.ts:124,139`);
  `GET /api/sources/:id/meshcore/hop-snr` (`meshcoreTraceRoutes.ts:28-66`, `traceroute:read`).
- Map Analysis traceroute layer is nodeNum-based (`hooks/useTracerouteAnalysis.ts:41-101`,
  `MapAnalysis/layers/TraceroutePathsLayer.tsx:44-57`, `analysis.getTraceroutes` `:548-629`). The
  shared renderer `map/layers/TraceroutePathsLayer.tsx` never reads `fromNodeNum/toNodeNum`; only
  adapters do (`MapAnalysis/layers/TraceroutePathsLayer.tsx:50,182`, `use3DTracerouteLines.ts:210`,
  `tracerouteExplorer/ExplorerMap.tsx:232`). Type: `utils/tracerouteSegments.ts:215-230`.
- Hop counts: `analysis.getHopCounts` (`:787-917`) needs `localNodeNums`, so MeshCore markers are
  grey under hop shading (`MapAnalysis/layers/NodeMarkersLayer.tsx:78-111`,
  `MapAnalysisCanvas.tsx:118-129`). `meshcore_nodes.path_len` (`db/schema/meshcoreNodes.ts:146-150`).

### 3. Map Analysis positions + solar
- `getPositions` pivots telemetry lat/lon/alt only (`analysis.ts:319-461`); `getCoverageGrid`
  reuses it, dedups on nodeNum (`:686-732`). Routes `/positions` `analysisRoutes.ts:282-308`,
  `/coverage-grid` `:354-395` apply only `buildPositionFilter`.
- `meshcore_position_history` written only on movement (`db/repositories/meshcore.ts:3268-3300`).
- Client layers key on nodeNum: `PositionTrailsLayer.tsx:60,110,131` (`mt:${nodeNum}`),
  `CoverageHeatmapLayer.tsx:87`, `SnrOverlayLayer.tsx:93-152`.
- Solar: `/solar-nodes` (`analysisRoutes.ts:426-504`), `/solar-forecast` (`:514-576`) query only
  `batteryLevel, voltage, ch1-3Voltage`; names from Meshtastic `nodes`; `visibleSolarOverrides`
  (`:406-417`). `identifySolarNodes` keys nodeNum, INA channels by `endsWith('Voltage')`
  (`server/services/solarAnalysis.ts:441-500`). MeshCore types: `mc_battery_volts`,
  `mc_status_battery_volts`, `mc_voltage_chN`, `mc_battery_volts_chN`
  (`components/Dashboard/dataSources.ts:116-121`). Override PUT accepts any uint32 (`:589-616`).

### 4. Estimated positions
- `estimated_positions` global, PK nodeNum; `solveNodePosition(observations, now)`
  (`positionEstimationService.ts:187`) is pure over `anchorLat/anchorLon/snrDb/timestamp`.
- Edges: `meshcore_neighbors (sourceId, publicKey, neighborPublicKey, snr, timestamp)`; resolved
  `meshcore_hop_snr` rows are also direct RF links.
- Meshtastic estimated style: inline dashed `Circle` (`NodesTab.tsx:3341-3380`); toggles
  `MapContext.showEstimatedPositions` + `showAccuracyRegions`.

### Not feasible / out of scope
Accuracy regions, waypoints, ATAK (no MeshCore data). MeshCore 3D omits local markers, playback,
measuring, polar grid, path star, trails, estimated circles (same non-goals as `NodesTab.tsx:3256-3260`).
Traceroute-confirmed links. Estimates in Map Analysis/Dashboard (follow-up). Traceroute Explorer
(follow-up issue, decision 3).

## Design

### Shared extractions (pure refactors, no behaviour change)
- `components/map/MapInstanceBridge.tsx` (from `NodesTab.tsx:294`).
- `hooks/useMap3DToggle.ts` `(tilesetId, customTilesets, cartoApiKey) → {canUse3D, viewMode,
  setViewMode, effective3D, basemap3D, terrainTileUrl}` (from `DashboardMap.tsx:310-322`);
  DashboardMap + NodesTab adopt it.
- `hooks/useLocalMarkerAuthoring.ts` `(sourceId, canWrite) → {placing, setPlacing, pickSpot, actions,
  editor:{open, initial, defaultCoords, close, save}}` (from `NodesTab.tsx:835-871`, incl. Escape);
  NodesTab adopts it.
- `components/map/layers/EstimatedPositionRadiiLayer.tsx` `{key, center, radiusMeters, color}[]`,
  dashed `pathOptions` from `NodesTab.tsx:3367-3376`; NodesTab adopts it.
- `components/map/RouteFlowMap.tsx` `{points: RouteFlowPoint[]; segments?: TracerouteRenderSegment[];
  snrColors}`, `RouteFlowPoint {key,label,lat,lon,kind:'endpoint'|'hop'}`; BaseMap + FitFlowBounds +
  CircleMarkers + shared `TraceroutePathsLayer` (`colorMode:'snr'` with SNR, else fixed dashed as
  today). `MeshCoreMessageRouteModal` adopts it.
- `utils/tracerouteSegments.ts`: `fromNodeNum/toNodeNum` optional; add optional `fromKey/toKey`.
  Meshtastic adapters keep setting numbers; read sites guard undefined.
- `utils/meshcoreNodeNum.ts`: move `nodeNumFromPubkey` here (re-export from the poller).
- `positionEstimationService.ts`: `solveNodePosition` generic over
  `O extends SolverObservation` (`Pick<PositionObservation,'anchorLat'|'anchorLon'|'snrDb'|'timestamp'>`).

### Data shapes
- `PositionRow` (`analysis.ts:52`) + `publicKey?: string`, `nodeKey: string`.
- `HopEntry` (`analysis.ts:173`) + `publicKey?: string`, `nodeKey: string`.
- Routes build one predicate: `row.publicKey ? mcFilter({sourceId, publicKey}) : mtFilter(row)`
  sharing one `loadSourcePermissions` result (pattern: `crossSourceLinkRoutes.ts:142-149`).

### Repository — `db/repositories/analysis.ts` (Drizzle, all backends)
- `getPositions`: two phases, phase-prefixed cursor. Unprefixed/old cursor = Meshtastic phase
  (unchanged). When exhausted — including the early empty returns at `:390-397`, which must hand
  over, not end — return `hasMore:true, nextCursor:'mc:'`. `mc:<base64 ts:id>` phase reads
  `meshcore_position_history` (`inArray(sourceId)`, `gte(timestamp)`, `(timestamp DESC, id DESC)`).
  First `mc:` page also emits one current fix per node from `meshcore_nodes` (decision 5).
- `getCoverageGrid`: dedup `${sourceId}:${nodeKey}:${latBin}:${lonBin}`; 5-page guard spans phases.
- `getHopCounts`: accepts `meshcoreSourceIds`; reads `meshcore_nodes (publicKey, pathLen)` where
  valid (check the flood/unknown sentinel at ingest; treat 0xFF/-1 as missing), non-local.
- `MeshCoreHopSnrRepository`: `getLatestInitiatedTraceFor(sourceId, publicKey, sinceMs)` and
  `getResolvedLinks(sourceId, sinceMs, limit)`.

### Routes
- `analysisRoutes.ts`: `/positions` + `/coverage-grid` combined filter; `/hop-counts` passes
  `meshcoreSourceIds` (type ∈ {meshcore, meshcore_mqtt} ∩ permitted); `/solar-nodes` +
  `/solar-forecast` via new pure `server/services/solarTelemetryAdapter.ts` (`MESHCORE_SOLAR_TYPES`;
  `normalizeSolarType()` maps `mc_battery_volts|mc_status_battery_volts → 'voltage'`,
  `mc_voltage_chN → 'chNVoltage'`, `mc_battery_volts_chN → 'chNBatteryVoltage'`); names from
  permitted MeshCore nodes only; `visibleSolarOverrides` admits synthetic nums of visible MeshCore nodes.
- `meshcoreTraceRoutes.ts`: `GET /hop-snr/latest-trace?publicKey=` (`traceroute:read`) →
  `ok(res, {trace: null | {traceTag, timestamp, hashBytes, hops:[{hopIndex, senderPublicKey,
  senderHash, receiverPublicKey, receiverHash, snr}]}})`.
- `GET /api/sources/:id/meshcore/estimated-positions` (`nodes:read`; empty without
  `nodes:viewOnMap`, mirroring `meshcoreContactsRoutes.ts:139-143`) → new
  `server/services/meshcorePositionEstimator.ts` `estimateMeshCorePositions(sourceId, user)`:
  anchors = positioned nodes passing `buildMeshCorePositionFilter`; targets = no position, no
  override, pass presence check; observations from `meshcore_neighbors` + `getResolvedLinks` (7 d,
  both directions); drop above the Meshtastic max-uncertainty setting. Returns
  `ok(res, {items:[{publicKey, latitude, longitude, uncertaintyKm, uniqueAnchors, nEff, radiusMethod}]})`.
  No caching (permission-dependent; small tables).

### Frontend
- **MeshCoreMap:** local markers (hook + `LocalMarkerPlacementBridge` + `LocalMarkers` + modal +
  hint; `mapContext.showLocalMarkers`; add gated on `waypoints:write`); `CrossSourceLinksLayer
  sourceIds={[sourceId]}` bound to `mapContext.showCrossSourceLinks`; `NodeMarkerCluster` + zoom
  fix; 3D via `useMap3DToggle` + `Map3DView` (`visibleMeshCoreKeys`, `showTraceroutes={false}`,
  shared `renderContactPopup(c)` for 2D+3D); history keeps timestamps, `AssetPlaybackBar` for
  `selectedPublicKey`; estimated contacts merged with `positionIsEstimated` +
  `EstimatedPositionRadiiLayer` under `showAccuracyRegions`. Move the sidebar body into
  `MeshCore/MeshCoreMapControls.tsx`.
- **Contact panel:** "Trace Path map" card via `RouteFlowMap`: local node → resolved hops → contact;
  segments carry per-hop SNR; live `traceResult`, else `latest-trace`; hide map (keep table) when any
  hop is unpositioned (rule from `MeshCoreMessageRouteModal.tsx:86-92`).
- **Map Analysis:** `hooks/useHopByKey.ts` keyed `${sourceId}|${nodeKey}` replacing duplicated maps
  (`NodeMarkersLayer.tsx:78-85`, `MapAnalysisCanvas.tsx:122-129`, `AnalysisInspectorPanel`); trails,
  heatmap, SNR overlay key on `nodeKey`; `useMeshCoreTraceLinks(sources, lookbackHours)` fans out to
  `/hop-snr?hours=&points=1` (mirror `useMeshCoreNeighbors`, `hooks/useMapAnalysisData.ts:161-181`);
  pure `utils/meshcoreTraceSegments.ts` `hopLinksToRenderSegments(...)` concatenated with
  Meshtastic segments in the traceroute layer and `use3DTracerouteLines`.

## Work packages — WP1 ∥ WP3 ∥ WP4 → WP2 → WP5

**WP1 Server: Map Analysis data.** Files: `utils/meshcoreNodeNum.ts`, `db/repositories/analysis.ts`,
`server/routes/analysisRoutes.ts`, `server/services/solarTelemetryAdapter.ts`, `solarAnalysis.ts`
(types). Tests: `analysis.meshcorePositions.test.ts` multi-backend (isolated DBs): phase handover incl.
empty-Meshtastic early return, old cursor, current-fix union, coverage dedup by nodeKey; hop counts
multi-backend (pathLen, sentinel skipped, local excluded); `solarTelemetryAdapter.test.ts`;
`analysisRoutes.meshcore.test.ts` (harness): no `viewOnMap` ⇒ no MeshCore positions, private override
w/o `nodes_private` dropped, unpermitted source empty, solar names + no leak, override PUT on synthetic num.

**WP3 MeshCoreMap shared shell.** Files: `map/MapInstanceBridge.tsx`, `hooks/useMap3DToggle.ts`,
`hooks/useLocalMarkerAuthoring.ts`, `NodesTab.tsx`, `Dashboard/DashboardMap.tsx`,
`MeshCore/MeshCoreMap.tsx`, `MeshCore/MeshCoreMapControls.tsx`, `types/permission.ts` (description),
`public/locales/en.json`. Tests: hook tests; MeshCoreMap: markers mount, cross-source gets
`[sourceId]`, cluster on/off, selection zoom ≥ threshold, 3D passes `visibleMeshCoreKeys`, playback
only with selection + ≥2 fixes; NodesTab/Dashboard tests stay green.

**WP4 Trace Path on map.** Files: `utils/tracerouteSegments.ts`, `map/layers/TraceroutePathsLayer.tsx`
(types), adapter guards, `map/RouteFlowMap.tsx`, `MeshCore/MeshCoreMessageRouteModal.tsx`,
`MeshCore/MeshCoreContactDetailPanel.tsx`, `db/repositories/meshcoreHopSnr.ts`,
`server/routes/meshcoreTraceRoutes.ts`, `en.json`. Tests: `RouteFlowMap.test.tsx`; route modal stays
green; panel (live, fallback, hide); repo multi-backend for both readers; route 403/400/scoping.

**WP2 Map Analysis client** (after WP1+WP4). Files: `hooks/useHopByKey.ts`, MapAnalysis
`NodeMarkersLayer`, `MapAnalysisCanvas`, `AnalysisInspectorPanel`, `PositionTrailsLayer`,
`CoverageHeatmapLayer`, `SnrOverlayLayer`, `TraceroutePathsLayer`, `use3DTracerouteLines`,
`hooks/useMapAnalysisData.ts`, `services/analysisApi.ts`, `utils/meshcoreTraceSegments.ts`. Tests:
segments util; layers with MeshCore rows; `useMeshCoreTraceLinks` device sources only.

**WP5 Estimated positions** (after WP3). Files: `positionEstimationService.ts` (generic),
`server/services/meshcorePositionEstimator.ts`, route, `map/layers/EstimatedPositionRadiiLayer.tsx`,
`NodesTab.tsx`, `MeshCore/MeshCoreMap.tsx`, `MeshCore/hooks/useMeshCoreEstimatedPositions.ts`,
`en.json`, CLAUDE.md note. Tests: estimator units (both observation kinds, hidden/private anchor
excluded, over-max dropped, positioned/overridden targets skipped); existing solver tests green; route
(harness): empty w/o `viewOnMap`, scoping; MeshCoreMap toggles.

Every WP: typecheck, lint ratchet, CSS modules + `var(--color-*)`, `UiIcon`, flat `en.json` keys,
`.js` server imports. PG/MySQL containers up for repo work.

## Browser check
Throwaway volume; seed a MeshCore source with contacts/positions as feasible. MeshCore map: local
marker CRUD, cross-source toggle, clustering + Show on Map popup, 3D toggle, playback. Contact panel
trace card. Map Analysis with MeshCore: trails, heatmap, grid, SNR overlay, hop shading, traceroute
layer 2D/3D. Solar report names. Estimated repeater with toggle. Non-admin without `viewOnMap` sees
none of it. Network: no POST/PUT beyond marker CRUD and solar override.
