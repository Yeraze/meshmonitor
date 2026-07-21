# 3D Layers + Polish — Implementation Spec (3D Map & Elevation Epic #3826, Phase 3)

Branch: `feature/3826-3d-layers-polish` (worktree, based on origin/main incl. Phases 1+2).

Phase 3 is the final phase. Goal: **neighbor links + traceroute paths rendered
in 3D**, **selection/inspector wiring in 3D** (nodes, neighbor links, traceroute
segments) at full parity with 2D — including the Phase-1 terrain-profile action —
plus exaggeration persistence and the epic close-out.

## 0. Binding constraints (re-read before coding)

- **TS strict, no `any`, exhaustive-deps clean, no raw `fetch()` in `src/components/**`.**
- **`Base3DMap` stays Map-Analysis-agnostic.** All data in via props (`nodes`,
  `lines`, `basemap`, `terrainTileUrl`, exaggeration); the only outbound signals
  are `onNodeClick(key)`, `onLineClick(key)`, `onExaggerationChange(v)`,
  `onUnsupported()`. It MUST NOT import `SelectedTarget`, `useMapAnalysisCtx`,
  or any MapAnalysis type. The canvas owns every key→`SelectedTarget` mapping,
  exactly as it already does for nodes (`analysisNodes.find(a => a.key === key)`).
- **2D is untouched.** No edits to any existing 2D render path
  (`layers/NeighborLinksLayer.tsx`, `layers/MeshCoreNeighborLinksLayer.tsx`,
  `layers/TraceroutePathsLayer.tsx`, `NodeMarkersLayer.tsx`, the shared
  `map/layers/*`, `LinkProfileController`, `LinkProfileDrawer`). 3D reuses the
  **same data-fetch hooks and the same shared pure primitives** the 2D adapters
  use; where the 2D adapters do a thin inline resolution, 3D replicates it in
  new 3D-only code and a **parity test** locks the two to identical
  `SelectedTarget` shapes. (Rationale for not extracting shared hooks: the
  phase constraint forbids touching 2D; the drift risk is bounded by the parity
  tests plus the already-shared primitives in `utils/neighborLinks.ts` /
  `utils/mapHelpers.ts`.)
- **No migration, no new server settings key** (see §2.4 — exaggeration is
  client-local, same path as `viewMode`).

## 1. Reuse inventory (use / extend these — do NOT reinvent)

| Concern | Reuse | Path |
|---|---|---|
| Generic 3D surface | `Base3DMap` (mount-once map, terrain, hillshade, GeoJSON `nodes` source + circle/label layers, click-on-layer pattern, WebGL probe + `onUnsupported` auto-revert, StrictMode-safe teardown) | `src/components/map/Base3DMap.tsx` |
| Node feature shape | `Node3DFeature { key, lat, lng, label?, color? }` | `src/components/map/Base3DMap.tsx` |
| Meshtastic neighbor fetch | `useNeighbors({ enabled, sources, lookbackHours })` | `src/hooks/useMapAnalysisData.ts` |
| MeshCore neighbor fetch | `useMeshCoreNeighbors({ enabled, sources, lookbackHours })` | `src/hooks/useMapAnalysisData.ts` |
| Traceroute fetch + analysis | `useTraceroutes(...)` + `useTracerouteAnalysis({ traceroutes, positionByKey, selectedNodeNum, selectedSourceId, options, visibleNodeNums, timeWindow })` | `src/hooks/useMapAnalysisData.ts`, `useTracerouteAnalysis` |
| Unified node list (endpoint positions) | `useDashboardUnifiedData(sources, enabled)` → `{ nodes }`; `useDashboardSources()` | `src/hooks/useDashboardData.ts` |
| Endpoint position resolve | `resolveNodeLatLng(node)` | `src/components/MapAnalysis/nodePositionUtil.ts` |
| SNR → line opacity | `snrToNeighborOpacity(snr)` (`null→0.4`, else `clamp((snr+10)/20,0.2,1)`) | `src/utils/neighborLinks.ts` |
| Traceroute SNR color / weight / opacity / dash | `snrToColor`, `weightByOccurrence`, `getSegmentSnrOpacity`, `MQTT_DASH`, `SnrColorScale` | `src/utils/mapHelpers.ts` |
| Transport-class color | `transportColor(transportClass)` (already used by 2D neighbor adapter) | `src/utils/mapHelpers.ts` (as imported by `layers/NeighborLinksLayer.tsx`) |
| Theme palette | `useSettings().overlayColors` (`snrColors`, `mqttSegment`) | `src/contexts/SettingsContext.tsx` |
| Shared positioned+visible nodes (3D markers already consume) | `useAnalysisNodes()` → `AnalysisNode { node, latLng, key=unifiedNodeKey }` | `src/components/MapAnalysis/useAnalysisNodes.ts` |
| Selection state | `selected` / `setSelected(SelectedTarget)`; `SelectedTarget` variants (`node` `{nodeNum,sourceId}`; meshtastic `neighbor` `{sourceId,nodeNum,neighborNum,snr,timestamp}`; meshcore `neighbor` `{sourceId,publicKey,neighborPublicKey,nodeName,neighborName,snr,timestamp,nodeNum:0,neighborNum:0}`; `segment` `{fromNodeNum,toNodeNum,direction,occurrences,avgSnr}`) | `src/components/MapAnalysis/MapAnalysisContext.tsx` |
| Config + persistence | `useMapAnalysisConfig()` (`mapAnalysis.config.v1`, version-guarded `load()` that spreads `DEFAULT_CONFIG`) + `setViewMode` | `src/hooks/useMapAnalysisConfig.ts` |
| Terrain-profile action (Phase 1) | inspector neighbor branch already sets `linkProfileMode`/`linkEndpoints` via `resolveNeighborEndpoints` + `useElevationProfile` (shared cache) | `src/components/MapAnalysis/AnalysisInspectorPanel.tsx`, `neighborLinkEndpoints.ts` |
| Page-level inspector mount | `AnalysisInspectorPanel` is mounted in `MapAnalysisPage`, **outside** the canvas → it already renders for selections made in either view | `src/pages/MapAnalysisPage.tsx` |

