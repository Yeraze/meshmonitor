# Map Analysis — Design

**Date:** 2026-04-29
**Status:** Approved (brainstorm)
**Owner:** Randall Hand

## Summary

Add a **Map Analysis** workspace accessible from the dashboard sidebar, below the source list. The page renders a Leaflet map with a configurable top toolbar exposing ten visualization layers (markers, traceroutes, neighbors, heatmap, trails, range rings, hop shading, SNR overlay, time slider, source filter). Page access is public; underlying data continues to be gated by existing per-source permissions. Configuration is persisted to `localStorage`. Lookback windows are user-configurable per layer; once set, all data within the window is loaded (paginated, with progress bars).

## Goals

- Provide a single cross-source visualization surface for diagnosing mesh coverage, topology, and signal quality.
- Reuse existing map building blocks (`MapStyleManager`, tilesets, `NodePopup`, `RouteSegmentTraceroutesModal`) — no parallel map stack.
- Inherit existing permission model — no new permission resource.
- Stay performant on real-world meshes via pagination, server-side downsampling for heatmaps, and client-side memoization.

## Non-Goals

- Server-persisted configuration or named presets (deferred; localStorage only in v1).
- Mobile-first layout (desktop-first; mobile usable but not optimized).
- New permission resource (`analysis`).
- Editing/annotating the map (read-only analysis).
- Real-time push updates inside the analysis canvas (polling or React Query refetch only).

## Architecture

### Route & entry point

- New page component: `src/pages/MapAnalysisPage.tsx`. Replaces the placeholder content in the existing `AnalysisPage.tsx` (rename or repoint). Route `/analysis` is already wired in `src/main.tsx` and listed in `appRoutes`.
- `DashboardSidebar.tsx`: add a new `Analysis` section header below the source list with a single nav entry **Map Analysis** (icon `Globe2` from `lucide-react`). Click navigates to `/analysis`.

### Permission model

- Page route stays public/`optionalAuth()` (matches Unified pages).
- Data endpoints (new and reused) keep existing `requirePermission(... sourceIdFrom)` gates. Sources the user can't read contribute zero data; the layer renders fewer points. No 403s are surfaced to the user — silent filtering matches the rest of MeshMonitor.

### Configuration state

- Single `localStorage` key `mapAnalysis.config.v1` storing a versioned JSON blob:
  ```ts
  {
    version: 1;
    layers: Record<LayerKey, { enabled: boolean; lookbackHours: number | null; ...layerSpecificOptions }>;
    sources: string[]; // selected source IDs; empty = all
    timeSlider: { enabled: boolean; windowStart?: ISOString; windowEnd?: ISOString };
    inspectorOpen: boolean;
  }
  ```
- Schema versioned for future migration if we promote to server persistence.

### Component tree

```
MapAnalysisPage
├── MapAnalysisToolbar          (top bar: 10 layer buttons + global controls + progress)
│   ├── SourceMultiSelect       (pill, opens checklist popover)
│   ├── TimeSliderToggle
│   ├── LayerToggleButton × 8   (each opens popover for lookback + sub-options)
│   ├── LoadingProgressBar
│   ├── InspectorToggleButton
│   └── ResetButton
├── MapAnalysisCanvas           (Leaflet, reuses MapStyleManager + tilesets)
│   ├── NodeMarkersLayer
│   ├── TraceroutePathsLayer
│   ├── NeighborLinksLayer
│   ├── CoverageHeatmapLayer
│   ├── PositionTrailsLayer
│   ├── RangeRingsLayer
│   ├── HopShadingDecorator     (modifies NodeMarkersLayer rendering, not its own marker layer)
│   ├── SnrOverlayLayer
│   └── TimeSliderControl       (floating bottom-center when enabled)
└── AnalysisInspectorPanel      (right-side dock, collapsible)
```

## Data flow

### New backend endpoints

Mounted at `/api/analysis` via new `src/server/routes/analysisRoutes.ts`.

| Endpoint | Returns | Notes |
|---|---|---|
| `GET /positions?sources=a,b&since=ISO&pageSize=500&cursor=...` | Position fixes for nodes across selected sources | Powers heatmap (high zoom), trails, SNR overlay |
| `GET /traceroutes?sources=...&since=...&pageSize=...&cursor=...` | Traceroute records with route + SNR forward/back | Powers paths layer + edge coloring |
| `GET /neighbors?sources=...&since=...` | NeighborInfo edges per node | Powers neighbor links |
| `GET /coverage-grid?sources=...&since=...&zoom=N` | Pre-binned coverage cells | Server-side downsample for low zoom; client falls back to `/positions` at high zoom |
| `GET /hop-counts?sources=...` | Per-node hop count from each source's local node | Powers hop shading; no lookback (current topology) |

**Response shape:** `{ items, page, pageSize, totalItems, hasMore, nextCursor }`. Cursor-based pagination preferred (timestamp+id) for stability under inserts.

