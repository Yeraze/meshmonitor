# Asset Tracking Phase 1: the flag, forced trail, and retention (#5354)

See `ASSET_TRACKING_EPIC.md` for the decisions. Research refs are against main @ 27bb6eda.

## Data: migration 181, `asset_nodes` (global)

Copy migration 167 (`solar_node_overrides`) exactly: no sourceId, and no foreign key to nodes.

| column | SQLite | PG | MySQL |
|---|---|---|---|
| `nodeNum` | INTEGER PK | BIGINT PK | BIGINT PK |
| `retentionDays` | INTEGER NOT NULL | INTEGER NOT NULL | INT NOT NULL |
| `updatedBy` | INTEGER NULL | INTEGER NULL | INT NULL |
| `updatedAt` | INTEGER NOT NULL (ms) | BIGINT NOT NULL | BIGINT NOT NULL |

- **Schema and repository:** `src/db/schema/assetNodes.ts` (three dialect tables), wired the same way as solarNodeOverrides (`schema/index.ts`, `activeSchema.ts`). Add `src/db/repositories/assetNodes.ts` with:
  - `getMapAsync(): Map<nodeNum, {retentionDays}>`
  - `getAsync(nodeNum)`
  - `setAsync(nodeNum, retentionDays, updatedBy)` (an upsert)
  - `clearAsync(nodeNum)`

  Expose these through `DatabaseService` (`assetNodes` getter plus `Async` facades).
- **Register the table** in `src/cli/migrationTables.ts` and in the backup list in `src/server/services/systemBackupService.ts`. The retained history is valuable, so the flag must survive a backup/restore.
- **Constants** in `src/utils/assetTracking.ts`: `ASSET_RETENTION_DAYS_DEFAULT = 90` and `ASSET_RETENTION_DAYS_RANGE = {min: 1, max: 365}`, plus pure clamp/parse helpers with tests.

## Routes: `src/server/routes/assetRoutes.ts`, mounted at `/api/assets`

- `GET /` returns `ok(res, [{nodeNum, retentionDays, updatedAt}])`, **filtered to nodeNums that have a node row on one of the caller's permitted sources**. Use `resolvePermittedSourceIds(req)`, the same pattern as `visibleSolarOverrides` in analysisRoutes (~406). Anonymous callers get the rows for their permitted sources.
- `PUT /:nodeNum` takes the body `{retentionDays}` and requires `requirePermission('settings','write')`.
  - Validate an unsigned 32-bit nodeNum. `retentionDays` must be an integer in range, otherwise return 400 `INVALID_ASSET_RETENTION`.
  - Upsert, and audit it with the existing audit helper that settings saves use.
  - Returns `ok(res, row)`.
- `DELETE /:nodeNum` requires `settings:write`, clears the flag, and returns `ok(res)`.
- **Tests:** use the route harness (`createRouteTestApp`). Cover permission (limited user without `settings:write` gets 403), validation, and GET filtering by permitted sources.

## Node payload

The flag is a **computed overlay**; it never writes the `mobile` column.
- **Poll and `/api/nodes`:** load `assetNodes.getMapAsync()` once per request and pass it into `enhanceNodeForClient`, as `estimatedPositions` already is (`pollRoutes.ts` ~145, `nodesRoutes.ts` ~91/183). Set:
  - `node.asset = { retentionDays } | undefined`
  - `node.isMobile = (node.mobile === 1) || !!node.asset`
- **Dashboard:** `buildSourceDashboard` (`sourceDashboardData.ts` ~113) sends raw rows without the enhancer. Attach `asset` and the same `isMobile` overlay there. In `useDashboardData.mergeNodeRecords`, carry `asset` (any record) and OR `isMobile`.
- **Types:** add `asset?: { retentionDays: number }` to the client node type.
- **Where the overlay must NOT apply:**
  - `nodeMobilityService.updateNodeMobility` and the `mobile` column stay heuristic-only.
  - `emitNodeMobility` and the `becameMobile` automation trigger are unchanged, so flagging an asset never fires `becameMobile`.
  - The automation substitution token `node.mobile` stays the raw value.
