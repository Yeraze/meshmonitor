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

::: tip Icon toolbar (New in 4.13)
The toolbar is now icon-based rather than text-labeled — every button carries a hover tooltip (and `aria-label`) instead of a visible caption, so the same set of controls fits in a much narrower space. Behavior is unchanged; if you're looking for a control by its old label, hover the icons to find it.
:::

## Toolbar

The toolbar runs across the top of the canvas. From left to right:

| Control | Purpose |
| --- | --- |
| **Source multi-select** | Pick which sources contribute to every layer. "All sources" is the default. |
| **Node type filter** | Show/hide markers by role category (client, router, sensor, etc. — adapts to whichever source types are connected). |
| **Transport filter (Show RF / UDP / MQTT)** | Show/hide markers by how the node's most recent packet reached MeshMonitor — over the air (**RF**), the Meshtastic multicast-UDP local transport (**UDP**), or an **MQTT** broker/bridge. Mirrors the same toggle on the Dashboard/Nodes map. A node heard through more than one transport (across sources) stays visible as long as any of its transports is enabled. |
| **Search box** | Filter visible markers (and traceroute link endpoints) by name or node number. See [Node search](#node-search). |
| **Node multi-select** | Pick specific nodes to emphasize. Selected nodes render at full opacity; everything else dims. "All nodes" (empty selection) is the default. See [Node selection & emphasis](#node-selection-emphasis). |
| **Follow / Auto-zoom** | Keep the selected nodes framed as they move — recenter (Follow) and/or fit-to-bounds (Auto-zoom) on each update. See [Follow & Auto-zoom](#follow-auto-zoom). |
| **Time slider toggle** | Show/hide the floating time-window slider. |
| **Measure** | Straight-line distance between two positioned nodes. Disabled until at least two positioned nodes exist; mutually exclusive with Link Profile. |
| **Link Profile** | Terrain, Fresnel clearance, and link-budget verdict between two points. See [Terrain Link Profile](#terrain-link-profile). Only shown when the server has elevation enabled. |
| **3D** (box icon) | Toggle between the flat 2D map and a pitched-terrain 3D view. See [3D terrain view](#3d-terrain-view). Disabled with a tooltip when elevation is off or the configured elevation source can't serve DEM tiles. |
| **Layer buttons (×8)** | Toggle each visualization layer on/off. The right-edge chevron opens a popover for layer-specific options (lookback window, sub-options). |
| **Progress bar** | Shows aggregate loading state while any layer is fetching. |
| **Inspector toggle** | Show/hide the right-side detail panel. |
| **Reset** | Clear all toolbar state back to defaults. |

### Lookback windows

Time-bounded layers (traceroutes, neighbors, heatmap, trails, SNR overlay) have a **lookback** dropdown in their popover: `1h, 6h, 24h, 3d, 7d, 30d, all`. The default is 24h. Lookback determines *how much history is loaded* — once loaded, the time slider can scrub a sub-window without refetching.

Markers, range rings, and hop shading represent **current** state and have no lookback.

### Loading

Layers paginate behind the scenes. The toolbar shows a thin global progress bar while any layer is fetching, and individual buttons show a spinner badge for in-flight requests. The map renders progressively as pages arrive — there's no wait-for-full-load gate.

### Node search

::: tip New in 4.10
:::

The toolbar **search box** hides every marker that doesn't match the term and constrains the traceroute link layer to matching endpoints. Matching is case-insensitive across:

- the node's **long name** and **short name**,
- its **node id** (e.g. `!a1b2c3d4`), and
- its `nodeNum` in **hex or decimal**.

Clear the box to restore the full map. The search term lives in the workspace state alongside the other toolbar controls, so it composes with the source filter and every layer toggle.

### Node selection & emphasis

The toolbar **node multi-select** ("All nodes") lets you pin a specific set of
nodes. The picker lists every node currently on the map — so it already
reflects the source, node-type, and search filters — with **Select all** and
**Clear** shortcuts.

With one or more nodes selected, the map keeps *every* node visible but
**dims the unselected ones** (both their markers and their position trails),
so your chosen nodes stand out without losing surrounding context. An empty
selection is the default and dims nothing.

Selection is keyed on a node's stable cross-source identity (Meshtastic
`nodeNum`, MeshCore public key), so a node reported by several sources stays a
single entry. The set persists per-browser in the workspace config alongside
the other toolbar controls.

### Follow & Auto-zoom

Two toolbar toggles keep the selected nodes framed as their positions update
(the map polls every 15 s, cross-source, so a node's position is the freshest
fix any source reported):

- **Follow** — recenters the map on the **average position** of the selected
  nodes on each update, preserving your current zoom.
- **Auto-zoom** — fits the map to the **bounding box** of the selected nodes'
  current positions with a 15% margin on each update. When both are on,
  Auto-zoom governs the view (its fit implies a center).

Both operate only on the selected set, so pick your nodes first; with an empty
selection they do nothing. A single selected node (or several at the same spot)
centers without zooming all the way in.

**Manual override:** panning or zooming the map by hand **pauses** Follow/Auto-zoom
so you can look around without the map snapping back on the next update. A
**⟳ Resume follow** button appears while paused; click it (or change the node
selection) to re-engage. The toggles persist across reloads; the paused state
does not (a reload starts following again).

## Layers

### Node markers

Renders every known node from the selected sources using the same icon set as the Dashboard map. Click a marker to populate the inspector panel; it also opens the same rich node popup as the Unified map — a card showing name and short name, role, hops, hardware, battery, SNR, altitude, position, and last-heard.

::: tip Multi-source node popups (New in 4.12)
For a node reported by more than one source, the popup includes a **"Seen by N sources"** list with a row per source that links to that source's view — matching the Unified/Dashboard map. The page is also fully multi-source-aware: a node stays visible when **any** of its reporting sources is enabled in the source filter, not only its primary source.
:::

::: tip Discard invalid positions
Whether a "Null Island" (0,0) GPS fix renders here follows the global **Discard invalid positions** setting (**Settings → Map**) — the same setting that controls whether it's stored on ingest in the first place. Out-of-range/garbage coordinates are always dropped regardless of this setting. See [Settings → Map Settings](/features/settings#map-settings).
:::

::: tip Overlapping markers fan out (New in 4.10)
When several nodes report the **same coordinates** — a shared site with multiple radios, or a cluster of nodes that inherited one position — they no longer stack into a single un-clickable marker. They **spiderfy** (fan out around the shared point) so each node is individually selectable.
:::

::: tip Obscured-position offset (New in 4.13)
A node broadcasting a reduced-precision GPS fix (Meshtastic's `precision_bits`) reports a position snapped to the center of a grid cell that can be well over 100 m across — the true position could be anywhere inside it. When **two or more** such nodes snap to the *same* cell, their markers no longer stack exactly on that center point: each is nudged to a deterministic, stable spot inside its own cell so they're individually clickable without implying a precision the node never reported. A node alone in its cell is left at the true center — nothing to declutter. The nudge distance scales with how many nodes share the cell (more crowding, more spread) and is capped so a very coarse (low-precision) fix never scatters its marker kilometers away. This is separate from the exact-coordinate spiderfy above, and from the dashed **accuracy-region** rectangle (`Show Accuracy`), which always still shows the node's true full cell.
:::

### Traceroute paths

Polylines for each traceroute hop, colored by SNR. Reuses the per-segment math from the existing Traceroute Routes view. Click a segment to view the last 10 traceroutes for that path in the inspector, or open the full route history modal.

::: tip Direction & weak-link filtering (New in 4.10)
Each hop's SNR is measured **at its receiver**, so a hop arriving at the selected node is **inbound (RX)** and a hop leaving it is **outbound (TX)**. When a node is selected, traceroutes are decomposed into these directed legs and drawn with direction colours, opposite curvature, and SNR-tooltip arrows — making it obvious whether a weak link is weak coming *in* or going *out*.

Two persisted filters declutter the link overlay:

- **Minimum occurrences** — hide links observed fewer than N times.
- **Minimum SNR** — hide links below a chosen signal floor.

The inspector also shows a per-node summary: distinct links, in/out counts, observation counts, and average SNR.
:::

### Neighbor links

Polylines connecting each node to the neighbors reported in its NeighborInfo packets. Edges use opacity to indicate signal quality and are rendered dashed to distinguish them from active traceroute paths.

Clicking a neighbor link opens it in the inspector, which shows the link's great-circle **distance** alongside the reported SNR. When the server has elevation enabled, the inspector also shows the **ground elevation** at each endpoint and a **View terrain profile** button that opens the [Terrain Link Profile](#terrain-link-profile) drawer pre-loaded with the link's two endpoints — the same terrain/Fresnel/link-budget analysis as picking the points by hand, one click from any neighbor link. This works for both Meshtastic and MeshCore neighbor links, as long as both endpoints have known positions.

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

## Terrain Link Profile

The **Link Profile** tool answers a different question than the layers above: *would a link between these two specific points actually close?* Pick two points — nodes or arbitrary spots on the map — and it fetches a terrain elevation profile between them, renders a line-of-sight/Fresnel-zone chart, and computes a full RF link budget with a clear/marginal/obstructed verdict. It's comparable to [site.meshtastic.org](https://site.meshtastic.org)'s link-planning view, but source-agnostic (works for both Meshtastic and MeshCore nodes) and driven by your own map data.

### Availability

The **Link Profile** toolbar button only appears when your server administrator has enabled terrain elevation (see [Elevation / Terrain settings](/features/settings#elevation-terrain-link-profile)). It's disabled (grayed out) until at least two positioned nodes exist on the map, for the same reason the Measure tool is — though the picker itself accepts arbitrary map points too, once it's active.

### Picking two points

1. Click **Link Profile** in the toolbar. The cursor becomes a crosshair and any active Measure session is cancelled (the two tools are mutually exclusive).
2. Click a point on the map:
   - Clicking within about 24 pixels of a node marker **snaps** to that node — its live position, source, and radio identity are captured for auto-frequency detection (see below).
   - Clicking anywhere else drops an **arbitrary point** at the exact clicked coordinates, with a hollow marker ring instead of a filled one.
3. Click a second point the same way. The two points are connected by a line on the map and the profile drawer slides up from the bottom.
4. Clicking a third time restarts the pick from a new first point (A), so you can explore several links without reopening the tool.
5. Press **Escape** at any point to clear the current pick and exit the tool.

### Reading the drawer

The bottom drawer has two halves:

- **Chart** — a terrain profile plotted against distance: a filled brown area for the DEM terrain (adjusted for Earth curvature), a green line-of-sight (LOS) line between the two antenna tops (dashed where the path is obstructed), and an amber dashed line marking the lower bound of the first Fresnel zone. The tightest clearance point along the path is marked with a colored dot matching the verdict.
- **Stats + inputs** — a verdict pill (**Clear** / **Marginal** / **Obstructed**) with the computed link margin in dB, a stat list (distance, frequency, FSPL, RX power, margin, Fresnel clearance %), and the editable link-budget inputs described below.

The **verdict** is computed from Fresnel-zone clearance along the path:

| Verdict | Meaning |
| --- | --- |
| **Clear** | At least 60% of the first Fresnel zone is unobstructed everywhere along the path. |
| **Marginal** | Line of sight is unobstructed, but less than 60% of the first Fresnel zone is clear at the tightest point. |
| **Obstructed** | Terrain (plus Earth-curvature bulge) crosses the direct line-of-sight line somewhere along the path. |

Once a verdict is available, the connecting line on the map itself recolors to match (green/amber/red) — so you can see the result without having the drawer's chart in view. It reverts to a neutral amber while no verdict is available yet (still loading, or the pair was just cleared).

Hovering over the chart drops a matching marker on the map at the terrain point under your cursor, so you can correlate a dip or spike in the profile with the actual location along the path. Move off the chart (or clear the pick) to remove it.

### Link budget inputs

Nine inputs drive the analysis; editing any of them recomputes instantly with no refetch (only the terrain samples require a network round-trip — everything else is client-side math):

| Input | Default | Notes |
| --- | --- | --- |
| Frequency | 915 MHz | Auto-fills from the picked node's radio config when available (see below) |
| Antenna height AGL (A and B) | 2 m | Above-ground-level height at each endpoint. When a picked node reports an altitude, the field is seeded with `altitude − DEM ground` (shown as \"from node altitude\", editable — your edits always win); otherwise 2 m. The profile math itself always runs on DEM terrain + this AGL value, never raw GPS altitude (see [Limitations](#limitations)) |
| TX power | 20 dBm | |
| TX / RX antenna gain | 2.15 dBi each | Standard dipole reference gain |
| Cable loss | 0 dB | |
| RX sensitivity | −129 dBm | Auto-fills from the picked node's modem preset when known (see below) |
| Earth k-factor | 4/3 | Standard atmospheric-refraction curvature factor |

**Per-source auto-detection:** when one of your picked points snapped to a node, the tool looks up that node's source and auto-fills:

- **Frequency** — the source's configured center frequency (derived from the Meshtastic region + channel + modem preset, or the MeshCore radio's configured frequency), shown with a small provenance hint like *"from Home Base (US)"* under the field.
- **RX sensitivity** — for Meshtastic sources with a known modem preset, computed from the standard LoRa link-budget formula (`S = -174 + 10·log10(BW) + noise figure + SNR floor for the preset's spreading factor`) rather than a hardcoded table.

For a node seen by several sources (say, a Meshtastic radio *and* an MQTT bridge), the tool checks all of them and uses the first source that actually reports radio config — so a node whose most recent packet arrived over MQTT still auto-fills from its radio-bearing source. If both points are arbitrary (non-node) locations, or none of the node's sources expose radio config (pure MQTT sources don't), the fields keep their 915 MHz / −129 dBm defaults. **Manual edits always win** — once you type into a field, auto-fill stops touching it for that endpoint pair. Picking a *new* pair resets that and re-seeds from the new pair's source, if any.

### Graceful degradation

- **Open water or a DEM gap** — if every sample along the path has no elevation data, the drawer shows "No terrain data for this path" instead of a broken chart.
- **Same point picked twice, a path over 500 km, or invalid coordinates** — the drawer shows a plain-language message instead of a raw error.
- **Elevation disabled server-side** — the drawer explains that terrain elevation is turned off, rather than failing silently.
- **Antimeridian-crossing links** (e.g. one endpoint near +179° longitude, the other near −179°) draw the short way across the map instead of wrapping all the way around.

### Limitations

The terrain data (SRTM-derived, roughly 90 m per pixel) is a bare-earth elevation model — it does **not** account for buildings, trees, or other vegetation, so a "Clear" verdict is a first-pass estimate of geometric line-of-sight, not a guarantee of a working RF link. Node GPS altitude is not factored into antenna height; only the DEM terrain height plus your entered AGL value is used.

## 3D terrain view

::: tip New in 4.14
:::

The toolbar's **3D** button (box icon) switches the canvas from the flat Leaflet map to a pitched-terrain [MapLibre GL](https://maplibre.org/) view — the current basemap draped over a real elevation surface with hillshading, so you can tilt and rotate to see how terrain actually sits between nodes.

### Requirements

The button is disabled with an explanatory tooltip unless all of the following hold:

- **Elevation is enabled** on the server (**Settings → Elevation / Terrain**). If it isn't, the tooltip reads *"Elevation is disabled."*
- **The configured elevation source serves DEM tiles.** 3D terrain needs a Terrarium-encoded tile source (the default public AWS/Mapzen source, or a custom tile-template URL). If the admin has instead configured an Open-Topo-Data-style **JSON point API** — which the 2D [Terrain Link Profile](#terrain-link-profile) tool can still use — there's no tile source to build a 3D surface from, and the tooltip reads *"3D terrain is unavailable with the configured elevation source."* There is deliberately no fallback to the public terrarium tiles in this case: an admin who configured a JSON source did so on purpose (often for an air-gapped or cost-controlled deployment), and silently routing 3D traffic elsewhere would leak requests to a provider they explicitly opted away from.
- **Your browser supports WebGL.** If it doesn't, the 3D map degrades to a plain-language message and the view automatically switches back to 2D rather than showing a blank canvas.

### Using the 3D view

- **Navigate** with the built-in MapLibre control: drag to pan, scroll/pinch to zoom, right-drag (or two-finger drag) to pitch and rotate. A compass resets bearing to north.
- **Terrain exaggeration** — a slider (0–2×, default **1.3×**) vertically stretches the DEM so subtle elevation changes read more clearly. Your chosen value **persists per-browser** (New in 4.14, alongside the rest of the Map Analysis toolbar config), so it survives reloads instead of resetting each session.
- **Node markers** render with short-name labels at their real position, draped onto the terrain surface. Click a marker to select it — the same inspector panel used in 2D opens with that node's details.
- **Neighbor links and traceroute paths** (New in 4.14) render in 3D too, honoring the same layer toggles, filters, lookback window, and time-slider window as 2D — turning a layer off or narrowing its lookback in the toolbar affects both views identically. They use the same SNR-based color, opacity, and line-weight encoding as 2D, and MQTT/MeshCore links keep their dashed pattern. Unlike 2D, 3D draws links as straight segments rather than curved with direction arrows — the 3D camera's pitch and rotation already separate overlapping links, so curvature isn't needed; direction is instead shown by line color when a node is selected, matching 2D's color semantics.
- **Selecting a link or traceroute segment** (New in 4.14) works the same as clicking a node: click a neighbor link or traceroute segment in 3D and the inspector opens with that link's details, exactly as in 2D — including Meshtastic and MeshCore neighbor links.
- **"View terrain profile" from 3D** (New in 4.14) — selecting a neighbor link in 3D and clicking **View terrain profile** in the inspector automatically switches the canvas back to 2D with the [Link Profile](#terrain-link-profile) drawer open and the link drawn on the map. The verdict polyline and endpoint rings are Leaflet-only, so this action always lands you in 2D to see them; the elevation data is already cached from the 3D selection, so the drawer opens instantly.
- **Basemap** — the 3D view reuses whichever raster tileset you have selected for the 2D map. If your selected tileset is **vector-only**, 3D can't drape a vector style over terrain yet, so it substitutes the default OpenStreetMap raster basemap and shows a small note; your 2D tileset selection is unaffected.

The **2D/3D toggle state persists per-browser** alongside the rest of your Map Analysis toolbar configuration.

::: tip Terrain draping caveat
Neighbor links and traceroute paths are **not** elevation-sampled onto the terrain surface — MapLibre's line layers render near the base plane and can be partially hidden behind a ridge at high pitch, even though their endpoints (the node markers) sit correctly on the terrain. Treat an occluded link as a rough line-of-sight cue, not a precise indicator; this may be revisited once MapLibre's elevation-sampled line rendering (`line-z-offset`) stabilizes.
:::

### What's not in 3D yet

The 3D view still doesn't have full layer parity with 2D. Not yet available while in 3D mode (all still work normally after switching back to 2D):

- Coverage heatmap, position trails, range rings, hop shading, and the SNR overlay
- The time slider **UI** (the persisted time-slider window is still honored by 3D's neighbor/traceroute data — switching between 2D and 3D never changes which links are shown, only whether you can drag the slider handles from the 3D canvas)
- Follow / Auto-zoom
- Marker popups and spiderfying of overlapping markers
- Launching the Terrain Link Profile tool by picking two points directly on the 3D canvas (use the inspector's **View terrain profile** action on a selected neighbor link instead, which auto-switches to 2D)
- Waypoints

These are candidates for a follow-up phase of the 3D map work.

## Time slider

The slider appears bottom-center when enabled. It has two handles defining a `[start, end]` window inside the loaded lookback range. Movement is purely client-side — no refetch — and applies only to time-bounded layers (trails, heatmap, SNR overlay, traceroutes, neighbors). Markers, rings, and hop shading always reflect the current state.

## Inspector panel

The right-side dock mirrors your current map selection.

- **Empty:** "Click a node or route segment".
- **Node selected:** short/long name, node num, hop count, neighbor count, last position timestamp, last SNR/RSSI, list of sources currently reporting it, and a link out to that source's Nodes tab.
- **Segment selected:** from/to nodes, the last ten traceroutes for the segment with their forward/back SNR, and an **Open full history** button that opens the existing `RouteSegmentTraceroutesModal`.
- **Neighbor link selected:** both endpoint nodes, reporting source, SNR, and the link's great-circle distance. With elevation enabled, also the ground elevation at each endpoint and a **View terrain profile** shortcut into the Link Profile drawer.

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

All toolbar state — layer toggles, lookback selections, source filter, node selection, Follow/Auto-zoom toggles, time slider window, inspector visibility — is persisted to a single versioned `localStorage` key (`mapAnalysis.config.v1`). It's per-browser, not per-account. The schema is versioned for future migration to server-persisted defaults.

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