### New files (justified)
1. `src/components/MapAnalysis/use3DNeighborLines.ts` — resolves meshtastic +
   meshcore neighbor edges → `Line3DFeature[]` + `Map<key, SelectedTarget>`,
   gated by `config.layers.neighbors.enabled` and the time-slider window. Cannot
   live in the 2D adapters (they're Leaflet components and are off-limits).
2. `src/components/MapAnalysis/use3DTracerouteLines.ts` — resolves traceroute
   segments → `Line3DFeature[]` + `Map<key, SelectedTarget>`, gated by
   `config.layers.traceroutes.enabled`.
3. Tests for both, incl. the parity tests (see §4).

No new shared util, no new server file, no migration.

## 2. Design decisions

### 2.1 `Line3DFeature` — the generic line contract (keeps Base3DMap agnostic)

```ts
// in Base3DMap.tsx, exported alongside Node3DFeature
export interface Line3DFeature {
  key: string;                    // stable; the ONLY thing echoed back via onLineClick
  from: [number, number];         // [lat, lng]  (converted to [lng, lat] internally)
  to: [number, number];           // [lat, lng]
  color: string;                  // → data-driven line-color  (['get','color'])
  opacity: number;                // → data-driven line-opacity (['get','opacity'])
  width: number;                  // → data-driven line-width   (['get','width'])
  /** Dash pattern in line-widths; omit/empty = solid. */
  dash?: number[];
}
```

`color`/`opacity`/`width` carry the **exact same numbers** the 2D layer computes
(shared primitives), so the two views are pixel-equivalent on those axes.
`dash` is the one axis that differs: MapLibre `line-dasharray` **cannot be read
from feature properties** (confirmed against the style spec — "arrays cannot be
read from or derived from feature properties"). So Base3DMap **groups
`lines` by their `dash` signature and creates one `line` layer per distinct
pattern** (`JSON.stringify(dash ?? [])` as the group key), each with its own
static `line-dasharray` (omitted for solid), while `line-color`/`-opacity`/
`-width` stay data-driven within the layer. All line layers share one
`lines` GeoJSON source. (A single-layer `match`-expression on a `dashKey`
property is technically available on the pinned `maplibre-gl` ^5.24 — dasharray
data-driven landed in GL JS 5.8 — but per-pattern layers are simpler to test
against the fake map and version-agnostic; use them.)

### 2.2 Line encoding parity (color / opacity / width / dash per protocol)

Values below are lifted from the verified 2D adapters so 3D agrees by construction:

| Line kind | color | opacity | width | dash | Source of truth |
|---|---|---|---|---|---|
| Meshtastic neighbor | `transportColor(transportClass)` | `snrToNeighborOpacity(snr)` | `2` | `[2,2]` | `layers/NeighborLinksLayer.tsx` (`weight:1`, dash `'4 4'`) |
| MeshCore neighbor | `#06b6d4` (`MC_NEIGHBOR_COLOR`) | `snrToNeighborOpacity(snr)` | `3` | `[3,2]` | `layers/MeshCoreNeighborLinksLayer.tsx` (`weight:1.5`, dash `'6 4'`) |
| Traceroute (RF, has SNR) | `snrToColor(avgSnr, snrColors)` (or `directionColors` when a node is selected — see below) | `getSegmentSnrOpacity([{snr}], isMqtt)` | `weightByOccurrence(occurrences)` | none (solid) | `layers/TraceroutePathsLayer.tsx` |
| Traceroute (MQTT / unknown-SNR) | `overlayColors.mqttSegment` (mqtt) or `snrColors` gray | same | same | `[2,2]` (MQTT dash) | same |

- `color`/`opacity`/`width` reuse the **identical primitives** (`snrToNeighborOpacity`,
  `snrToColor`, `getSegmentSnrOpacity`, `weightByOccurrence`, `transportColor`)
  — no new math. `width` maps the 2D leaflet `weight` value 1:1 to
  maplibre `line-width` (both px); exact dash pixel-lengths are a visual detail,
  not load-bearing — the **intent** (dashed = MQTT/unknown / meshcore) is what
  matters and is preserved.
- Traceroute `colorMode` in 2D is dynamic: **directional** (in/outbound colors +
  arrows) when a node is selected, **SNR** otherwise. 3D replicates this: when
  `selected?.type==='node'`, color focused segments by `directionColors`
  (`OUTBOUND_COLOR #3b82f6` / `INBOUND_COLOR` — read the constants from the 2D
  adapter's exported values; if not exported, redeclare the two hex constants in
  the 3D adapter with a `// mirror of layers/TraceroutePathsLayer.tsx` comment and
  cover them in the parity test), else SNR color. **Arrows/curvature are NOT
  ported** (see §2.6).

### 2.3 Selection shapes for both protocols (the flagged parity item)

**Node clicks are already at parity — no change needed.** Verified: 2D
`NodeMarkersLayer` sets `setSelected({ type:'node', nodeNum:Number(n.nodeNum),
sourceId })` — **no `publicKey`** — and the Phase-2 3D `handleNode3DClick`
sets the byte-identical `{ type:'node', nodeNum:Number(match.node.nodeNum),
sourceId }`. The inspector resolves both via the same
`findNode(nodeNum, sourceId)`. MeshCore nodes carry a merge-populated `nodeNum`,
so this works for MeshCore too. (Known **pre-existing** 2D limitation, shared
identically by 3D and therefore not a regression: two MeshCore nodes in one
source that share a `nodeNum` would both resolve to the first match. The 3D
click first identifies the exact node by `unifiedNodeKey` before downgrading to
the `{nodeNum,sourceId}` contract, so it is never *worse* than 2D. Fixing the
shared contract is out of scope.)

**Neighbor-link clicks — the real work.** The 3D neighbor lines must reproduce
the 2D `setSelected` payloads exactly:

- Meshtastic: `{ type:'neighbor', sourceId, nodeNum, neighborNum, snr, timestamp }`
- MeshCore:   `{ type:'neighbor', sourceId, publicKey, neighborPublicKey, nodeName, neighborName, snr, timestamp, nodeNum:0, neighborNum:0 }`

The inspector's neighbor branch keys MeshCore off `isMeshCore = !!selected.publicKey`,
so the meshcore payload MUST include `publicKey`/`neighborPublicKey`/names and the
`nodeNum:0, neighborNum:0` sentinels — carry them verbatim. These payloads live in
the `Map<key, SelectedTarget>` the 3D hooks return; the canvas `onLineClick(key)`
looks the payload up and calls `setSelected`. A parity test asserts the 3D hook's
payload for a fixture edge deep-equals the 2D adapter's literal object.

**Traceroute-segment clicks — IN scope.** `{ type:'segment', fromNodeNum,
toNodeNum, direction, occurrences, avgSnr }`. Line-layer click hit-testing works
identically to circle layers (`map.on('click', <layerId>, …)` → `e.features[0]`),
so segment selection is tractable at near-zero marginal cost and completes parity.
Justification for including it: same click mechanism as neighbor lines, and the
inspector already has a `segment` branch — leaving it out would be an arbitrary
gap.

### 2.4 Exaggeration persistence → client-local in `mapAnalysis.config.v1`

**Decision: persist the user's chosen exaggeration client-locally, NOT a server
setting.** Add `exaggeration: number` (default `1.3`) to `MapAnalysisConfig` +
`setExaggeration`, same path as `viewMode`/`followMode`/`autoZoom`.

Justification:
- Exaggeration is a per-user, per-browser **view preference**, exactly like
  `viewMode` (which Phase 2 already put here) — not a deployment policy. A server
  setting benefits no other user and would add a `VALID_SETTINGS_KEYS` entry + the
  `SettingsTab.handleSave` dep-array dance for zero cross-user value. The brief
  says "do not add server settings casually" — this fails that bar.
- Client-local reuses the existing versioned-localStorage mechanism with no
  version bump (`load()` spreads `DEFAULT_CONFIG`, so old blobs default to `1.3`).

`Base3DMap` stays generic: keep its internal slider state but seed it from a new
optional `initialExaggeration?: number` (default `1.3`) prop and emit
`onExaggerationChange?(v)` on change. Canvas passes
`initialExaggeration={config.exaggeration}` + `onExaggerationChange={setExaggeration}`.
Both props optional → existing Base3DMap tests unaffected. (Seed-once, not fully
controlled: exaggeration only ever changes via this slider, so external re-sync
after mount is unnecessary and avoids a prop-driven `setTerrain` effect.)

### 2.5 "View terrain profile" from 3D → auto-switch to 2D with the drawer open

Investigation result:
- `LinkProfileDrawer` is **map-agnostic** (recharts; reads `linkProfileMode`/
  `linkEndpoints` from context; no leaflet import) **but is mounted only inside
  the canvas's 2D branch** (after `</BaseMap>`).
- `LinkProfileController` (the on-map verdict polyline + endpoint rings) is
  **Leaflet-coupled** (`useMap`, react-leaflet `Polyline`/`CircleMarker`) and
  mounted inside `BaseMap`.
- The inspector (page-level) fires the action purely by setting context state.

**Decision: the Phase-1 "View terrain profile" action, when triggered while
`config.viewMode === '3d'`, additionally calls `setViewMode('2d')`.** The user
lands in 2D with the drawer open and the link drawn/colored on the Leaflet map.

Rationale: the verdict polyline + endpoint rings are a core part of the profile
UX and are genuinely Leaflet-only; rendering just the recharts drawer over 3D
would be a half-experience (chart but no on-map link) and would require relocating
the drawer mount out of the 2D branch (touching 2D — forbidden). Auto-switch
reuses everything already built with a **one-line** addition, and the elevation
fetch is cache-shared (Phase 1), so the drawer opens instantly. Implementation:
in `AnalysisInspectorPanel`, read `viewMode` + `setViewMode` from
`useMapAnalysisCtx()`; in the existing profile-action click handler, prepend
`if (viewMode === '3d') setViewMode('2d');` before the existing
`setLinkProfileMode`/`setLinkEndpoints` calls.

### 2.6 Traceroute curvature / arrows NOT ported to 3D

2D draws bezier-**curved** segments (`generateCurvedPath`) and direction arrows to
declutter overlapping links on a flat map. In a pitched 3D scene the pitch itself
separates overlapping links, and screen-space bezier curves read as artifacts.
**3D renders straight `LineString`s (2 vertices) and no arrow markers.** This also
keeps click hit-testing trivial and the GeoJSON small. Direction is still conveyed
by **color** (directionColors when a node is selected), matching 2D's color
semantics. Documented as an intentional 3D simplification, not a gap to close.

### 2.7 Terrain draping caveat (document, do not fix)

MapLibre `line` layers are **not sampled onto the DEM** — there is no
`line-z-offset` in the stable line-layer style spec. Lines render near the base
plane and are depth-occluded by terrain; under high pitch a link may be partly
hidden behind a ridge and its endpoints may not visually touch the
terrain-elevated circle markers. This is acceptable for topological analysis
(and the occlusion is a rough LOS cue). Note it in the feature doc and the #3826
closing comment as a follow-up (elevation-sampled lines via `line-z-offset` when
it stabilizes). Node markers already sit on the terrain surface (circle/symbol
layers are elevated) — unchanged.

### 2.8 Time-slider window + layer toggles + lookback

3D honors the **same config state** as 2D: the 3D hooks read
`config.layers.{neighbors,traceroutes}.enabled` (gate output to `[]` when off and
pass `enabled` to the fetch hook so no request fires), `layer.lookbackHours`, and
`config.timeSlider.{enabled,windowStartMs,windowEndMs}` (same `inWindow` filter as
the 2D adapters). The **time-slider UI stays 2D-only** (it's mounted after
`</BaseMap>`; Phase 2 deferred it and this phase keeps that) — but the persisted
window is still honored by the 3D data, so switching 2D↔3D never changes which
links show. Documented.

### 2.9 3D labels / collision

No change. Node labels (symbol layer) already exist with default collision
(`text-allow-overlap:false`). **No link labels in 3D** — 2D MapAnalysis lines are
select-only (no popups; details live in the inspector), so 3D matches by design.

## 3. File-by-file changes

### 3.1 `src/components/map/Base3DMap.tsx` (EDIT) — generic line + exaggeration props
- Export `interface Line3DFeature` (§2.1).
- Props add: `lines?: Line3DFeature[]`, `onLineClick?: (key: string) => void`,
  `initialExaggeration?: number`, `onExaggerationChange?: (v: number) => void`.
- Constants: `LINES_SOURCE_ID='lines'`, `LINES_LAYER_PREFIX='lines-'`.
- `toLinesFeatureCollection(lines)`: one `Feature<LineString>` per line;
  `properties: { key, color, opacity, width, dashKey: JSON.stringify(dash ?? []) }`;
  `geometry.coordinates = [[fromLng,fromLat],[toLng,toLat]]`.
- On `load` (after node layers): add `lines` GeoJSON source; then for each
  distinct `dashKey` present, `addLayer({ id:`${LINES_LAYER_PREFIX}${i}`, type:'line',
  source:'lines', filter:['==',['get','dashKey'], key], paint:{ 'line-color':['get','color'],
  'line-opacity':['get','opacity'], 'line-width':['get','width'], ...(dash.length?{'line-dasharray':dash}:{}) } })`.
  Insert line layers **below** the node circle/label layers (pass the beforeId) so
  markers stay clickable on top. Register `map.on('click', <lineLayerId>, e => { const k=e.features?.[0]?.properties?.key; if(typeof k==='string') onLineClickRef.current?.(k); })`
  + `mouseenter`/`mouseleave` cursor, per line layer.
- **Dynamic dash-group set:** the set of distinct `dashKey`s can change when
  `lines` changes. On the `lines`-change effect (below), if a new `dashKey`
  appears create its layer; if a `dashKey` disappears remove its layer; always
  `getSource('lines').setData(...)`. Keep a `useRef<Set<string>>` of live line
  layer ids to diff. (Simplest correct approach — the alternative, one static set
  of layers, can't know patterns ahead of time.)
- `lines`-change effect mirrors the existing nodes-change effect (guard on
  `loaded`, `setData`, reconcile dash layers).
- Exaggeration: `useState(initialExaggeration ?? DEFAULT_EXAGGERATION)`; slider
  `onChange` sets state, calls `map.setTerrain({source, exaggeration})` (existing),
  **and** `onExaggerationChange?.(v)`. Keep `onExaggerationChangeRef` like the
  other callback refs.
- Teardown unchanged (`map.remove()`); line layers/source die with the map.

### 3.2 `src/components/MapAnalysis/use3DNeighborLines.ts` (NEW)
```ts
export interface NeighborLines3D { lines: Line3DFeature[]; selectionByKey: Map<string, SelectedTarget>; }
export function use3DNeighborLines(): NeighborLines3D
```
- Reads `config`, `useDashboardSources`, resolves `sourceIds` exactly as the 2D
  adapters do (empty `config.sources` ⇒ all source ids).
- `useNeighbors` + `useMeshCoreNeighbors` with `enabled: config.layers.neighbors.enabled`,
  `sources: sourceIds`, `lookbackHours: layer.lookbackHours ?? 24`.
- `useDashboardUnifiedData(sourceIds, sourceIds.length>0)` → `positionByKey`
  (meshtastic: `${sourceId}:${nodeNum}` + `positionByNode` fallback per #3792;
  meshcore: `${sourceId}:${publicKey}`) — replicate the two 2D adapters'
  position maps and the transport-class maps (or reuse whatever the meshtastic
  adapter imports for `transportColor`).
- Apply the same `inWindow(timestamp)` filter; build meshtastic + meshcore edges;
  produce `Line3DFeature` per §2.2 and a `SelectedTarget` per §2.3 keyed by the
  edge `key` (`String(e.id)` — same key the 2D descriptor uses; namespace with a
  `mt:`/`mc:` prefix to guarantee no meshtastic/meshcore key collision in the
  merged map and in Base3DMap's source).
- When `!config.layers.neighbors.enabled` return `{ lines:[], selectionByKey:new Map() }`.
- `useMemo` all derivations; exhaustive-deps clean (mirror the 2D adapters' dep
  arrays incl. the existing `eslint-disable` justification if the same shape is
  needed).

### 3.3 `src/components/MapAnalysis/use3DTracerouteLines.ts` (NEW)
```ts
export interface TracerouteLines3D { lines: Line3DFeature[]; selectionByKey: Map<string, SelectedTarget>; }
export function use3DTracerouteLines(): TracerouteLines3D
```
- Mirror the 2D `layers/TraceroutePathsLayer.tsx` data wiring: `useTraceroutes`,
  build `positionByKey` (skipping `hideFromMap`), `visibleNodeNums`, `options`,
  `timeWindow`, `selectedNodeNum`/`selectedSourceId` from `selected`, then
  `useTracerouteAnalysis(...)` → `segments`.
- `overlayColors` from `useSettings()`; `colorMode = selectedNodeNum!==null ? 'direction' : 'snr'`.
- Per segment produce a straight `Line3DFeature` (§2.2/§2.6): `color` via
  `snrToColor`/directionColors, `opacity` via `getSegmentSnrOpacity`, `width` via
  `weightByOccurrence`, `dash = (isMqtt || avgSnr==null) ? [2,2] : undefined`;
  `key = 'tr:'+seg.key`; `selectionByKey.set(key, { type:'segment', fromNodeNum,
  toNodeNum, direction, occurrences, avgSnr })`.
- Gate on `config.layers.traceroutes.enabled` (return empties when off; pass
  `enabled` to `useTraceroutes`).

### 3.4 `src/components/MapAnalysis/MapAnalysisCanvas.tsx` (EDIT — 3D branch only)
- Call `use3DNeighborLines()` and `use3DTracerouteLines()` at the top level
  (unconditionally — Rules of Hooks; they self-gate on config).
- `const lines3D = useMemo(() => [...neighbor.lines, ...traceroute.lines], [...])`.
- `const selectionByKey = useMemo(() => new Map([...neighbor.selectionByKey, ...traceroute.selectionByKey]), [...])`.
- `handleLine3DClick = useCallback((key) => { const t = selectionByKey.get(key); if (t) setSelected(t); }, [selectionByKey, setSelected])`.
- In the `effectiveViewMode==='3d'` return, pass to `Base3DMap`:
  `lines={lines3D}`, `onLineClick={handleLine3DClick}`,
  `initialExaggeration={config.exaggeration}`, `onExaggerationChange={setExaggeration}`.
- Pull `setExaggeration` + `config.exaggeration` from `useMapAnalysisCtx()`
  (they arrive via the `...config` spread).
- **2D branch unchanged.**

### 3.5 `src/hooks/useMapAnalysisConfig.ts` (EDIT)
- `MapAnalysisConfig`: add `/** 3D terrain exaggeration (0–2), client-local (#3826 P3). */ exaggeration: number;`.
- `DEFAULT_CONFIG.exaggeration = 1.3`.
- `load()`: add `exaggeration: typeof parsed.exaggeration === 'number' ? Math.max(0, Math.min(2, parsed.exaggeration)) : DEFAULT_CONFIG.exaggeration,`.
- Add `setExaggeration = useCallback((v:number)=>setConfig(p=>({...p, exaggeration:v})),[])`; export it.
- `MapAnalysisContext` inherits it via `ReturnType<typeof useMapAnalysisConfig>` (no context edit needed).

### 3.6 `src/components/MapAnalysis/AnalysisInspectorPanel.tsx` (EDIT — profile-from-3D)
- Destructure `viewMode` + `setViewMode` from `useMapAnalysisCtx()`.
- In the existing neighbor "View terrain profile" click handler (Phase 1),
  prepend `if (viewMode === '3d') setViewMode('2d');`. No other change; distance/
  elevation rows already render regardless of view because the panel is page-level.

### 3.7 Docs (WP-4) — see §5.

No backend, route, schema, migration, or settings-key changes.

## 4. Test plan (Vitest only; jsdom + mocked `maplibre-gl`; no browser automation)

### 4.1 `src/components/map/Base3DMap.test.tsx` (EXTEND the existing fake-maplibre suite)
- Adds a `lines` source + one line layer per distinct `dash` group on load
  (assert `addSource('lines', {type:'geojson'})`, `addLayer` with
  `id` prefixed `lines-`, `type:'line'`, data-driven paint `['get','color']` etc.,
  and `line-dasharray` present only on dashed groups).
- Two lines with **different** dash arrays create **two** line layers; two with the
  same dash create **one**.
- `onLineClick` fires with the feature `key` (drive `map.layerHandlers['click:lines-0']({features:[{properties:{key:'mt:5'}}]})`).
- `lines` prop change calls `getSource('lines').setData(...)` with the new
  FeatureCollection; a newly-appearing dash group adds a layer; a vanished group
  removes it (extend the fake map with `removeLayer` tracking — already present).
- `initialExaggeration` seeds the slider and the initial `setTerrain`; changing the
  slider calls `onExaggerationChange` with the new value AND `setTerrain`.
- Existing tests (nodes, terrain, WebGL-unavailable, StrictMode) stay green with
  `lines` omitted.

### 4.2 `src/components/MapAnalysis/use3DNeighborLines.test.ts` (NEW)
- Mock `useNeighbors`/`useMeshCoreNeighbors`/`useDashboardUnifiedData`/`useDashboardSources`
  and a `MapAnalysisProvider` (or a light ctx wrapper). Render the hook via
  `renderHook`.
- Meshtastic edge with two positioned endpoints → one `Line3DFeature`
  (`color=transportColor`, `opacity=snrToNeighborOpacity(snr)`, `width=2`,
  `dash=[2,2]`) and `selectionByKey.get('mt:'+id)` **deep-equals**
  `{ type:'neighbor', sourceId, nodeNum, neighborNum, snr, timestamp }`
  — the **parity assertion** vs the literal 2D shape.
- MeshCore edge → `color=#06b6d4`, `width=3`, `dash=[3,2]`, and payload deep-equals
  `{ type:'neighbor', sourceId, publicKey, neighborPublicKey, nodeName, neighborName, snr, timestamp, nodeNum:0, neighborNum:0 }`.
- Unpositioned endpoint → edge dropped. Time-slider window excludes out-of-window
  edges. `config.layers.neighbors.enabled=false` → empty result AND the fetch
  hooks called with `enabled:false`.

### 4.3 `src/components/MapAnalysis/use3DTracerouteLines.test.ts` (NEW)
- Mock `useTraceroutes`/`useDashboardUnifiedData` + `useTracerouteAnalysis` (or feed
  a fixture segment list). Assert straight 2-vertex lines (no curvature), MQTT/
  unknown-SNR segment gets `dash=[2,2]`, RF segment solid; `selectionByKey`
  payload deep-equals `{ type:'segment', fromNodeNum, toNodeNum, direction,
  occurrences, avgSnr }`. `colorMode` flips to direction colors when a node is
  selected. Disabled layer → empty.

### 4.4 `src/components/MapAnalysis/MapAnalysisCanvas.test.tsx` (EXTEND or NEW)
- With `viewMode:'3d'` + caps available: `Base3DMap` receives merged `lines`
  (neighbors + traceroutes) honoring toggles — neighbors off ⇒ no `mt:`/`mc:`
  lines; traceroutes off ⇒ no `tr:` lines. (Mock `Base3DMap` to capture props.)
- `onLineClick('mc:7')` → `setSelected` called with the meshcore neighbor payload.
- `initialExaggeration`/`onExaggerationChange` wired to `config.exaggeration`/
  `setExaggeration`.

### 4.5 `AnalysisInspectorPanel.test.tsx` (EXTEND)
- Neighbor selected while `viewMode:'3d'`: clicking "View terrain profile" calls
  `setViewMode('2d')` **and** the existing `setLinkProfileMode(true)`/
  `setLinkEndpoints(...)`; while `viewMode:'2d'` it does **not** call `setViewMode`.

### 4.6 `useMapAnalysisConfig.test.ts` (EXTEND)
- `DEFAULT_CONFIG.exaggeration===1.3`; `load()` restores a stored value, clamps
  out-of-range to `[0,2]`, defaults missing to `1.3`; `setExaggeration` persists.

**Gate:** full Vitest suite green; `npm run lint:ci` exits 0; `tsc` clean.
Browser-validate on the dev container (SwiftShader/puppeteer, per Phase 2) — real
WebGL: neighbor + traceroute lines render, click a line → inspector opens, profile
action drops to 2D with the drawer, exaggeration persists across reload.

## 5. Work packages (Sonnet-sized, dependency-ordered)

### WP-1 — `Base3DMap` generic line support + exaggeration props *(no MapAnalysis, no 2D)*
**Scope:** §3.1 + §4.1. Add `Line3DFeature`, `lines`/`onLineClick`/
`initialExaggeration`/`onExaggerationChange`; per-dash-group line layers on one
GeoJSON source; dynamic dash-layer reconciliation; click/cursor handlers below
node layers; slider seeded + emitting. Extend the fake-maplibre test.
**Depends on:** none.
**Acceptance:** new + existing Base3DMap tests green; component imports nothing
from MapAnalysis (no `SelectedTarget`); `lint:ci`/`tsc` clean; `lines` omitted ⇒
byte-identical to today's behavior.

### WP-2 — 3D line data hooks + parity tests *(reuse shared fetch hooks + primitives)*
**Scope:** §3.2, §3.3 + §4.2, §4.3. `use3DNeighborLines` (meshtastic+meshcore) and
`use3DTracerouteLines`, each returning `{ lines, selectionByKey }`, self-gating on
config + time window, reusing `useNeighbors`/`useMeshCoreNeighbors`/`useTraceroutes`/
`useTracerouteAnalysis`/`useDashboardUnifiedData` and the shared color/opacity/
weight primitives. Parity tests deep-equal the `SelectedTarget` payloads to the
literal 2D shapes.
**Depends on:** WP-1 (imports `Line3DFeature`).
**Acceptance:** hooks return correct lines + payloads for both protocols +
segments; disabled layers ⇒ empty + `enabled:false` fetch; parity tests pass; no
2D file touched; `lint:ci`/`tsc` clean.

### WP-3 — Canvas 3D wiring + inspector profile auto-switch + exaggeration config
**Scope:** §3.4, §3.5, §3.6 + §4.4, §4.5, §4.6. Wire the two hooks into the canvas
3D branch (merged `lines`, `onLineClick`→`setSelected`, exaggeration props); add
`exaggeration`/`setExaggeration` to the config hook; inspector profile action
drops to 2D when in 3D.
**Depends on:** WP-1, WP-2.
**Acceptance:** 3D branch feeds toggle-honoring lines; line click selects (incl.
meshcore); profile-from-3D switches to 2D; exaggeration persists; 2D branch and
its tests unchanged; full suite + `lint:ci` green; **browser-validated** on the
dev container.

### WP-4 — Docs + epic close-out
**Scope:**
- `docs/features/map-analysis.md`: shrink **"What's not in 3D yet"** (remove
  neighbor links, traceroute paths, and node/link selection; keep heatmap /
  trails / range rings / hop-shading / SNR overlay + time-slider UI). Update
  **"Using the 3D view"**: exaggeration now **persists** per-browser; clicking a
  node/link/segment opens the inspector; "View terrain profile" from 3D switches
  to 2D with the drawer. Add the §2.7 draping caveat under a short limitations note.
- `docs/internal/dev-notes/MAP_3D_ELEVATION_EPIC.md`: tick Phase 3, add a status-log
  entry; paste the closing-comment draft (below) into the doc.
- **Draft the #3826 closing comment as text in this spec + the epic doc — do NOT
  post it.**
**Depends on:** WP-3 (docs describe shipped behavior).
**Acceptance:** docs merged with the phase; epic doc checked off; closing-comment
draft present.

### Draft closing comment for issue #3826 (text only — do not post)
> **3D Map & Elevation — shipped (3 phases).**
> **Phase 1 (#4235):** Map Analysis inspector shows per-neighbor-link distance +
> endpoint ground elevations and a one-click "View terrain profile" reusing the
> #4111 Link Profile drawer, for both Meshtastic and MeshCore links.
> **Phase 2 (#4239):** DEM tile proxy (`GET /api/elevation/tiles/:z/:x/:y` +
> `/api/elevation/capabilities`, server-derived because the source URL is secret;
> JSON point-sources return `TERRAIN_TILES_UNAVAILABLE` — no silent AWS fallback)
> and a standalone MapLibre GL 3D terrain view behind a persisted 2D/3D toggle,
> with terrarium raster-dem terrain, hillshade, node markers, an exaggeration
> slider, and graceful no-WebGL fallback.
> **Phase 3 (`<PR#>`):** neighbor links + traceroute paths in 3D honoring the same
> toggles/filters/lookback/time-window as 2D; full selection parity (node,
> neighbor — Meshtastic & MeshCore, and traceroute-segment) into the shared
> inspector; "View terrain profile" from 3D auto-switches to 2D with the drawer;
> exaggeration now persists per-browser.
> **Out of scope (follow-ups):** indoor/venue and custom 3D tilesets — the cheap
> first step is `fill-extrusion` building footprints from vector tiles. 3D link
> lines are not yet terrain-draped (MapLibre renders `line` layers in-plane;
> revisit with `line-z-offset` elevation sampling when it stabilizes). Time-slider
> UI and coverage-heatmap/trails/range-rings/hop-shading/SNR overlays remain 2D-only.

## 6. Invariants honored / non-goals

- **Honored:** Base3DMap stays Map-Analysis-agnostic (data via props, keys out);
  2D render paths and their tests untouched; 3D reuses the same data hooks +
  shared primitives; TS strict / no `any` / no raw `fetch` in components /
  exhaustive-deps clean; no migration; no new server settings key (exaggeration is
  client-local like `viewMode`); selection payloads locked to the 2D shapes by
  parity tests.
- **Non-goals (this phase / epic):** traceroute curvature + arrows in 3D
  (color-only direction); on-map link labels/popups in 3D (inspector-only, matches
  2D); time-slider UI in 3D (window state still honored); terrain-draped lines
  (documented follow-up); coverage heatmap / trails / range rings / hop shading /
  SNR overlay in 3D; indoor / custom 3D tilesets (epic-level follow-up, fill-extrusion first).
