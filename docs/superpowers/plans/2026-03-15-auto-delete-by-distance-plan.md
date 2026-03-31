# Auto Delete by Distance Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an automation feature that periodically deletes nodes beyond a configurable distance from a home coordinate, solving the airplane-relay problem (Issue #2266).

**Architecture:** New backend service (`AutoDeleteByDistanceService`) runs on a configurable interval, queries all nodes, calculates distances using the existing Haversine function, and deletes nodes beyond the threshold (protecting local node, favorites, and nodes without positions). Frontend section in the Automation tab follows the `AutoKeyManagementSection` pattern with props from `AutomationContext`. Activity log stored in a new `auto_distance_delete_log` table.

**Tech Stack:** TypeScript, React, Drizzle ORM, SQLite/PostgreSQL/MySQL, i18next

**Spec:** `docs/superpowers/specs/2026-03-15-auto-delete-by-distance-design.md`

---

## Chunk 1: Backend Foundation

### Task 1: Database Migration (086)

**Files:**
- Create: `src/server/migrations/086_add_auto_distance_delete_log.ts`
- Modify: `src/services/database.ts` (import + call sites ~line 93, ~line 2185, ~line 10594, ~line 10720)
- Modify: `src/db/schema/postgres-create.ts` (add table + index for fresh installs)
- Modify: `src/db/schema/mysql-create.ts` (add table + index for fresh installs)

- [ ] **Step 1: Create migration file**

Create `src/server/migrations/086_add_auto_distance_delete_log.ts`:

```typescript
/**
 * Migration 086: Add auto_distance_delete_log table
 * Stores history of automatic distance-based node cleanup runs.
 */

import type { Database } from 'better-sqlite3';
import type { PoolClient } from 'pg';
import type { Pool as MySQLPool } from 'mysql2/promise';
import { logger } from '../../utils/logger.js';

export function runMigration086Sqlite(db: Database): void {
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='auto_distance_delete_log'"
  ).get();

  if (!tableExists) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auto_distance_delete_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        nodes_deleted INTEGER NOT NULL,
        threshold_km REAL NOT NULL,
        details TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_auto_distance_delete_log_timestamp
        ON auto_distance_delete_log(timestamp DESC)
    `);
    logger.info('✅ Migration 086: Created auto_distance_delete_log table (SQLite)');
  }
}

export async function runMigration086Postgres(client: PoolClient): Promise<void> {
  const tableCheck = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'auto_distance_delete_log'
  `);

  if (tableCheck.rows.length === 0) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS auto_distance_delete_log (
        id SERIAL PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        nodes_deleted INTEGER NOT NULL,
        threshold_km REAL NOT NULL,
        details TEXT,
        created_at BIGINT
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_auto_distance_delete_log_timestamp
        ON auto_distance_delete_log(timestamp DESC)
    `);
    logger.info('✅ Migration 086: Created auto_distance_delete_log table (PostgreSQL)');
  }
}

export async function runMigration086Mysql(pool: MySQLPool): Promise<void> {
  const [rows] = await pool.query(`
    SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_distance_delete_log'
  `);

  if ((rows as any[]).length === 0) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auto_distance_delete_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        nodes_deleted INT NOT NULL,
        threshold_km REAL NOT NULL,
        details TEXT,
        created_at BIGINT,
        INDEX idx_auto_distance_delete_log_timestamp (timestamp DESC)
      )
    `);
    logger.info('✅ Migration 086: Created auto_distance_delete_log table (MySQL)');
  }
}
```

- [ ] **Step 2: Add migration import to database.ts**

In `src/services/database.ts`, near line 93 (after migration 085 import), add:

```typescript
import { runMigration086Sqlite, runMigration086Postgres, runMigration086Mysql } from '../server/migrations/086_add_auto_distance_delete_log.js';
```

- [ ] **Step 3: Call migration in SQLite init**

In `src/services/database.ts`, in the SQLite migration section (after the migration 084 block, around line 2185), add:

```typescript
// Migration 086: Add auto_distance_delete_log table
const migrationKey086 = 'migration_086_auto_distance_delete_log';
if (!this.getSetting(migrationKey086)) {
  try {
    logger.debug('Running migration 086: Add auto_distance_delete_log table...');
    runMigration086Sqlite(this.db);
    this.setSetting(migrationKey086, 'completed');
    logger.debug('Migration 086 completed successfully');
  } catch (error) {
    logger.error('Error running migration 086:', error);
  }
}
```

- [ ] **Step 4: Call migration in PostgreSQL init**

In `src/services/database.ts`, in the PostgreSQL init section (after migration 085 call, around line 10594), add:

```typescript
// Run migration 086: Add auto_distance_delete_log table
await runMigration086Postgres(client);
```

- [ ] **Step 5: Call migration in MySQL init**

In `src/services/database.ts`, in the MySQL init section (after migration 085 call, around line 10720), add:

```typescript
// Run migration 086: Add auto_distance_delete_log table
await runMigration086Mysql(pool);
```

- [ ] **Step 6: Add table to postgres-create.ts for fresh installs**

In `src/db/schema/postgres-create.ts`, before the closing backtick of `POSTGRES_SCHEMA_SQL`, add:

