# Auto Delete by Distance — Design Spec

**Issue:** [#2266](https://github.com/Yeraze/meshmonitor/issues/2266)

**Goal:** Automatically remove nodes from the database that exceed a configurable distance from a home coordinate, solving the airplane-relay problem where high-altitude nodes inject dozens of irrelevant distant nodes.

**Pattern:** Follows the existing automation section pattern (settings + scheduled service + activity log + UI component).

---

## Settings

All settings stored in the existing `settings` key-value table via `VALID_SETTINGS_KEYS`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `autoDeleteByDistanceEnabled` | boolean | `false` | Master enable toggle |
| `autoDeleteByDistanceIntervalHours` | number | `24` | Run interval: 6, 12, 24, or 48 hours |
| `autoDeleteByDistanceThresholdKm` | number | `100` | Distance threshold (always stored in km) |
| `autoDeleteByDistanceLat` | number | `null` | Home latitude |
| `autoDeleteByDistanceLon` | number | `null` | Home longitude |

The UI displays the threshold in the user's preferred distance unit (km or miles from global settings) and converts to km for storage. Home coordinate defaults to the local node's current position when first enabled via a "Use Current Node Position" button.

---

## Protection Rules

Nodes matching any of these criteria are never deleted:

1. **Local node** — the node MeshMonitor is connected to
2. **Favorited nodes** — `isFavorite = true`
3. **Nodes without a known position** — can't calculate distance; don't delete unknowns

All other nodes beyond the distance threshold are eligible for deletion.

---

## Backend Service

### `AutoDeleteByDistanceService`

New file: `src/server/services/autoDeleteByDistanceService.ts`

Follows the same lifecycle pattern as `inactiveNodeNotificationService`:

- **`start(intervalHours)`** — begins the scheduled interval via `setInterval`
- **`stop()`** — clears the interval (does not abort an in-progress run; only cancels the next scheduled run)
- **`runNow()`** — public method for the "Run Now" API endpoint; returns `{ deletedCount }`
- **`getStatus()`** — returns `{ running: boolean, lastRunAt?: number }`

**Settings change restart:** When `POST /api/settings` updates any `autoDeleteByDistance*` key, the settings-changed handler in `server.ts` calls `service.stop()` then `service.start(newInterval)` if enabled, or just `service.stop()` if disabled. Follows the same pattern as other automation services.

**Deletion logic (per run):**

1. Read home coordinate from settings (`autoDeleteByDistanceLat`, `autoDeleteByDistanceLon`)
2. Read threshold from settings (`autoDeleteByDistanceThresholdKm`)
3. Bail if home coordinate is not configured
4. Query all nodes from the database
5. For each node:
   - Skip if it's the local node
   - Skip if `isFavorite === true`
   - Skip if no position data (latitude/longitude both null)
   - Calculate distance using `calculateDistance()` from `src/utils/distance.ts`
   - If distance > threshold, mark for deletion
6. Delete marked nodes using `deleteNodeAsync()` (must use async version for correct behavior on PostgreSQL/MySQL). Per-node deletion failures are caught, logged to console, and the run continues. `nodes_deleted` reflects only successful deletions.
7. Log the run to `auto_distance_delete_log`
8. Log a summary to the server console

**Node deletion:** Uses `deleteNodeAsync()` from DatabaseService. This cascade-removes related telemetry, traceroutes, neighbor info, etc., consistent with how manual node deletion works.

### API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/settings/distance-delete/log` | GET | `settings:read` | Fetch last 10 log entries |
| `/api/settings/distance-delete/run-now` | POST | `settings:write` | Trigger immediate run; returns `{ deletedCount }` |

Settings are saved via the existing `POST /api/settings` endpoint — no new settings endpoints needed.

---

## Database Migration

Migration `086_add_auto_distance_delete_log.ts` with three named exports:

- `runMigration086Sqlite(db)` — SQLite using `INTEGER PRIMARY KEY AUTOINCREMENT`
- `runMigration086Postgres(client)` — PostgreSQL using `SERIAL PRIMARY KEY`
- `runMigration086Mysql(pool)` — MySQL using `INT AUTO_INCREMENT PRIMARY KEY`

Table schema:

```sql
CREATE TABLE IF NOT EXISTS auto_distance_delete_log (
  id ...,                    -- per-database primary key syntax
  timestamp BIGINT NOT NULL,
  nodes_deleted INTEGER NOT NULL,
  threshold_km REAL NOT NULL,
  details TEXT,              -- JSON: [{nodeId, nodeName, distanceKm}]
  created_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_auto_distance_delete_log_timestamp
  ON auto_distance_delete_log(timestamp DESC);
```

Import in `database.ts` (~line 93) and call in three init sections (SQLite, PostgreSQL, MySQL).

---

## Drizzle Schema & Repository

### Schema: `src/db/schema/autoDistanceDeleteLog.ts`

Drizzle schema definition for the `auto_distance_delete_log` table, following the pattern of existing schema files (e.g., `src/db/schema/autoTracerouteLog.ts`).

### Repository: `src/db/repositories/autoDistanceDeleteLogRepository.ts`

Async repository with methods:

- `getLogEntriesAsync(limit: number)` — fetch last N log entries
- `addLogEntryAsync(entry)` — insert a new log entry

Exposed through DatabaseService with `Async` suffix.

---

## UI Component

### `AutoDeleteByDistanceSection.tsx`

New component added to the Automation tab in `src/App.tsx`, following the pattern of `AutoKeyManagementSection.tsx`.

**Controls:**

- **Enable toggle** — master on/off
- **Home coordinate** — two number inputs (latitude, longitude) with a "Use Current Node Position" button. The button populates from the local node's position available in the existing nodes data (matching `nodeNum === localNodeNum` from the nodes list already loaded in the frontend).
- **Distance threshold** — number input displayed in the user's preferred unit (km/miles), converted to km on save
- **Interval** — dropdown: 6, 12, 24, 48 hours
- **Run Now button** — calls `POST /api/settings/distance-delete/run-now`, shows result count in a toast/flash
- **Activity log** — table of last 10 runs showing timestamp, nodes deleted, threshold used

**Save pattern:** Uses `useSaveBar()` hook, consistent with other automation sections.

### Translation Keys

All UI strings under `automation.distance_delete.*` namespace in `public/locales/en.json`.

---

## Integration Points

- **`src/server/constants/settings.ts`** — Add 5 new keys to `VALID_SETTINGS_KEYS`
- **`src/server/server.ts`** — Add 2 new API routes, start/stop service on settings change
- **`src/App.tsx`** — Mount `AutoDeleteByDistanceSection` in the Automation tab
- **`src/db/schema/autoDistanceDeleteLog.ts`** — Drizzle schema for the log table
- **`src/db/repositories/autoDistanceDeleteLogRepository.ts`** — Async repository for log CRUD
- **`src/services/database.ts`** — Expose repository methods, import migration 086
- **`src/server/migrations/086_add_auto_distance_delete_log.ts`** — Three-backend migration
- **`src/utils/distance.ts`** — Already has `calculateDistance()`; no changes needed

---

## Out of Scope

- CLI endpoint for scripted cleanup (mentioned in issue as optional — defer)
- Preview before deleting (the activity log serves as a post-run audit trail)
- Filter by "only seen once" or last-heard time (could be added later as additional filters)