**Permission filtering:** Each handler iterates the user's permitted sources via the existing helper used in `unifiedRoutes.ts`, intersects with the `sources` query param, and queries only the resulting set. `Promise.allSettled` parallelizes per-source.

### Reused endpoints

- `/api/unified/nodes` — current node state for markers
- `/api/sources` — populates the `SourceMultiSelect`
- `/api/sources/:id/*` — drill-in from inspector panel

### Client data layer

`src/hooks/useMapAnalysisData.ts` exports one hook per layer: `useNodeMarkers`, `usePositionHistory`, `useTraceroutes`, `useNeighborLinks`, `useCoverageGrid`, `useHopCounts`.

- Each hook is gated by `enabled: layerConfig.<layer>.enabled` so disabled layers issue zero requests.
- React Query with `keepPreviousData: true` so toggling layers doesn't blank the map.
- Paginated endpoints use `useInfiniteQuery`, chained automatically until `hasMore=false`. Aggregate progress (`{loaded, total, percent}`) is exposed for the toolbar progress bar.
- Lookback is a hook input. Changing lookback creates a new query key; old data is discarded.
- Heatmap layer chooses `useCoverageGrid` vs `usePositionHistory` based on current map zoom (threshold ~12).

### Loading UX

- Toolbar shows a thin global progress bar while any layer hook is fetching.
- Each layer button shows a spinner badge when its hook is in flight.
- Map renders progressively as pages arrive (no wait-for-full-load gate).

### Time slider semantics

- **Lookback** (per-layer config) = "load this much history".
- **Time slider** = "render only data within this window inside the loaded set".
- Slider movement is a pure client-side filter — no refetch.
- Slider applies to: trails, heatmap, SNR overlay, traceroutes, neighbors.
- Slider does **not** apply to: markers, range rings, hop shading (current state).

## Components

### `MapAnalysisToolbar`

Horizontal flex row, sticky at the top of the canvas. Order:

1. `SourceMultiSelect` (pill — "All sources (N)" / "3 sources")
2. `TimeSliderToggle`
3. Node markers
4. Traceroute paths
5. Neighbor links
6. Coverage heatmap
7. Position trails
8. Range rings
9. Hop shading
10. SNR overlay
11. Right-aligned: progress bar, inspector toggle, reset button

`LayerToggleButton`:
- Icon + label, click toggles `enabled`
- Right-edge chevron opens a popover with per-layer config (lookback dropdown, layer-specific sub-options)
- Active: filled background; inactive: outline

**Lookback presets** per layer: `1h, 6h, 24h, 3d, 7d, 30d, all`.
**Defaults:** 24h for time-bounded layers; markers and hop shading have no lookback (current state).

### `MapAnalysisCanvas`

- `react-leaflet` MapContainer (matches DashboardMap stack).
- Reuses `MapStyleManager` for tileset selection (read from existing `useSettings`).
- One `<Pane>` per layer for z-order: `markers > paths > neighbors > rings > heatmap > trails > base`.
- Reuses `MapResizeHandler`. Adds an `MapBoundsContext` so layers can clip to viewport.
- Zoom/pan state persists across layer toggles.

### Layer components

| Layer | Render | Key tech |
|---|---|---|
| `NodeMarkersLayer` | `Marker` per node, reuses node icon util | Same icons as DashboardMap |
| `TraceroutePathsLayer` | `Polyline` per segment, color = SNR gradient | Reuses `useTraceroutePaths` math where possible |
| `NeighborLinksLayer` | `Polyline` per edge, opacity by SNR, dashed | Distinct from traceroutes |
| `CoverageHeatmapLayer` | `leaflet.heat` plugin | Server grid (low zoom) → raw points (high zoom) |
| `PositionTrailsLayer` | `Polyline` per node, points sorted by time | Color by node, fade tail by age |
| `RangeRingsLayer` | `Circle` per node at configurable radius (default 5km) | Single global radius in v1 |
| `HopShadingDecorator` | Tints `NodeMarkersLayer` icons by hop count | Modifies markers via context, not its own layer |
| `SnrOverlayLayer` | Per-position colored dot using last SNR | Independent of trails |

### `AnalysisInspectorPanel`

Right-side dock, collapsible (toggle in toolbar far-right).

- **Empty state:** "Click a node or route segment"
- **Node selected:** short/long name, node num, hop count, neighbor count, last position timestamp, last SNR/RSSI, sources reporting it, link to per-source NodesTab
- **Segment selected:** from/to, last 10 traceroutes (compact list), SNR forward/back, "Open full history" → existing `RouteSegmentTraceroutesModal`

Inspector mirrors the current map selection. The standard Leaflet `NodePopup` still opens on marker click; the inspector is a stickier alternative view.

### `TimeSliderControl`

- Floating bottom-center when enabled.
- Two handles (window start, window end).
- Range = oldest loaded timestamp across enabled layers → now.
- Pure client-side filter applied via memoized layer render selectors.

