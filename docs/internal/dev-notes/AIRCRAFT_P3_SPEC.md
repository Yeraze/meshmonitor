# Aircraft Detection Phase 3: flight trails (#5364, #5365)

Epic: `AIRCRAFT_DETECTION_EPIC.md`.
- Phase 1 (#5386) added the classifier, the badge and Show / Mark / Hide.
- Phase 2 (#5391) added age-out, the fixed rule and Show aged-out.

## Decisions (user, 2026-09-26)

- **D1 Which nodes.** Every likely aircraft the map currently draws gets a trail.
  - This follows Show / Mark / Hide, the age window, and the other map filters.
  - Aged-out aircraft also get trails while "Show aged-out" is on.
  - Trails live in the Map Features panels of the per-source Nodes map (`NodesTab.tsx`) and the Dashboard map (`DashboardMap.tsx`).
- **D2 Lookback.** Default 6 h, slider 1–168 h. Telemetry retention is 7 days, so older fixes don't exist.
- **D3 Style.** One colour per aircraft, a stable hash of the node number; reuse `colorForKey` from the Map Analysis `PositionTrailsLayer` or move it to a shared util.
  - Draw each trail twice: a dark outline and a coloured line, like Map Analysis.
  - Add direction arrows with `generatePositionHistoryArrows` (`src/utils/mapHelpers.tsx:476`).
  - Tooltip or popup on the line: node name, plus the time of the nearest fix.
- **D4 Toggle.** A "Flight trails" checkbox under Likely aircraft in `MapAircraftDisplayControl`, with the lookback slider shown only when the box is on.
  - Both are saved per user on the server, like `aircraftDisplayMode`. Off by default.
- **3D is out of scope.** The 3D view shows no position history today either.

## Mesh impact

- **Airtime:** none. Trails only read stored telemetry.
- **Spam:** no notifications or events.
- **Timers:** none on the server. The client refetch runs only while the toggle is on and the map is mounted.

## Server

### Migration 178: `178_user_map_preferences_aircraft_trails.ts`

Add two columns to `user_map_preferences`, with full column DDL on each backend. Follow migration 176 exactly; the agent report notes its path through schema `misc.ts`, the `mapPreferences.ts` repository and `userPreferencesRoutes.ts`.

| column | SQLite | PG | MySQL | default |
|---|---|---|---|---|
| `showAircraftTrails` | INTEGER (bool) | BOOLEAN | BOOLEAN | false |
| `aircraftTrailHours` | INTEGER | INTEGER | INT | 6 |

- The route validates `aircraftTrailHours` as an integer from 1 to 168 and returns 400 otherwise.
- `showAircraftTrails` joins the `booleanFields` whitelist.

### Endpoint: `GET /api/aircraft/trails?hours=&sources=a,b`

- **Mount:** a new `src/server/routes/aircraftRoutes.ts` (or another fitting existing router), using the `ok()` envelope: `{ success: true, data: { trails: [...] } }`.
- **Sources:** `resolvePermittedSourceIds(req)`, which requires `nodes:read` per source, intersected with `sources` when given.
- **Nodes:** for each permitted source, the nodes with `likelyAircraft = true` OR `aircraftAgedOutAt IS NOT NULL`. This is a new repo method on `nodes.ts` (e.g. `listAircraftTrailNodeNums(sourceIds)`) that returns `{sourceId, nodeNum}` pairs, scoped by source.
- **Positions:** a new repo method, e.g. `analysis.getPositionsForNodes({ sourceIds, nodeNums, sinceMs })`, built like `analysis.getPositions`:
  - add `inArray(telemetry.nodeNum, nodeNums)`, and chunk nodeNums by 500 if needed;
  - pivot lat/lon/alt by `(sourceId, nodeNum, timestamp)`;
  - skip Null Island fixes.
  - Keep the query dialect-agnostic in Drizzle.
- **Privacy:** apply `buildPositionFilter` (`src/server/utils/positionVisibility.ts`) exactly as `/api/analysis/positions` does. That drops orphans and `hideFromMap` nodes, and for non-admins drops private overrides and channels without `viewOnMap`.
- **Limits:**
  - clamp `hours` to 1..168 (default 6);
  - downsample each trail on the server to at most 500 points, reusing `positionHistoryDownsample` if it is server-safe, and always keep the first and last points;
  - cap the total at 200 trails, newest first by last fix time.
- **Response item:** `{ sourceId, nodeNum, points: [{ lat, lon, alt: number|null, ts }] }`, with points in ascending time order.
- **Tests:** use the route harness (`createRouteTestApp`). Cover:
  - per-source permission isolation;
  - private-override privacy for a non-admin;
  - only flagged or aged-out nodes returned;
  - hours clamping;
  - downsampling cap.
  - Add a multi-backend repository test for the new repo methods (isolated PG/MySQL DBs).

## Client

- **Hook:** `useAircraftTrails({ enabled, hours, sourceIds })` in `src/hooks/`, a TanStack Query hook over an `ApiService` method (no raw `fetch` in components). It refetches every 60 s and only runs while `enabled`.
- **Shared layer:** `src/components/map/layers/AircraftTrailsLayer.tsx`. It takes descriptor props, like `TraceroutePathsLayer`: `trails: { key, label, color, positions: [lat, lon][], times: number[] }[]`. It renders the outline, the coloured line and the arrows. Keep it presentational.
- **Building descriptors:** a pure helper, e.g. `buildAircraftTrailDescriptors(trails, visibleAircraft, mode)`:
  - Keep only trails whose node is in the panel's visible aircraft set. Build that set with the same eligibility the markers use: `likelyAircraft && drawn`, plus aged-out nodes when Show aged-out is on.
  - **Per-source view:** filter to that `sourceId`.
  - **Unified Dashboard:** merge a node's trails across sources into one trail keyed by `nodeNum`. Sort by time and drop a point within 5 s of the previous one, so two sources hearing the same aircraft don't draw two lines. Colour by `nodeNum`.
  - Unit-test all of this.
- **Wiring:** mount the layer in both panels below the node markers. Add the checkbox and slider in `MapAircraftDisplayControl`, and put the state in `MapContext` with `savePreferenceToServer`, like `aircraftDisplayMode`.
- **Strings and docs:** add `en.json` keys and a short "Flight trails" subsection under the likely-aircraft part of `docs/features/maps.md`.

## Exit criteria

- Trails render in both panels for moving flagged nodes and follow the filters (Hide mode removes them; Show aged-out adds aged-out ones).
- No trail appears for a node the viewer can't see.
- The toggle persists across reloads.
- The full suite passes with PG/MySQL up; `tsc` and `lint:ci` are clean; the feature is checked in the browser.
