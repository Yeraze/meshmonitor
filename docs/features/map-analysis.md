# Map Analysis

::: tip New in 4.1
**Map Analysis** is a cross-source visualization workspace for diagnosing mesh coverage, topology, and signal quality. Open it from the **Analysis** section in the dashboard sidebar, or navigate directly to `/analysis`.
:::

The Map Analysis page renders a single Leaflet canvas with a configurable toolbar of independent visualization layers. Each layer pulls from one or more of your configured **sources** at once — letting you see the full mesh, even when individual nodes only see part of it.

## Why Map Analysis?

The Dashboard map shows the **current** state of one source at a time. Map Analysis answers different questions:

- *Where does my mesh actually have coverage?* — Coverage heatmap from accumulated position fixes.
- *Which links are working right now, and how well?* — Traceroute paths colored by SNR; neighbor links with edge opacity by signal.
- *How far away is each node, in hops?* — Hop shading on node markers.
- *Where has each node been over the last day?* — Position trails with age-based fade.
- *What did the network look like an hour ago?* — Time slider scrubs through the loaded data window.

Configuration is per-browser (stored in `localStorage`) and survives reloads.

## Opening the workspace

1. From the dashboard, look for the **Analysis** section in the left sidebar (below your sources list).
2. Click **Map Analysis** (globe icon).
3. The toolbar across the top of the map controls every layer; the right-side **Inspector** dock shows details for the current selection.

The page is publicly accessible — but data is silently filtered by your existing per-source permissions. Sources you can't read contribute zero points; nothing renders for them and no error is shown.

## Toolbar

The toolbar runs across the top of the canvas. From left to right:

| Control | Purpose |
| --- | --- |
| **Source multi-select** | Pick which sources contribute to every layer. "All sources" is the default. |
| **Time slider toggle** | Show/hide the floating time-window slider. |
| **Layer buttons (×8)** | Toggle each visualization layer on/off. The right-edge chevron opens a popover for layer-specific options (lookback window, sub-options). |
| **Progress bar** | Shows aggregate loading state while any layer is fetching. |
| **Inspector toggle** | Show/hide the right-side detail panel. |
| **Reset** | Clear all toolbar state back to defaults. |

### Lookback windows

Time-bounded layers (traceroutes, neighbors, heatmap, trails, SNR overlay) have a **lookback** dropdown in their popover: `1h, 6h, 24h, 3d, 7d, 30d, all`. The default is 24h. Lookback determines *how much history is loaded* — once loaded, the time slider can scrub a sub-window without refetching.

Markers, range rings, and hop shading represent **current** state and have no lookback.

### Loading

Layers paginate behind the scenes. The toolbar shows a thin global progress bar while any layer is fetching, and individual buttons show a spinner badge for in-flight requests. The map renders progressively as pages arrive — there's no wait-for-full-load gate.

## Layers

### Node markers

Renders every known node from the selected sources using the same icon set as the Dashboard map. Click a marker to populate the inspector panel; the standard Leaflet popup still opens too.

### Traceroute paths

Polylines for each traceroute hop, colored by SNR. Reuses the per-segment math from the existing Traceroute Routes view. Click a segment to view the last 10 traceroutes for that path in the inspector, or open the full route history modal.

### Neighbor links

Polylines connecting each node to the neighbors reported in its NeighborInfo packets. Edges use opacity to indicate signal quality and are rendered dashed to distinguish them from active traceroute paths.

### Coverage heatmap

A heat layer built from accumulated position fixes. At low zoom the server returns a **pre-binned coverage grid** for performance; at high zoom (≳12) the client falls back to raw position points. If the result set exceeds 50,000 points, the newest 50k are shown with a banner suggesting a narrower lookback.

### Position trails

Polylines showing each node's path over the lookback window, colored by node and faded by age (older points are dimmer). Useful for spotting drift, mobile nodes, or stale GPS.

### Range rings

A configurable circle around every node showing a nominal coverage radius (default 5 km). Useful for site planning and "would I cover X?" questions.

### Hop shading

Tints node markers by hop count from each source's local node. Adjacent (0-hop) nodes render brightest; multi-hop nodes are progressively dimmer. This is a decorator on the markers layer — turning it on doesn't add a separate marker stack.

### SNR overlay

Drops a colored dot at each position fix, colored by the SNR recorded for that packet. Distinct from trails: trails show *where* a node went, SNR overlay shows *how well it was heard* at each point.

## Time slider

The slider appears bottom-center when enabled. It has two handles defining a `[start, end]` window inside the loaded lookback range. Movement is purely client-side — no refetch — and applies only to time-bounded layers (trails, heatmap, SNR overlay, traceroutes, neighbors). Markers, rings, and hop shading always reflect the current state.

## Inspector panel

The right-side dock mirrors your current map selection.

- **Empty:** "Click a node or route segment".
- **Node selected:** short/long name, node num, hop count, neighbor count, last position timestamp, last SNR/RSSI, list of sources currently reporting it, and a link out to that source's Nodes tab.
- **Segment selected:** from/to nodes, the last ten traceroutes for the segment with their forward/back SNR, and an **Open full history** button that opens the existing `RouteSegmentTraceroutesModal`.

The inspector is collapsible — toggle it from the far-right toolbar button.

## Cross-source data flow

Every layer pulls from the new `/api/analysis/*` endpoints (`positions`, `traceroutes`, `neighbors`, `coverage-grid`, `hop-counts`). Each endpoint:

- Intersects the requested sources with the user's permitted sources, querying only what's allowed.
- Parallelizes per-source fetches with `Promise.allSettled` so one slow source doesn't block the rest.
- Returns cursor-paginated results (`{ items, page, pageSize, totalItems, hasMore, nextCursor }`) for stable pagination under inserts.

Server-side, the coverage grid uses haversine bucketing keyed by `(zoom, latBin, lonBin)` with a 5-minute in-memory cache; the same backend code paths run on SQLite, PostgreSQL, and MySQL.

## Permissions

Map Analysis introduces **no new permission resource**. Page access is public (matching the rest of the Unified pages); data access is gated by the existing **per-source** read permissions you already configured. Read access on a source means its data flows into every layer; no read access means it silently contributes zero data.

## Performance notes

- Default page size is 500, max 2000.
- Lookback `all` is supported, but on dense meshes prefer narrower windows.
- The heatmap auto-switches between server-binned grid (low zoom) and raw points (high zoom).
- Layer render output is memoized by `(layer data, map bounds, zoom)` — pan/zoom is fast even with all eight layers enabled.

## Persistence

All toolbar state — layer toggles, lookback selections, source filter, time slider window, inspector visibility — is persisted to a single versioned `localStorage` key (`mapAnalysis.config.v1`). It's per-browser, not per-account. The schema is versioned for future migration to server-persisted defaults.

## Limitations (v1)

These are intentional v1 scope cuts; track them on GitHub if they matter to you:

- No server-persisted config or named presets.
- No annotation layer (user-drawn shapes/labels).
- No CSV / GeoJSON export of the current selection.
- Per-node range ring overrides — single global radius only.
- Real-time push updates inside the canvas — refresh by toggling the layer or moving the slider.
- Mobile usable but not optimized; desktop-first.

## See also

- [Interactive Maps](/features/maps) — the core Dashboard map this workspace complements
- [Multi-Source](/features/multi-source) — how sources are added and managed
- [Per-Source Permissions](/features/per-source-permissions) — what gets filtered, and for whom
- [Embed Maps](/features/embed-maps) — read-only map embed for external sites