```sql
  CREATE TABLE IF NOT EXISTS auto_distance_delete_log (
    id SERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    nodes_deleted INTEGER NOT NULL,
    threshold_km REAL NOT NULL,
    details TEXT,
    created_at BIGINT
  );

  CREATE INDEX IF NOT EXISTS idx_auto_distance_delete_log_timestamp
    ON auto_distance_delete_log(timestamp DESC);
```

Also add `'auto_distance_delete_log'` to the `POSTGRES_TABLE_NAMES` array.

- [ ] **Step 7: Add table to mysql-create.ts for fresh installs**

In `src/db/schema/mysql-create.ts`, add the equivalent MySQL table definition (use `INT AUTO_INCREMENT PRIMARY KEY` and inline `INDEX`). Also add to `MYSQL_TABLE_NAMES` array.

- [ ] **Step 8: Commit**

```bash
git add src/server/migrations/086_add_auto_distance_delete_log.ts src/services/database.ts src/db/schema/postgres-create.ts src/db/schema/mysql-create.ts
git commit -m "feat: add migration 086 for auto_distance_delete_log table"
```

---

### Task 2: Settings Keys

**Files:**
- Modify: `src/server/constants/settings.ts`

- [ ] **Step 1: Add settings keys to VALID_SETTINGS_KEYS**

In `src/server/constants/settings.ts`, add these 5 keys to the `VALID_SETTINGS_KEYS` array:

```typescript
'autoDeleteByDistanceEnabled',
'autoDeleteByDistanceIntervalHours',
'autoDeleteByDistanceThresholdKm',
'autoDeleteByDistanceLat',
'autoDeleteByDistanceLon',
```

- [ ] **Step 2: Add validation in settingsRoutes.ts**

In `src/server/routes/settingsRoutes.ts`, in the validation section of the POST handler (near the other validation blocks around line 200), add:

```typescript
if ('autoDeleteByDistanceIntervalHours' in filteredSettings) {
  const interval = parseInt(filteredSettings.autoDeleteByDistanceIntervalHours, 10);
  if (isNaN(interval) || ![6, 12, 24, 48].includes(interval)) {
    return res.status(400).json({ error: 'autoDeleteByDistanceIntervalHours must be 6, 12, 24, or 48' });
  }
}

if ('autoDeleteByDistanceThresholdKm' in filteredSettings) {
  const threshold = parseFloat(filteredSettings.autoDeleteByDistanceThresholdKm);
  if (isNaN(threshold) || threshold <= 0 || threshold > 50000) {
    return res.status(400).json({ error: 'autoDeleteByDistanceThresholdKm must be between 0 and 50000' });
  }
}

if ('autoDeleteByDistanceLat' in filteredSettings) {
  const lat = parseFloat(filteredSettings.autoDeleteByDistanceLat);
  if (isNaN(lat) || lat < -90 || lat > 90) {
    return res.status(400).json({ error: 'autoDeleteByDistanceLat must be between -90 and 90' });
  }
}

if ('autoDeleteByDistanceLon' in filteredSettings) {
  const lon = parseFloat(filteredSettings.autoDeleteByDistanceLon);
  if (isNaN(lon) || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'autoDeleteByDistanceLon must be between -180 and 180' });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/server/constants/settings.ts src/server/routes/settingsRoutes.ts
git commit -m "feat: add auto-delete-by-distance settings keys and validation"
```

---

### Task 2b: DatabaseService Async Methods for Log Table

**Files:**
- Modify: `src/services/database.ts`

The spec calls for a Drizzle schema file and repository. However, examining the codebase, the `auto_traceroute_log` and `auto_key_repair_log` tables do NOT have dedicated schema files or repositories — their CRUD is done via raw SQL in `database.ts` directly (e.g., `getAutoTracerouteLogAsync`, `getKeyRepairLogAsync`). Follow this established pattern rather than creating new files that would be inconsistent with existing log tables.

- [ ] **Step 1: Add `getDistanceDeleteLogAsync` method**

In `src/services/database.ts`, add near the other log-fetching async methods (e.g., near `getAutoTracerouteLogAsync` or `getKeyRepairLogAsync`):

```typescript
/**
 * Get auto-delete-by-distance log entries
 */
async getDistanceDeleteLogAsync(limit: number = 10): Promise<any[]> {
  if (this.drizzleDbType === 'postgres') {
    const client = await this.getPostgresPool()!.connect();
    try {
      const result = await client.query(
        'SELECT * FROM auto_distance_delete_log ORDER BY timestamp DESC LIMIT $1',
        [limit]
      );
      return result.rows.map((e: any) => ({
        ...e,
        details: e.details ? JSON.parse(e.details) : [],
      }));
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const [rows] = await this.getMySQLPool()!.query(
      'SELECT * FROM auto_distance_delete_log ORDER BY timestamp DESC LIMIT ?',
      [limit]
    );
    return (rows as any[]).map((e: any) => ({
      ...e,
      details: e.details ? JSON.parse(e.details) : [],
    }));
  } else {
    const entries = this.db.prepare(
      'SELECT * FROM auto_distance_delete_log ORDER BY timestamp DESC LIMIT ?'
    ).all(limit);
    return (entries as any[]).map((e: any) => ({
      ...e,
      details: e.details ? JSON.parse(e.details) : [],
    }));
  }
}
```

- [ ] **Step 2: Add `addDistanceDeleteLogEntryAsync` method**

