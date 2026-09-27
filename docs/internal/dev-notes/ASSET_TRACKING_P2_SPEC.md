# Asset Tracking Phase 2: full-history trail (#5354)

See `ASSET_TRACKING_EPIC.md`. Phase 1 (#5411) added the asset flag, per-asset retention, and the forced trail.

## Problem

For the selected node, the Nodes map pages `GET /api/nodes/:nodeId/position-history` (`src/App.tsx` ~1330–1370). Each page holds 1,500 telemetry rows, and paging stops at `MAX_ACCUMULATED_POSITION_FIXES` = 5,000 fixes. The client then downsamples to `MAX_RENDERED_POSITION_POINTS` = 500.

An asset keeps up to 365 days of fixes. A node reporting every 30 s makes about 260k fixes over 90 days, so the map shows only the newest few days of an asset's history.

## Decisions (user, 2026-09-27)

- **D1 Point budget:** an asset's trail draws at most **2,000** points. Non-assets are unchanged (500).
- **D2 Shape-preserving thinning on the server.** Split the window into equal time buckets, and keep the first, the last, and the fix farthest from the first-to-last chord in each bucket. Turns and stops survive.
- **D3 Gaps:** break the trail when two consecutive fixes are more than **30 min** apart. Each drive then draws as its own segment, with no straight line across town.

## Server: `GET /api/assets/:nodeNum/track?hours=&sources=a,b`

- **Access:** mount it on `assetRoutes`, which already has `router.use(optionalAuth())`.
  - Sources come from `resolvePermittedSourceIds(req)`, which requires `nodes:read` per source, intersected with `sources` when given.
  - If the node has a private position override (`positionOverrideIsPrivate` on any permitted row) and the caller lacks `nodes_private:read` on that source, drop that source's rows. This mirrors `nodesRoutes` `/position-history` (~680) and `buildPositionFilter`.
  - Also honour the channel `viewOnMap` rule the way `buildPositionFilter` does for non-admins.
- **Guards:**
  - 404 `NOT_AN_ASSET` if the node isn't in `asset_nodes`.
  - `hours` is clamped to 1 … `retentionDays × 24`, defaulting to the full retention.
- **Streaming read, so memory stays bounded:**
  - Page through the node's `latitude`/`longitude`/`altitude`/`ground_speed`/`ground_track` telemetry rows for the permitted sources, oldest first, 10,000 rows per page, with a timestamp cursor.
  - Pivot rows into fixes with the existing `positionHistoryPivot.ts` logic.
  - Feed each fix into a bucket accumulator, which keeps only first/last/farthest per bucket.
  - Never hold the whole window in memory.
  - Add a repository method for the paged read (`telemetry.getPositionRowsForNodeNumPage({nodeNum, sourceIds, sinceMs, afterTs, limit})`), which must be dialect-agnostic.
- **Cross-source dedupe:** an asset heard by several sources arrives once per source. Treat fixes within 5 s of each other with the same lat/lon (to 5 decimals) as one fix.
- **Thinning, in pure `src/utils/trackThinning.ts`:**
  - `buckets = ceil(2000 / 3)`. The bucket width is `window / buckets`.
  - For each bucket, keep the first, last and farthest-from-chord fix, deduped.
  - Always keep the first and last fix of each gap segment.
  - Output is at most 2,000 points. If gap-segment endpoints push it over, drop from the densest buckets.
  - Gap detection runs on the full stream before thinning: consecutive kept fixes more than 30 min apart start a new segment.
- **Response:**

  ```
  ok(res, {
    nodeNum, retentionDays, windowStartMs,
    totalFixes,        // before thinning
    segments: [ [ { latitude, longitude, altitude, timestamp, groundSpeed?, groundTrack? } … ] … ]
  })
  ```

  Keep the fix fields compatible with the client's `PositionHistoryItem`, so the existing arrows and popups keep working.
- **Cache:** 60 s in memory, keyed by (nodeNum, hours, sorted permitted sourceIds), with a small LRU cap.
- **Tests:**
  - **Unit tests for thinning:** budget respected; a turn survives; gap split at 30 min; segment endpoints kept; cross-source dedupe.
  - **Route harness tests:** permission isolation, private override, `NOT_AN_ASSET`, hours clamping.
  - **Multi-backend repository test** for the paged read, with isolated PG/MySQL databases.

## Client

- **App.tsx fetch (~1300–1370):** when `selectedNode.asset` is set, call `GET /api/assets/:nodeNum/track` once, through `ApiService`, instead of the paged loop. There is no `MAX_ACCUMULATED_POSITION_FIXES` cap on this path.
  - Store the result so the map can tell segments apart. Add a `segmentStart?: true` marker on the first fix of each segment after the first, or store segments directly, whichever fits `positionHistory` in MapContext best.
  - Non-assets keep today's path unchanged.
- **NodesTab rendering (~868–994):**
  - For an asset, use a render cap of 2,000, since the server already thinned the track; never downsample below the server output.
  - **Do not join points across a segment boundary.** No polyline segment and no spline from the last fix of one segment to the first of the next.
  - Arrows and popups stay as they are.
  - "Points only" mode is unaffected.
- **Slider:** it already ranges from the oldest loaded fix to now, so it covers the full retention automatically. Keep the "All" label.
- **Legend / hint:** for an asset, show "Showing N of M fixes (thinned)" when `totalFixes > N`. Add the `en.json` key.

## Mesh impact

None. This only reads stored data.

## Exit criteria

- All the tests above pass.
- The full suite passes with PG/MySQL up (create them with `docker run`; `docker start` won't bring back stopped `--rm` containers). `tsc` and `lint:ci` are clean.
- Browser check on the dev container, with an asset whose history spans more than 5,000 fixes or several days, seeded if needed:
  - the whole window draws;
  - a gap longer than 30 min shows as a break;
  - the point count is ≤ 2,000.