## Testing

### Unit tests (Vitest + Testing Library)

| File | Tests |
|---|---|
| `MapAnalysisPage.test.tsx` | Renders, default layer state, layer toggle persists to localStorage, source multi-select round-trip |
| `MapAnalysisToolbar.test.tsx` | Each layer button toggles, lookback popover open/close, progress bar visible while any hook fetching |
| `LayerToggleButton.test.tsx` | Active/inactive states, popover render, chevron interaction |
| `useMapAnalysisData.test.ts` | Each hook respects `enabled`, lookback change triggers refetch, infinite-query aggregates pages, progress percent computation |
| `analysisRoutes.test.ts` | Each endpoint: pagination cursor stable, source filter intersected with permissions, lookback `since` honored, empty list for zero permitted sources |
| `AnalysisInspectorPanel.test.tsx` | Empty state, node-selected state, segment-selected state, opens `RouteSegmentTraceroutesModal` |
| `MapAnalysisCanvas.test.tsx` | Layers mount/unmount with toggles, `MapStyleManager` receives correct tileset, no remount on time-slider change |

### Integration

- `tests/system-tests.sh`: smoke test hitting `/api/analysis/positions?since=...&pageSize=10` against the dev container after login, asserting paginated shape (`{items, hasMore, nextCursor}`).
- Manual: deploy via `docker-compose.dev.yml` → verify on `localhost:8080/analysis` against the dev sandbox node.

## Error handling

| Failure | Behavior |
|---|---|
| 401 (session expired) | Existing global auth interceptor (login modal) |
| 403 (no source permission) | Endpoint returns empty for that source; layer renders fewer points; no error shown |
| 5xx | Toolbar shows error pill on layer's button; retry button in popover; map keeps last good data |
| Network drop mid-pagination | React Query default retry/backoff; progress bar pauses; resumable from `nextCursor` |
| Empty result set | Layer renders nothing, no toast |
| Heatmap >50k points | Client cap at 50k newest; banner: "Showing newest 50k of N points — narrow lookback for full set" |

## Performance guardrails

- Default page size 500, max 2000.
- Per-source queries parallelized (`Promise.allSettled`).
- Server-side coverage grid: app-level haversine bucketing keyed by `(zoom, latBin, lonBin)` with a 5-minute in-memory cache. SQLite/Postgres/MySQL all supported via Drizzle.
- Client memoizes layer render output by `(layerData digest, mapBounds, zoom)` to avoid recomputation on map pan.

## Multi-database considerations

- All new repository methods follow the existing async/Drizzle pattern (`src/db/repositories/*`, exposed via `DatabaseService` with `Async` suffix).
- Position/traceroute/neighbor queries already exist per-source; new repo methods aggregate across sources with a shared `since` filter.
- BIGINT coercion: nodeNums coerced to `Number()` when comparing across source results (matches existing pattern from telemetry/ignored-nodes).
- No schema changes required for v1.

## Settings & migration

- No new entries in `VALID_SETTINGS_KEYS` (localStorage only).
- No database migrations.
- If we promote to server-persisted config in v2, add a `mapAnalysisDefaults` settings key and a migration to read existing `localStorage` blobs into the user prefs table.

## File summary

**New:**
- `src/pages/MapAnalysisPage.tsx`
- `src/components/MapAnalysis/MapAnalysisToolbar.tsx`
- `src/components/MapAnalysis/LayerToggleButton.tsx`
- `src/components/MapAnalysis/SourceMultiSelect.tsx`
- `src/components/MapAnalysis/TimeSliderControl.tsx`
- `src/components/MapAnalysis/MapAnalysisCanvas.tsx`
- `src/components/MapAnalysis/AnalysisInspectorPanel.tsx`
- `src/components/MapAnalysis/layers/{NodeMarkers,TraceroutePaths,NeighborLinks,CoverageHeatmap,PositionTrails,RangeRings,HopShadingDecorator,SnrOverlay}Layer.tsx`
- `src/hooks/useMapAnalysisData.ts`
- `src/hooks/useMapAnalysisConfig.ts`
- `src/server/routes/analysisRoutes.ts`
- `src/db/repositories/analysisRepository.ts`
- Tests for each of the above

**Modified:**
- `src/components/Dashboard/DashboardSidebar.tsx` — add Analysis section + Map Analysis nav entry
- `src/pages/AnalysisPage.tsx` — replace placeholder, or rename and create `MapAnalysisPage.tsx` with route updated in `src/main.tsx`
- `src/server/server.ts` — mount `analysisRoutes`
- `src/services/database.ts` — expose new repository methods via `Async` facade
- `tests/system-tests.sh` — smoke test for `/api/analysis/positions`

## Open questions for v2

- Server-persisted config + named presets
- Per-node range ring overrides
- Export selection to CSV / GeoJSON
- Annotation layer (user-drawn shapes, labels)
- Permission resource `analysis` if we ever need to gate the page itself