```typescript
/**
 * Add an entry to the auto-delete-by-distance log
 */
async addDistanceDeleteLogEntryAsync(entry: {
  timestamp: number;
  nodesDeleted: number;
  thresholdKm: number;
  details: string;
}): Promise<void> {
  const now = Date.now();
  if (this.drizzleDbType === 'postgres') {
    const client = await this.getPostgresPool()!.connect();
    try {
      await client.query(
        `INSERT INTO auto_distance_delete_log (timestamp, nodes_deleted, threshold_km, details, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [entry.timestamp, entry.nodesDeleted, entry.thresholdKm, entry.details, now]
      );
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    await this.getMySQLPool()!.query(
      `INSERT INTO auto_distance_delete_log (timestamp, nodes_deleted, threshold_km, details, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [entry.timestamp, entry.nodesDeleted, entry.thresholdKm, entry.details, now]
    );
  } else {
    this.db.prepare(
      `INSERT INTO auto_distance_delete_log (timestamp, nodes_deleted, threshold_km, details, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(entry.timestamp, entry.nodesDeleted, entry.thresholdKm, entry.details, now);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add async database methods for distance-delete log"
```

---

### Task 3: Backend Service

**Files:**
- Create: `src/server/services/autoDeleteByDistanceService.ts`

- [ ] **Step 1: Create the service**

Create `src/server/services/autoDeleteByDistanceService.ts`:

```typescript
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { calculateDistance } from '../../utils/distance.js';

interface DeletedNodeInfo {
  nodeId: string;
  nodeName: string;
  distanceKm: number;
}

class AutoDeleteByDistanceService {
  private checkInterval: NodeJS.Timeout | null = null;
  private lastRunAt: number | null = null;
  private isRunning = false;

  /**
   * Start the auto-delete-by-distance service
   */
  public start(intervalHours: number): void {
    this.stop();

    logger.info(`🗑️ Starting auto-delete-by-distance service (interval: ${intervalHours} hours)`);

    // Run initial check after 2 minutes
    setTimeout(() => {
      this.runDeleteCycle();
    }, 120_000);

    this.checkInterval = setInterval(() => {
      this.runDeleteCycle();
    }, intervalHours * 60 * 60 * 1000);
  }

  /**
   * Stop the service (does not abort in-progress runs)
   */
  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('⏹️ Auto-delete-by-distance service stopped');
    }
  }

  /**
   * Run now (manual trigger from API)
   */
  public async runNow(): Promise<{ deletedCount: number }> {
    return this.runDeleteCycle();
  }

  /**
   * Get service status
   */
  public getStatus(): { running: boolean; lastRunAt?: number } {
    return {
      running: this.checkInterval !== null,
      lastRunAt: this.lastRunAt ?? undefined,
    };
  }

  /**
   * Core deletion logic
   */
  private async runDeleteCycle(): Promise<{ deletedCount: number }> {
    if (this.isRunning) {
      logger.debug('⏭️ Auto-delete-by-distance: skipping, already running');
      return { deletedCount: 0 };
    }

    this.isRunning = true;
    const deletedNodes: DeletedNodeInfo[] = [];

    try {
      // Read settings
      const homeLat = parseFloat(databaseService.getSetting('autoDeleteByDistanceLat') || '');
      const homeLon = parseFloat(databaseService.getSetting('autoDeleteByDistanceLon') || '');
      const thresholdKm = parseFloat(databaseService.getSetting('autoDeleteByDistanceThresholdKm') || '100');

      if (isNaN(homeLat) || isNaN(homeLon)) {
        logger.debug('⏭️ Auto-delete-by-distance: no home coordinate configured, skipping');
        return { deletedCount: 0 };
      }

      // Get local node number to protect it
      const localNodeNumStr = databaseService.getSetting('localNodeNum');
      const localNodeNum = localNodeNumStr ? Number(localNodeNumStr) : null;

      // Get all nodes (must use async for PostgreSQL/MySQL)
      const allNodes = await databaseService.getAllNodesAsync();

      for (const node of allNodes) {
        // Protect local node
        if (localNodeNum != null && Number(node.nodeNum) === localNodeNum) {
          continue;
        }

        // Protect favorited nodes
        if (node.isFavorite) {
          continue;
        }

        // Skip nodes without position
        if (node.latitude == null || node.longitude == null) {
          continue;
        }

        // Calculate distance
        const distance = calculateDistance(homeLat, homeLon, node.latitude, node.longitude);

        if (distance > thresholdKm) {
          try {
            await databaseService.deleteNodeAsync(Number(node.nodeNum));
            deletedNodes.push({
              nodeId: node.nodeId || `!${Number(node.nodeNum).toString(16)}`,
              nodeName: node.longName || node.shortName || `Node ${node.nodeNum}`,
              distanceKm: Math.round(distance * 10) / 10,
            });
          } catch (error) {
            logger.error(`❌ Auto-delete-by-distance: failed to delete node ${node.nodeNum}:`, error);
          }
        }
      }

      // Log results
      const now = Date.now();
      this.lastRunAt = now;

      await this.logRunAsync(now, deletedNodes.length, thresholdKm, deletedNodes);

      if (deletedNodes.length > 0) {
        logger.info(`🗑️ Auto-delete-by-distance: deleted ${deletedNodes.length} node(s) beyond ${thresholdKm} km`);
      } else {
        logger.debug('✅ Auto-delete-by-distance: no nodes beyond threshold');
      }

      return { deletedCount: deletedNodes.length };
    } catch (error) {
      logger.error('❌ Auto-delete-by-distance: error during run:', error);
      return { deletedCount: 0 };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Log a run to the auto_distance_delete_log table via DatabaseService
   */
  private async logRunAsync(
    timestamp: number,
    nodesDeleted: number,
    thresholdKm: number,
    details: DeletedNodeInfo[]
  ): Promise<void> {
    try {
      await databaseService.addDistanceDeleteLogEntryAsync({
        timestamp,
        nodesDeleted,
        thresholdKm,
        details: JSON.stringify(details),
      });
    } catch (error) {
      logger.error('❌ Auto-delete-by-distance: failed to log run:', error);
    }
  }
}

export const autoDeleteByDistanceService = new AutoDeleteByDistanceService();
```

- [ ] **Step 2: Commit**

```bash
git add src/server/services/autoDeleteByDistanceService.ts
git commit -m "feat: add AutoDeleteByDistanceService"
```

---

### Task 4: API Routes and Service Wiring

**Files:**
- Modify: `src/server/server.ts` (import service, add routes, start/stop on settings change)
- Modify: `src/server/routes/settingsRoutes.ts` (add callback + trigger logic)

- [ ] **Step 1: Import service and add startup logic in server.ts**

In `src/server/server.ts`, add import near other service imports:

```typescript
import { autoDeleteByDistanceService } from './services/autoDeleteByDistanceService.js';
```

Near line 525 (where `inactiveNodeNotificationService.start()` is called), add startup logic:

```typescript
// Start auto-delete-by-distance service if enabled
const autoDeleteByDistanceEnabled = databaseService.getSetting('autoDeleteByDistanceEnabled');
if (autoDeleteByDistanceEnabled === 'true') {
  const intervalHours = parseInt(databaseService.getSetting('autoDeleteByDistanceIntervalHours') || '24', 10);
  autoDeleteByDistanceService.start(intervalHours);
}
```

- [ ] **Step 2: Add callbacks in setSettingsCallbacks**

In `src/server/server.ts`, in the `setSettingsCallbacks({...})` block (around line 805-819), add:

```typescript
restartAutoDeleteByDistanceService: (intervalHours: number) =>
  autoDeleteByDistanceService.start(intervalHours),
stopAutoDeleteByDistanceService: () => autoDeleteByDistanceService.stop(),
```

- [ ] **Step 3: Add callback type and trigger in settingsRoutes.ts**

In `src/server/routes/settingsRoutes.ts`, add to the `SettingsCallbacks` interface:

```typescript
restartAutoDeleteByDistanceService?: (intervalHours: number) => void;
stopAutoDeleteByDistanceService?: () => void;
```

In the POST handler's side-effect section (after the `inactiveNodeSettingsChanged` block, around line 600), add:

```typescript
const distanceDeleteSettings = [
  'autoDeleteByDistanceEnabled',
  'autoDeleteByDistanceIntervalHours',
  'autoDeleteByDistanceThresholdKm',
  'autoDeleteByDistanceLat',
  'autoDeleteByDistanceLon',
];
const distanceDeleteSettingsChanged = distanceDeleteSettings.some((key) => key in filteredSettings);
if (distanceDeleteSettingsChanged) {
  const enabled =
    filteredSettings.autoDeleteByDistanceEnabled === 'true' ||
    (filteredSettings.autoDeleteByDistanceEnabled === undefined &&
      databaseService.getSetting('autoDeleteByDistanceEnabled') === 'true');

  if (enabled) {
    const intervalHours = parseInt(
      filteredSettings.autoDeleteByDistanceIntervalHours ||
        databaseService.getSetting('autoDeleteByDistanceIntervalHours') ||
        '24',
      10
    );
    callbacks.restartAutoDeleteByDistanceService?.(intervalHours);
    logger.info(`✅ Auto-delete-by-distance service restarted (interval: ${intervalHours}h)`);
  } else {
    callbacks.stopAutoDeleteByDistanceService?.();
    logger.info('⏹️ Auto-delete-by-distance service stopped');
  }
}
```

- [ ] **Step 4: Add log and run-now API routes in server.ts**

In `src/server/server.ts`, near the other `/api/settings/` routes (around line 4722), add:

```typescript
// Auto-delete-by-distance log
apiRouter.get('/settings/distance-delete/log', requirePermission('settings', 'read'), async (_req, res) => {
  try {
    const entries = await databaseService.getDistanceDeleteLogAsync(10);
    res.json(entries);
  } catch (error) {
    logger.error('Error fetching distance-delete log:', error);
    res.status(500).json({ error: 'Failed to fetch log' });
  }
});

// Auto-delete-by-distance run now
apiRouter.post('/settings/distance-delete/run-now', requirePermission('settings', 'write'), async (_req, res) => {
  try {
    const result = await autoDeleteByDistanceService.runNow();
    res.json(result);
  } catch (error) {
    logger.error('Error running distance-delete:', error);
    res.status(500).json({ error: 'Failed to run distance delete' });
  }
});
```

- [ ] **Step 5: Commit**

```bash
git add src/server/server.ts src/server/routes/settingsRoutes.ts
git commit -m "feat: add distance-delete API routes and service wiring"
```

---

## Chunk 2: Frontend

### Task 5: AutomationContext State

**Files:**
- Modify: `src/contexts/AutomationContext.tsx`

- [ ] **Step 1: Add state to AutomationContextType interface**

In `src/contexts/AutomationContext.tsx`, add to the `AutomationContextType` interface (after the autoKeyManagement entries, around line 86):

```typescript
autoDeleteByDistanceEnabled: boolean;
setAutoDeleteByDistanceEnabled: React.Dispatch<React.SetStateAction<boolean>>;
autoDeleteByDistanceIntervalHours: number;
setAutoDeleteByDistanceIntervalHours: React.Dispatch<React.SetStateAction<number>>;
autoDeleteByDistanceThresholdKm: number;
setAutoDeleteByDistanceThresholdKm: React.Dispatch<React.SetStateAction<number>>;
autoDeleteByDistanceLat: number | null;
setAutoDeleteByDistanceLat: React.Dispatch<React.SetStateAction<number | null>>;
autoDeleteByDistanceLon: number | null;
setAutoDeleteByDistanceLon: React.Dispatch<React.SetStateAction<number | null>>;
```

- [ ] **Step 2: Add useState declarations**

In the `AutomationProvider` component (after the autoKeyManagement state declarations, around line 139), add:

```typescript
const [autoDeleteByDistanceEnabled, setAutoDeleteByDistanceEnabled] = useState<boolean>(false);
const [autoDeleteByDistanceIntervalHours, setAutoDeleteByDistanceIntervalHours] = useState<number>(24);
const [autoDeleteByDistanceThresholdKm, setAutoDeleteByDistanceThresholdKm] = useState<number>(100);
const [autoDeleteByDistanceLat, setAutoDeleteByDistanceLat] = useState<number | null>(null);
const [autoDeleteByDistanceLon, setAutoDeleteByDistanceLon] = useState<number | null>(null);
```

- [ ] **Step 3: Add to context value**

In the `AutomationContext.Provider` value object (around line 188, after the `autoKeyManagementImmediatePurge` entries), add:

```typescript
autoDeleteByDistanceEnabled, setAutoDeleteByDistanceEnabled,
autoDeleteByDistanceIntervalHours, setAutoDeleteByDistanceIntervalHours,
autoDeleteByDistanceThresholdKm, setAutoDeleteByDistanceThresholdKm,
autoDeleteByDistanceLat, setAutoDeleteByDistanceLat,
autoDeleteByDistanceLon, setAutoDeleteByDistanceLon,
```

- [ ] **Step 4: Commit**

```bash
git add src/contexts/AutomationContext.tsx
git commit -m "feat: add auto-delete-by-distance state to AutomationContext"
```

---

### Task 6: Translation Keys

**Files:**
- Modify: `public/locales/en.json`

- [ ] **Step 1: Add translation keys**

In `public/locales/en.json`, add under the `automation` section:

```json
"automation.distance_delete.title": "Auto Delete by Distance",
"automation.distance_delete.description": "Automatically delete nodes beyond a specified distance from a home coordinate. Useful for cleaning up distant nodes injected by airplane relays.",
"automation.distance_delete.enabled": "Enable Auto Delete by Distance",
"automation.distance_delete.home_coordinate": "Home Coordinate",
"automation.distance_delete.latitude": "Latitude",
"automation.distance_delete.longitude": "Longitude",
"automation.distance_delete.use_node_position": "Use Current Node Position",
"automation.distance_delete.threshold": "Distance Threshold",
"automation.distance_delete.interval": "Check Interval",
"automation.distance_delete.interval_hours": "{{count}} hours",
"automation.distance_delete.run_now": "Run Now",
"automation.distance_delete.running": "Running...",
"automation.distance_delete.run_result": "Deleted {{count}} node(s)",
"automation.distance_delete.activity_log": "Activity Log",
"automation.distance_delete.no_log_entries": "No runs yet",
"automation.distance_delete.nodes_deleted": "Nodes Deleted",
"automation.distance_delete.threshold_used": "Threshold",
"automation.distance_delete.timestamp": "Time",
"automation.distance_delete.no_home_coordinate": "Set a home coordinate to enable distance-based deletion",
"automation.distance_delete.protected_note": "Favorited nodes and the local node are always protected"
```

- [ ] **Step 2: Commit**

```bash
git add public/locales/en.json
git commit -m "feat: add translation keys for auto-delete-by-distance"
```

---

### Task 7: UI Component

**Files:**
- Create: `src/components/AutoDeleteByDistanceSection.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/AutoDeleteByDistanceSection.tsx`. Follow the `AutoKeyManagementSection` pattern:

```typescript
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSaveBar } from '../hooks/useSaveBar';
import { kmToMiles } from '../utils/distance';
import { useSettings } from '../contexts/SettingsContext';

interface AutoDeleteByDistanceSectionProps {
  enabled: boolean;
  intervalHours: number;
  thresholdKm: number;
  homeLat: number | null;
  homeLon: number | null;
  localNodeLat?: number;
  localNodeLon?: number;
  baseUrl: string;
  onEnabledChange: (enabled: boolean) => void;
  onIntervalChange: (hours: number) => void;
  onThresholdChange: (km: number) => void;
  onHomeLatChange: (lat: number | null) => void;
  onHomeLonChange: (lon: number | null) => void;
}

interface LogEntry {
  id: number;
  timestamp: number;
  nodes_deleted: number;
  threshold_km: number;
  details: Array<{ nodeId: string; nodeName: string; distanceKm: number }>;
}

const AutoDeleteByDistanceSection: React.FC<AutoDeleteByDistanceSectionProps> = ({
  enabled,
  intervalHours,
  thresholdKm,
  homeLat,
  homeLon,
  localNodeLat,
  localNodeLon,
  baseUrl,
  onEnabledChange,
  onIntervalChange,
  onThresholdChange,
  onHomeLatChange,
  onHomeLonChange,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { distanceUnit } = useSettings();

  // Local state for unsaved changes
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localIntervalHours, setLocalIntervalHours] = useState(intervalHours);
  const [localThresholdKm, setLocalThresholdKm] = useState(thresholdKm);
  const [localHomeLat, setLocalHomeLat] = useState<string>(homeLat != null ? String(homeLat) : '');
  const [localHomeLon, setLocalHomeLon] = useState<string>(homeLon != null ? String(homeLon) : '');

  // Activity log
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isMiles = distanceUnit === 'miles';

  // Convert km to display unit
  const toDisplayUnit = useCallback((km: number) => isMiles ? kmToMiles(km) : km, [isMiles]);
  const fromDisplayUnit = useCallback((val: number) => isMiles ? val / 0.621371 : val, [isMiles]);

  // Threshold in display unit
  const displayThreshold = Math.round(toDisplayUnit(localThresholdKm) * 10) / 10;

  // Sync local state when props change
  useEffect(() => { setLocalEnabled(enabled); }, [enabled]);
  useEffect(() => { setLocalIntervalHours(intervalHours); }, [intervalHours]);
  useEffect(() => { setLocalThresholdKm(thresholdKm); }, [thresholdKm]);
  useEffect(() => { setLocalHomeLat(homeLat != null ? String(homeLat) : ''); }, [homeLat]);
  useEffect(() => { setLocalHomeLon(homeLon != null ? String(homeLon) : ''); }, [homeLon]);

  // Detect unsaved changes
  const hasChanges =
    localEnabled !== enabled ||
    localIntervalHours !== intervalHours ||
    localThresholdKm !== thresholdKm ||
    (localHomeLat !== (homeLat != null ? String(homeLat) : '')) ||
    (localHomeLon !== (homeLon != null ? String(homeLon) : ''));

  // Fetch log entries
  const fetchLog = useCallback(async () => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/distance-delete/log`);
      if (response.ok) {
        const data = await response.json();
        setLogEntries(data);
      }
    } catch (error) {
      // Silently fail — log is not critical
    }
  }, [csrfFetch, baseUrl]);

  useEffect(() => {
    fetchLog();
    pollRef.current = setInterval(fetchLog, 30_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchLog]);

  // Save handler
  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const settings: Record<string, string> = {
        autoDeleteByDistanceEnabled: String(localEnabled),
        autoDeleteByDistanceIntervalHours: String(localIntervalHours),
        autoDeleteByDistanceThresholdKm: String(localThresholdKm),
      };

      const lat = parseFloat(localHomeLat);
      const lon = parseFloat(localHomeLon);
      if (!isNaN(lat)) settings.autoDeleteByDistanceLat = String(lat);
      if (!isNaN(lon)) settings.autoDeleteByDistanceLon = String(lon);

      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });

      if (response.ok) {
        onEnabledChange(localEnabled);
        onIntervalChange(localIntervalHours);
        onThresholdChange(localThresholdKm);
        onHomeLatChange(!isNaN(lat) ? lat : null);
        onHomeLonChange(!isNaN(lon) ? lon : null);
        showToast(t('automation.settings_saved', 'Settings saved'), 'success');
      } else {
        const err = await response.json();
        showToast(err.error || t('automation.settings_save_failed', 'Failed to save'), 'error');
      }
    } catch {
      showToast(t('automation.settings_save_failed', 'Failed to save'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [
    localEnabled, localIntervalHours, localThresholdKm, localHomeLat, localHomeLon,
    csrfFetch, baseUrl, onEnabledChange, onIntervalChange, onThresholdChange,
    onHomeLatChange, onHomeLonChange, showToast, t,
  ]);

  const resetChanges = useCallback(() => {
    setLocalEnabled(enabled);
    setLocalIntervalHours(intervalHours);
    setLocalThresholdKm(thresholdKm);
    setLocalHomeLat(homeLat != null ? String(homeLat) : '');
    setLocalHomeLon(homeLon != null ? String(homeLon) : '');
  }, [enabled, intervalHours, thresholdKm, homeLat, homeLon]);

  useSaveBar({
    id: 'auto-delete-by-distance',
    sectionName: t('automation.distance_delete.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
  });

  // Run Now handler
  const handleRunNow = useCallback(async () => {
    setIsRunning(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/distance-delete/run-now`, {
        method: 'POST',
      });
      if (response.ok) {
        const result = await response.json();
        showToast(
          t('automation.distance_delete.run_result', { count: result.deletedCount }),
          result.deletedCount > 0 ? 'warning' : 'success'
        );
        fetchLog(); // Refresh log
      } else {
        showToast(t('automation.settings_save_failed'), 'error');
      }
    } catch {
      showToast(t('automation.settings_save_failed'), 'error');
    } finally {
      setIsRunning(false);
    }
  }, [csrfFetch, baseUrl, showToast, t, fetchLog]);

  // Use Current Node Position
  const handleUseNodePosition = useCallback(() => {
    if (localNodeLat != null && localNodeLon != null) {
      setLocalHomeLat(String(localNodeLat));
      setLocalHomeLon(String(localNodeLon));
    }
  }, [localNodeLat, localNodeLon]);

  const unitLabel = isMiles ? 'mi' : 'km';

  return (
    <div className="settings-section">
      <h3>{t('automation.distance_delete.title')}</h3>
      <p className="text-muted">{t('automation.distance_delete.description')}</p>
      <p className="text-muted small">{t('automation.distance_delete.protected_note')}</p>

      {/* Enable toggle */}
      <div className="form-group">
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => setLocalEnabled(e.target.checked)}
          />
          {t('automation.distance_delete.enabled')}
        </label>
      </div>

      {/* Home coordinate */}
      <div className="form-group">
        <label>{t('automation.distance_delete.home_coordinate')}</label>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="number"
            step="any"
            placeholder={t('automation.distance_delete.latitude')}
            value={localHomeLat}
            onChange={(e) => setLocalHomeLat(e.target.value)}
            style={{ width: '140px' }}
          />
          <input
            type="number"
            step="any"
            placeholder={t('automation.distance_delete.longitude')}
            value={localHomeLon}
            onChange={(e) => setLocalHomeLon(e.target.value)}
            style={{ width: '140px' }}
          />
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={handleUseNodePosition}
            disabled={localNodeLat == null || localNodeLon == null}
          >
            {t('automation.distance_delete.use_node_position')}
          </button>
        </div>
      </div>

      {/* Distance threshold */}
      <div className="form-group">
        <label>{t('automation.distance_delete.threshold')} ({unitLabel})</label>
        <input
          type="number"
          min="1"
          step="1"
          value={Math.round(displayThreshold)}
          onChange={(e) => {
            const val = parseInt(e.target.value, 10);
            if (!isNaN(val) && val > 0) {
              setLocalThresholdKm(Math.round(fromDisplayUnit(val) * 10) / 10);
            }
          }}
          style={{ width: '120px' }}
        />
      </div>

      {/* Interval */}
      <div className="form-group">
        <label>{t('automation.distance_delete.interval')}</label>
        <select
          value={localIntervalHours}
          onChange={(e) => setLocalIntervalHours(parseInt(e.target.value, 10))}
        >
          {[6, 12, 24, 48].map((h) => (
            <option key={h} value={h}>
              {t('automation.distance_delete.interval_hours', { count: h })}
            </option>
          ))}
        </select>
      </div>

      {/* Run Now */}
      <div className="form-group">
        <button
          type="button"
          className="btn btn-warning"
          onClick={handleRunNow}
          disabled={isRunning || homeLat == null || homeLon == null}
        >
          {isRunning
            ? t('automation.distance_delete.running')
            : t('automation.distance_delete.run_now')}
        </button>
        {homeLat == null && (
          <span className="text-muted small" style={{ marginLeft: '8px' }}>
            {t('automation.distance_delete.no_home_coordinate')}
          </span>
        )}
      </div>

      {/* Activity Log */}
      <h4>{t('automation.distance_delete.activity_log')}</h4>
      {logEntries.length === 0 ? (
        <p className="text-muted">{t('automation.distance_delete.no_log_entries')}</p>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>{t('automation.distance_delete.timestamp', 'Time')}</th>
                <th>{t('automation.distance_delete.nodes_deleted')}</th>
                <th>{t('automation.distance_delete.threshold_used')} ({unitLabel})</th>
              </tr>
            </thead>
            <tbody>
              {logEntries.map((entry) => (
                <tr key={entry.id}>
                  <td>{new Date(entry.timestamp).toLocaleString()}</td>
                  <td>{entry.nodes_deleted}</td>
                  <td>{Math.round(toDisplayUnit(entry.threshold_km))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default AutoDeleteByDistanceSection;
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AutoDeleteByDistanceSection.tsx
git commit -m "feat: add AutoDeleteByDistanceSection UI component"
```

---

### Task 8: Mount in App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add import**

Near the other automation section imports (around line 25-35), add:

```typescript
import AutoDeleteByDistanceSection from './components/AutoDeleteByDistanceSection';
```

- [ ] **Step 2: Add state destructuring from useAutomation()**

In the `useAutomation()` destructuring block (around line 557-569), add:

```typescript
autoDeleteByDistanceEnabled, setAutoDeleteByDistanceEnabled,
autoDeleteByDistanceIntervalHours, setAutoDeleteByDistanceIntervalHours,
autoDeleteByDistanceThresholdKm, setAutoDeleteByDistanceThresholdKm,
autoDeleteByDistanceLat, setAutoDeleteByDistanceLat,
autoDeleteByDistanceLon, setAutoDeleteByDistanceLon,
```

- [ ] **Step 3: Add settings loading from backend**

In the settings loading section (where `autoKeyManagementEnabled` is loaded, around line 1104-1118), add:

```typescript
// Auto delete by distance settings
if (settings.autoDeleteByDistanceEnabled !== undefined) {
  setAutoDeleteByDistanceEnabled(settings.autoDeleteByDistanceEnabled === 'true');
}
if (settings.autoDeleteByDistanceIntervalHours !== undefined) {
  setAutoDeleteByDistanceIntervalHours(parseInt(settings.autoDeleteByDistanceIntervalHours) || 24);
}
if (settings.autoDeleteByDistanceThresholdKm !== undefined) {
  setAutoDeleteByDistanceThresholdKm(parseFloat(settings.autoDeleteByDistanceThresholdKm) || 100);
}
if (settings.autoDeleteByDistanceLat !== undefined) {
  setAutoDeleteByDistanceLat(settings.autoDeleteByDistanceLat ? parseFloat(settings.autoDeleteByDistanceLat) : null);
}
if (settings.autoDeleteByDistanceLon !== undefined) {
  setAutoDeleteByDistanceLon(settings.autoDeleteByDistanceLon ? parseFloat(settings.autoDeleteByDistanceLon) : null);
}
```

- [ ] **Step 4: Add SectionNav entry**

In the `SectionNav` items array for the automation tab (around line 4822-4837), add before `'ignored-nodes'`:

```typescript
{ id: 'auto-delete-by-distance', label: t('automation.distance_delete.title', 'Auto Delete by Distance') },
```

- [ ] **Step 5: Add component rendering**

In the automation tab content area (after the geofence-triggers div, before the ignored-nodes div, around line 4990), add:

The local node's position is accessed via the existing pattern in App.tsx (line ~732):
```typescript
const localNode = currentNodeId ? nodes.find(n => n.user?.id === currentNodeId) : null;
```

Use this to pass position props:

```tsx
<div id="auto-delete-by-distance">
  <AutoDeleteByDistanceSection
    enabled={autoDeleteByDistanceEnabled}
    intervalHours={autoDeleteByDistanceIntervalHours}
    thresholdKm={autoDeleteByDistanceThresholdKm}
    homeLat={autoDeleteByDistanceLat}
    homeLon={autoDeleteByDistanceLon}
    localNodeLat={(() => { const ln = currentNodeId ? nodes.find(n => n.user?.id === currentNodeId) : null; return ln?.position?.latitude; })()}
    localNodeLon={(() => { const ln = currentNodeId ? nodes.find(n => n.user?.id === currentNodeId) : null; return ln?.position?.longitude; })()}
    baseUrl={baseUrl}
    onEnabledChange={setAutoDeleteByDistanceEnabled}
    onIntervalChange={setAutoDeleteByDistanceIntervalHours}
    onThresholdChange={setAutoDeleteByDistanceThresholdKm}
    onHomeLatChange={setAutoDeleteByDistanceLat}
    onHomeLonChange={setAutoDeleteByDistanceLon}
  />
</div>
```

Alternatively, if `connectedNodeName` useMemo is already in scope (line ~730), extract the local node lookup into a `useMemo` that returns position data, and pass it to the component. The implementer should choose whichever pattern is cleanest — the key requirement is that `currentNodeId` and `nodes` are already in scope in the automation tab render section.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat: mount AutoDeleteByDistanceSection in Automation tab"
```

---

## Chunk 3: Testing and Verification

### Task 9: Build and Test

- [ ] **Step 1: Run TypeScript compilation**

```bash
npx tsc --noEmit
```

Fix any type errors.

- [ ] **Step 2: Run existing test suite**

```bash
npx vitest run
```

Ensure no regressions.

- [ ] **Step 3: Run system tests**

Shut down all containers first, then:

```bash
./tests/system-tests.sh
```

Post the output report.

- [ ] **Step 4: Build and deploy on SQLite**

```bash
docker compose -f docker-compose.dev.yml --profile sqlite build --no-cache meshmonitor-sqlite
docker compose -f docker-compose.dev.yml --profile sqlite up -d
```

Check logs for clean startup and migration 086 running.

- [ ] **Step 5: Build and deploy on PostgreSQL**

```bash
docker compose -f docker-compose.dev.yml --profile sqlite down
docker compose -f docker-compose.dev.yml --profile postgres build --no-cache meshmonitor-postgres
docker compose -f docker-compose.dev.yml --profile postgres up -d
```

Check logs for migration 086.

- [ ] **Step 6: Build and deploy on MySQL**

```bash
docker compose -f docker-compose.dev.yml --profile postgres down
docker compose -f docker-compose.dev.yml --profile mysql build --no-cache meshmonitor-mysql
docker compose -f docker-compose.dev.yml --profile mysql up -d
```

Check logs for migration 086.

- [ ] **Step 7: Manual UI verification**

1. Navigate to Automation tab
2. Find "Auto Delete by Distance" section
3. Enable the toggle
4. Set home coordinate (use "Use Current Node Position" button)
5. Set a distance threshold
6. Click "Run Now" — verify toast shows result
7. Check activity log populates
8. Save settings, refresh page — verify settings persist

- [ ] **Step 8: Final commit if any fixes**

```bash
git add -A
git commit -m "fix: address testing issues for auto-delete-by-distance"
```