- **Where the overlay should apply:**
  - The App.tsx position-history gate (~1308), which reads `selectedNode.isMobile`, so it follows the enhancer automatically.
  - The Mobile/Stationary chips in the automations node picker (`NodeMultiFieldInput.tsx`).
  - Mesh Issues `rulesTierB` (~780/806): treat an asset as mobile, so it isn't flagged as a fixed-infrastructure problem.

## Retention: the telemetry purge

`purgeOldTelemetryAsync` (`database.ts` ~3493) goes to `deleteOldTelemetryWithFavorites` (`telemetry.ts` ~958, and the Sync variant ~1673), with two phases.

- **Load assets** with `assetNodes.getMapAsync()` in `purgeOldTelemetryAsync`, and pass `assets: Array<{nodeNum, cutoff}>` down, where `cutoff = now − retentionDays`. Also route through the `WithFavorites` path when there are assets but no favourites (today, no favourite days short-circuits to `deleteOldTelemetry`).
- **Phase 1** (the regular delete) adds `AND NOT (nodeNum IN (assetNodeNums))`, using the indexed `nodeNum` column. Chunk the IN list by 500.
- **New phase 3** deletes an asset's rows older than its own cutoff. Group assets by cutoff, as `groupFavoritesByCutoff` does, then run `DELETE WHERE nodeNum IN (group) AND timestamp < group.cutoff`.
  - Retention is **not** clamped to at least the regular cutoff: a 1-day asset keeps 1 day. The owner chose it.
  - A favourite that is also an asset keeps the **longer** of its two windows. Favourite rows are matched by nodeId + type, so phase 2 must not delete asset rows younger than the asset cutoff. Exclude asset nodeNums from phase 2 too, and let phase 3 decide.
- **Restart:** retention is state in the database, and the purge is idempotent. Nothing lives in memory.
- **Tests:** both the async (PG/MySQL) and Sync (SQLite) paths, run against all three backends with isolated databases. Cover:
  - an asset's row older than 7 days survives, and one older than its window is deleted;
  - a non-asset is unchanged;
  - asset combined with favourite;
  - assets with no favourites configured.

## Automated deleters skip assets

Each gets an `isAsset(nodeNum)` check (one map load per sweep) and skips:
- `autoDeleteByDistanceService` (~158 inline and ~296 sweep), next to the existing `isFavorite` skip;
- `aircraftAgeOutService` (~199), next to the favourite and ignored skip;
- the MQTT geo-filter purge (`mqttIngestion.ts` ~429 and `mqttGeoSweepService.ts` ~158): still geo-ignore the node, but do not call `deleteNodeAsync` for an asset;
- the automation "delete node" action (`automation/meshActionDeps.ts` ~188): skip, and log "node is a tracked asset".

The **manual** Delete Node route stays allowed. The UI shows a warning when the node is an asset: "This node is a tracked asset. Deleting it also removes its retained history."

Tests: one per deleter, asserting an asset is skipped and a non-asset is not.

## UI: Node Details (`NodeDetailsBlock.tsx`)

- Add an **"Asset tracking"** section near Notes. It is visible to everyone (read-only for users without `settings:write`) and editable with `settings:write`.
  - An enable switch.
  - Retention days: a number input, 1–365, default 90, shown when enabled.
  - Help text: "Keeps all of this node's telemetry for the chosen number of days on every source, and always draws its trail on the map. Cleanups that run automatically won't delete it."
  - An estimate: "About N rows kept". Base it on the node's recent daily row count across sources: add a small `GET /api/assets/:nodeNum/estimate` that counts the node's telemetry rows from the last 24 h (permitted sources only), multiplied by the retention days. Show "unknown" when there is no data.
  - Saving calls `PUT /api/assets/:nodeNum`, and turning it off calls `DELETE`. Then invalidate the node queries.
- Use a TanStack Query hook through `ApiService`, and add `en.json` keys.
- Docs: a short "Asset tracking" section in `docs/features/` (maps.md or nodes).

## Exit criteria

- Unit, repository (multi-backend) and route tests as listed above.
- The full suite passes with PG/MySQL up; `tsc` and `lint:ci` are clean.
- Browser check on the dev container:
  - flag a node that is stationary by the heuristic and see its trail draw;
  - the section saves, and it is read-only for a limited user;
  - the purge keeps an asset's rows older than 7 days: seed old rows, run the purge, check they remain.
