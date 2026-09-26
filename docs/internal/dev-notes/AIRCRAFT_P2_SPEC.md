# Aircraft Detection Phase 2: age-out and reclassify as fixed (#5364, #5365)

Epic: `AIRCRAFT_DETECTION_EPIC.md`. Phase 1 (PR #5386) added the classifier, the `nodes` aircraft columns (migration 175), per-source settings, the Auto-Favorite exclusion, and the map badge plus Show / Mark / Hide.

## Decisions (user, 2026-09-26)

- **D1 Ignore is DB-only.** It adds an `ignored_nodes` row with `reason = 'aircraft'` and sets `nodes.isIgnored`. No admin packet goes to any radio. Manual and geo ignores are never touched.
- **D2 Age-out rule.** A node is aged out when it is flagged `likelyAircraft = true` and not heard for N hours.
  - N defaults to 24, range 6–168, per source.
  - Off by default, per source.
  - The action is `ignore` (default) or `delete`, which is an explicit opt-in.
- **D3 Auto-lift.** When an aged-out aircraft sends a new **live** position, its ignore is lifted and the node is classified again.
  - Only `'aircraft'`-reason rows are lifted.
  - A live position is one where `isLiveReception(rxTime, now)` is true (`src/server/utils/replayGuard.ts`), so firmware 2.8 NodeDB replays don't count.
- **D4 Reclassify as fixed.** A node is reclassified when all of these hold:
  - it is flagged;
  - it was heard in the last 24 h;
  - it has at least 3 position fixes in the last 24 h (from this source);
  - every one of those fixes is within 200 m of the others.

  The flag is then cleared, and a sticky "confirmed fixed" mark is set with an anchor at the current effective position.
  - While the mark is set, the classifier returns not-aircraft if the node is within 1 km of the anchor.
  - A position more than 1 km from the anchor clears the mark, and the node is classified normally.
  - The fixed rule runs whenever detection is on, whether or not age-out is enabled.
- **D5 Once per silence (added in validation).** A node is aged out at most once per silence. The sweep skips a node whose `aircraftAgedOutAt` is newer than its `lastHeard`, so a hand un-ignore keeps the mark and sticks until the node is heard again. A hand ignore clears the mark, since the node is then a manual ignore.
- **Protection.** Favourites (`isFavorite`) and the source's local node are never aged out. Nodes that are already ignored (for any reason) are skipped.

## Mesh impact

- **Airtime:** none. Nothing is sent, and the ignore is DB-only (D1).
- **Spam:** ignore and delete fire no notifications or automation triggers. Auto-lift fires no event. The Phase 1 `becameLikelyAircraft` trigger still fires only on a live position transition.
- **Timers:** the sweep's last run is persisted per source in the setting `aircraftAgeOutLastRunAt` (ms). A restart or a settings save does **not** count as a run and does not trigger one.

## Data model: migration 177, `177_add_node_aircraft_ageout.ts`

New `nodes` columns, all nullable. Use full column DDL on every backend (see the migration recipe; the helpers need the whole DDL):

| column | SQLite | PG | MySQL |
|---|---|---|---|
| `aircraftAgedOutAt` | INTEGER | BIGINT | BIGINT |
| `aircraftFixedAt` | INTEGER | BIGINT | BIGINT |
| `aircraftFixedLatitude` | REAL | DOUBLE PRECISION | DOUBLE |
| `aircraftFixedLongitude` | REAL | DOUBLE PRECISION | DOUBLE |

Schema changes and follow-on work:
- Add the columns to `src/db/schema/nodes.ts` (all three tables) and the node types (`DbNode`, the `database.ts` node type, and the cache service mapping, like P1's `aircraftClassifiedAt`).
- Update the hand-written PG/MySQL DDL in `src/db/repositories/nodes.test.ts` and every other test file that has literal `nodes` CREATE blocks (P1 touched three; grep for `aircraftClassifiedAt` in tests).
- `upsertNode` must never clobber these columns. Extend P1's pin test.
- `ignored_nodes.reason` is already free text (`varchar(16)` on MySQL), so `'aircraft'` fits with no migration. Widen the TS union in `src/db/repositories/ignoredNodes.ts` to `'manual' | 'geo' | 'aircraft'`.

## Settings (per source; add to `VALID_SETTINGS_KEYS` and `PER_SOURCE_SETTINGS_KEYS`)

| key | values | default | postable |
|---|---|---|---|
| `aircraftAgeOutEnabled` | `'true'`/`'false'` | false | yes |
| `aircraftAgeOutHours` | integer 6–168 | 24 | yes (400 `INVALID_AIRCRAFT_AGE_OUT_HOURS` out of range) |
| `aircraftAgeOutAction` | `'ignore'`/`'delete'` | ignore | yes (400 `INVALID_AIRCRAFT_AGE_OUT_ACTION`) |
| `aircraftAgeOutLastRunAt` | ms epoch | none | **no** (server-written; add to `PER_SOURCE_KEYS_NOT_POSTABLE`) |
| `aircraftAgeOutLastResult` | JSON `{agedOut, fixed, lifted, deleted}` | none | **no** |

- The three postable keys join `AIRCRAFT_NODE_DISPLAY_KEYS` in `src/constants/nodeDisplayDefaults.ts`, so they route per source through SettingsTab's partition (`SETTINGS_TAB_PER_SOURCE_KEYS`). Adjust the count assertions (P1 has 13 → 16).
- Put the pure parse/defaults/ranges in `src/utils/aircraftClassification.ts`, next to `parseAircraftSettings`.

## Backend

### Repository (`src/db/repositories/nodes.ts` + `ignoredNodes.ts`)

- `ignoredNodes.addAircraftIgnoreAsync(nodeNum, sourceId, nodeId, longName?, shortName?) → boolean`:
  - Inserts with `reason 'aircraft'`, `ignoredBy 'aircraft-age-out'`, and does nothing on conflict (never downgrades manual or geo). This is `addGeoIgnoreAsync` with a different reason.
  - Mirror the cache first.
- `ignoredNodes.liftAircraftIgnoreAsync(nodeNum, sourceId) → boolean` works like `liftGeoIgnoreAsync` (reason-scoped delete, then evict the cache).
- `nodes.markAircraftAgedOut(nodeNum, sourceId, atMs)` sets `isIgnored = true` and `aircraftAgedOutAt`.
- `nodes.clearAircraftAgedOut(nodeNum, sourceId)` sets `isIgnored = false` and `aircraftAgedOutAt = null`.
- `nodes.setAircraftFixed(nodeNum, sourceId, {atMs, lat, lon} | null)`. With a value it also sets `likelyAircraft = false`; `null` clears the mark.
- `nodes.listAircraftAgeOutCandidates(sourceId)` returns the rows that are flagged, or that are flagged and not ignored, with the fields the sweep needs.
- Each write syncs the PG/MySQL node cache, as P1 does.
- Expose all of these through `DatabaseService` with the `Async` suffix, and scope every query by `sourceId`.

### Classifier (`src/utils/aircraftClassification.ts`)

- `classifyAircraft` gains an optional `fixedAnchor?: {lat, lon} | null` and the current position.
  - Within 1 km (`AIRCRAFT_FIXED_RELEASE_M = 1000`) → `likelyAircraft: false`, basis unchanged.
  - Beyond 1 km → the result carries `releaseFixed: true`, and the service clears the mark.
- Pure fixed-rule helper: `isStationaryFix(positions: {lat, lon}[]) → boolean`, which is true when there are ≥ 3 fixes and the bounding-box diagonal is < 200 m (`AIRCRAFT_FIXED_SPAN_M = 200`, `AIRCRAFT_FIXED_MIN_FIXES = 3`). You can reuse `positionSpanKm` from `nodeMobilityService.ts` by moving it to a util if needed.
- Unit-test every branch.

### Service: `src/server/services/aircraftAgeOutService.ts` (new)

- `runSweep(sourceId, now)`:
  1. Skip if detection is off for the source (`parseAircraftSettings`).
  2. **Fixed pass.** For each flagged, non-ignored node heard in the last 24 h (`lastHeard` is in **seconds**), load that node's position telemetry for this source over the last 24 h (telemetry repo `getPositionTelemetryByNode` with a source scope). If `isStationaryFix`, call `setAircraftFixed` with the anchor at its current effective position (`getEffectiveDbNodePosition`).
  3. **Age-out pass** (only when `aircraftAgeOutEnabled`). For each flagged node that is not a favourite, not the local node (`getLocalNodeNumForSource`), and not already ignored, where `lastHeard < now - hours`:
     - `ignore`: call `addAircraftIgnoreAsync`, then `markAircraftAgedOut`.
     - `delete`: call `deleteNodeAsync(nodeNum, sourceId)`.
  4. Persist `aircraftAgeOutLastRunAt = now` and `aircraftAgeOutLastResult`, and log one info line with the counts.
- `onLivePosition(sourceId, nodeNum)`: if the node has `aircraftAgedOutAt` set, call `liftAircraftIgnoreAsync`; if that returns true, also call `clearAircraftAgedOut`. Then call `aircraftClassificationService.schedule(sourceId, nodeNum)`.
- Exclude MeshCore, meshcore_mqtt and Reticulum sources, using the same exclusion list as `aircraftClassificationService` (its line ~58).

### Scheduler: `src/server/services/aircraftAgeOutScheduler.ts` (new, global)

- `initialize()` starts a 1 h `setInterval`, with a first tick 5 min after boot. Wire it in `server.ts` next to `aircraftClassificationService`.
- Each tick, for every non-excluded source in the registry:
  - read `aircraftAgeOutLastRunAt`;
  - run only if at least 55 min have passed since then (or it has never run);
  - use a per-source re-entry guard.
- Settings saves do **not** touch the scheduler.
- Add `shutdown()` for tests.

### Hooks

- **Live-position lift.** Call `aircraftAgeOutService.onLivePosition` where P1 calls `aircraftClassificationService.schedule` for POSITION: `meshtasticManager.ts` (~7905) and `mqttIngestion.ts` (~534). Gate the call on `isLiveReception(meshPacket.rxTime, Date.now())`.
  - **Verify** that POSITION packets from ignored nodes reach those call sites on both paths. MQTT passes them (`mqttIngestion.ts:336`). On the Meshtastic TCP path, check whether ignored nodes' packets are dropped before the position handler. If they are, add a narrow exception for `aircraftAgedOutAt` nodes' POSITION only, or document the limitation in the PR.
- **Classifier call** (`aircraftClassificationService.classifyAndWrite` and `reclassifySource`): pass the node's fixed anchor and current position. On `releaseFixed`, clear the mark with `setAircraftFixed(null)`.
- **Detection disabled.** `clearAircraftClassification` also clears the fixed mark. Aged-out ignores stay; they are lifted on return, or by hand in Ignored Nodes.

### Routes

- Add settings validation for the three postable keys in `settingsRoutes.ts`, next to P1's aircraft validation.
- `GET /api/ignored-nodes` already returns `reason`; confirm it does.

## Frontend

- **Settings → Node Display, aircraft block** (`SettingsTab.tsx`), under the P1 thresholds:
  - an "Age out likely aircraft" switch;
  - hours (number input, 6–168);
  - action (select: Ignore / Delete);
  - a warning next to Delete: "Delete removes the node and all its history, including positions. Ignore can be undone.";
  - read-only "Last run: <time> — N aged out, N reclassified as fixed, N returned".
  - Follow the SettingsDraft rules in CLAUDE.md, and add the keys to the hand-maintained `const settings = {…}` literal.
- **Map "Show aged-out".** Add a checkbox under Show / Mark / Hide in `MapAircraftDisplayControl`, in both panels.
  - When it is on, nodes with `isIgnored && aircraftAgedOutAt != null` are drawn (Dashboard currently always drops ignored nodes at `DashboardMap.tsx:391`; NodesTab uses `nodeFilters.showIgnored` in `useSourceView.ts:464`) with the aircraft badge and reduced opacity.
  - Stored per viewer in localStorage (try/catch).
  - The hint shows "N aged out".
- **Popup / details.** An aged-out node shows "Aged out (likely aircraft)". A node with a fixed mark shows "Reclassified as fixed". Add `formatAircraftSummary` siblings or small lines in `sections.tsx` / `NodeDetailsBlock.tsx`.
- **Ignored Nodes list** (`IgnoredNodesSection.tsx`): show the reason label ("Aged-out aircraft" for `'aircraft'`, and existing labels for the others). Un-ignoring an aircraft row there uses the existing DB-only DELETE route, which must also clear `aircraftAgedOutAt` (backend: extend `ignoredNodeRoutes` DELETE, or `setNodeIgnoredAsync(false)`, to null it).
- **Node payload pass-through.** Carry `aircraftAgedOutAt` and `aircraftFixedAt` everywhere P1 carried `likelyAircraft`: the `useDashboardData` merge (from the same position record), the server `mergeNodesAcrossSources.ts`, the API node mappers, and the Map Analysis nodes.
- Add `en.json` keys under `settings.aircraft.*` and `node_popup.*`.
- Update the docs in `docs/features/settings.md` and `maps.md`.

## Tests (exit criteria)

- Classifier: fixed anchor within and beyond 1 km, and every `isStationaryFix` branch.
- Service: fixed pass; age-out ignore/delete; favourite, local, and already-ignored protection; source isolation (`*.perSource.test.ts`); last-run persisted and a restart not counting as a run (the scheduler honours the DB value); a settings save not triggering a run.
- Lift: a live position lifts only `'aircraft'` rows; a replayed (stale `rxTime`) position does not lift; manual and geo ignores are never lifted.
- Repositories: multi-backend tests for the new methods (with isolated PG/MySQL DBs); migration 177 tests on all three backends.
- Settings: route validation using the route harness, the SettingsTab partition, and the allowlist counts.
- Frontend: the Show aged-out filter in both panels; the settings block render and save payload.
