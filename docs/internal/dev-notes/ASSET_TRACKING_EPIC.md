# Asset Tracking Epic (#5354)

## Goal

Let an operator mark a node as a tracked **asset**, for example a GPS node on a vehicle. For an asset, MeshMonitor:
- keeps its history for a chosen period;
- always draws its trail, whatever the mobility heuristic says;
- can draw its full history on the map;
- can play that history back.

The issue began as "pin the mobile flag" (a node parked after a trip showed no trail, because the 100 m / 500-fix heuristic had flipped it to stationary). It grew into this.

## Decisions (user, 2026-09-27)

- **Delivery:** an epic in 3 phases, each usable on its own.
- **Scope:** one flag per **physical node** (nodeNum), global across sources, like the solar override (#3195). Visibility still follows each viewer's source permissions.
- **Retention:** per asset, default **90 days**, range 1–365. The setting shows an estimated row count.
- **What is kept:** **all telemetry** for the asset (position, battery, environment and so on), on every source that heard it.
- **Permission:** `settings:write`, matching the solar override, because the flag extends storage on every source.
- **Protection:** **automated** cleanups skip assets, as they already skip favourites. That covers auto-delete-by-distance, the aircraft age-out, the MQTT geo-filter purge, and the automation "delete node" action. A manual Delete Node still works, with a warning that it removes the retained history.

## Phases

### Phase 1: the asset flag, forced trail, and retention
- [x] A global `asset_nodes` table: nodeNum PK, `retentionDays`, audit columns (migration 181).
- [x] A PUT/DELETE route gated by `settings:write`. Reads are filtered to nodes on the caller's permitted sources.
- [x] An "Asset tracking" section in Node Details: an enable switch, retention days, and the estimated rows.
- [x] The node payload gains an `asset` field. The effective `isMobile` is `mobile || asset`. This is a computed overlay: the `mobile` column and the `becameMobile` trigger stay heuristic-only.
- [x] The telemetry purge exempts assets up to their own retention.
- [x] Automated node deleters skip assets.

**Exit:**
- A parked asset still draws its trail.
- Its telemetry survives the 7-day purge and is removed after its own window.
- An automated cleanup doesn't delete it.
- A restart doesn't change any of this.

### Phase 2: full-history trail
- [x] Replace the client's 5,000-fix cap with server-side time-bucket downsampling across the whole retained window, for assets.
- [x] `GET /api/assets/:nodeNum/track`: paged read (`getPositionRowsForNodeNumPage`), streaming `TrackThinner` (`src/utils/trackThinning.ts`), 60 s LRU cache.
- [x] Client: one ApiService call for an asset, 2,000-point render cap, no line across a 30-min gap, "Showing N of M fixes (thinned)".

### Phase 3: timeline playback
- [x] A scrubber at the bottom of the map for a selected asset: a notch per fix, play/pause, speed, a time readout, and a "trail up to cursor" mode.

## Mesh impact

None in any phase. Everything is storage and UI; nothing is sent over the mesh.

## Status log

- 2026-09-27: epic planned; Phase 1 started on `feature/5354-asset-p1`.
- 2026-09-27: Phase 1 implemented on `feature/5354-asset-p1`. Deviations from the spec:
  - Purge: a favourite that is also an asset keeps the longer window **per row**. The favourite phase skips rows an asset window still covers, and the asset phase skips rows a favourite window still covers. The spec's "exclude assets from phase 2, let phase 3 decide" would have deleted favourite rows between the asset and favourite cutoffs whenever the favourite window was longer.
  - Estimate endpoint scopes by the per-source `nodes:read` grant. `info` (the telemetry grant) is a global resource, so it can't narrow the count to permitted sources.
  - Auto-delete-by-distance and the aircraft age-out skip an asset for both the ignore and the delete action, like favourites. Only the MQTT geo filter still ignores an asset (as specified).
  - Mesh Issues: `PooledNode` gains an optional `asset` flag; B5 treats an asset as mobile. The raw `mobile` value in finding evidence is unchanged.
- Research flagged `telemetry.purgePositionHistory` as deleting all telemetry; checked 2026-09-27, it does filter to position types and the node. False alarm.
- 2026-09-27: Phase 2 implemented on `feature/5354-asset-p2` (spec: `ASSET_TRACKING_P2_SPEC.md`). Deviations from the spec:
  - Paging cursor is `(timestamp, id)`, not the timestamp alone, and rows sharing a full page's last timestamp are held back to the next page. A timestamp-only cursor would skip or split the rows of a fix that straddles a page boundary.
  - Buckets span the first fix in the window to now, not the whole requested window. A new asset with 2 days of data in a 90-day window would otherwise spend its budget on ~15 buckets.
  - A bucket that spans a gap is cut in two, so every bucket's chord stays inside one segment. When segment endpoints alone exceed 2,000 (a node that reports less often than every 30 min), they are sampled evenly; that is the only case where an endpoint can drop.
  - `totalFixes` counts fixes after the cross-source dedupe.
  - `nodes_private:read` is checked on each source. `buildPositionFilter` checks it unscoped, but the grant is per-source, so this is the stricter reading. `hideFromMap` is not applied, matching `/position-history`.
  - `NOT_AN_ASSET` (404) also covers an asset with no node row on any of the caller's permitted sources, so the flag doesn't leak. Garbage `hours` (not digits) is 400 `INVALID_HOURS`; numbers are clamped.
  - The client asks for every source the caller can see, not just the current source view, since the flag is global and the server dedupes. PUT/DELETE drop that node's cache entries.
- 2026-09-27: Phase 3 implemented on `feature/5354-asset-p3` (spec: `ASSET_TRACKING_P3_SPEC.md`). Deviations from the spec:
  - Trail-up-to-cursor cuts the trail by fix **index** (`indexAtOrBefore`), not by time, so the ~5 Hz cursor rebuilds the polylines only when it crosses a fix.
  - The bar also requires the asset's own server track to be loaded (`positionHistoryTotalFixes !== null`), so it never plays a previous node's history for a moment after the selection changes. 2D only; the 3D view draws no position history.
  - `useDisplaySettings` does not exist; the bar takes `timeFormat` / `dateFormat` from `useSettings()` via NodesTab and formats with `formatDateTime`.
  - The playback marker is hidden while the cursor sits at the end and playback is stopped, since the node's own marker already marks that spot.
  - On a phone the one-row bar hides the step buttons (the timeline's arrow keys and dragging still step) and shows the two toggles as checkbox + icon, with the text kept for screen readers.
  - The traceroute-mode banner (`MapModeIndicator`) gains a `raised` prop so it sits above the bar rather than under it.
