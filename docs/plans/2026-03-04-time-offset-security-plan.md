# Time Offset Security Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Flag nodes whose clock is more than a configurable threshold off from the server's time, displayed in a new "Time Offset" section on the Security tab.

**Architecture:** Add `isTimeOffsetIssue` and `timeOffsetSeconds` columns to the nodes table via migration 081. During the 24-hour security scan, query the most recent telemetry record per node that has a `packetTimestamp` (the node's self-reported time). Compare `timestamp - packetTimestamp` to detect clock skew. Display flagged nodes in the Security tab between the Excessive Packets and Top Broadcasters sections.

**Tech Stack:** TypeScript, Express, Drizzle ORM (SQLite/PostgreSQL/MySQL), React, i18next

**Note on time source:** The existing `timeOffset` telemetry only measures the gateway node's clock drift. For per-node detection, we use the `packetTimestamp` field stored in each node's telemetry records (from `position.time` / `telemetry.time`), compared to the server `timestamp` of the same record.

---

### Task 1: Create Migration 081 — Add Time Offset Columns

**Files:**
- Create: `src/server/migrations/081_add_time_offset_columns.ts`

**Step 1: Create the migration file**

Follow the exact pattern from `src/server/migrations/061_add_spam_detection_columns.ts`. Add two columns to the `nodes` table:
- `isTimeOffsetIssue` — BOOLEAN (SQLite: INTEGER DEFAULT 0, PG: BOOLEAN DEFAULT false, MySQL: BOOLEAN DEFAULT false)
- `timeOffsetSeconds` — INTEGER (nullable, stores the measured offset in seconds)

```typescript
/**
 * Migration 081: Add time offset detection columns to nodes table
 *
 * Adds columns to track nodes with clocks significantly out of sync:
 * - isTimeOffsetIssue: boolean flag for nodes exceeding time offset threshold
 * - timeOffsetSeconds: the measured clock offset in seconds (positive = node behind, negative = ahead)
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 081: Add time offset detection columns to nodes...');

    const tableInfo = db.prepare('PRAGMA table_info(nodes)').all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;

    const existingColumns = new Set(tableInfo.map(col => col.name));

    if (!existingColumns.has('isTimeOffsetIssue')) {
      db.exec('ALTER TABLE nodes ADD COLUMN isTimeOffsetIssue INTEGER DEFAULT 0');
      logger.debug('✅ Added isTimeOffsetIssue column');
    }

    if (!existingColumns.has('timeOffsetSeconds')) {
      db.exec('ALTER TABLE nodes ADD COLUMN timeOffsetSeconds INTEGER');
      logger.debug('✅ Added timeOffsetSeconds column');
    }

    logger.debug('✅ Migration 081 complete');
  },

  down: (_db: Database): void => {
    logger.debug('Reverting migration 081: Cannot remove columns in SQLite, skipping');
  }
};

export async function runMigration081Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 081 (PostgreSQL): Add time offset detection columns to nodes...');

  const result = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'nodes' AND column_name IN ('isTimeOffsetIssue', 'timeOffsetSeconds')
  `);

  const existingColumns = new Set(result.rows.map((r: { column_name: string }) => r.column_name));

  if (!existingColumns.has('isTimeOffsetIssue')) {
    await client.query('ALTER TABLE nodes ADD COLUMN "isTimeOffsetIssue" BOOLEAN DEFAULT false');
    logger.debug('✅ Added isTimeOffsetIssue column (PostgreSQL)');
  }

  if (!existingColumns.has('timeOffsetSeconds')) {
    await client.query('ALTER TABLE nodes ADD COLUMN "timeOffsetSeconds" INTEGER');
    logger.debug('✅ Added timeOffsetSeconds column (PostgreSQL)');
  }

  logger.debug('✅ Migration 081 complete (PostgreSQL)');
}

export async function runMigration081Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 081 (MySQL): Add time offset detection columns to nodes...');

  const [rows] = await pool.query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nodes'
      AND COLUMN_NAME IN ('isTimeOffsetIssue', 'timeOffsetSeconds')
  `) as any;

  const existingColumns = new Set(rows.map((r: { COLUMN_NAME: string }) => r.COLUMN_NAME));

  if (!existingColumns.has('isTimeOffsetIssue')) {
    await pool.query('ALTER TABLE nodes ADD COLUMN isTimeOffsetIssue BOOLEAN DEFAULT false');
    logger.debug('✅ Added isTimeOffsetIssue column (MySQL)');
  }

  if (!existingColumns.has('timeOffsetSeconds')) {
    await pool.query('ALTER TABLE nodes ADD COLUMN timeOffsetSeconds INT');
    logger.debug('✅ Added timeOffsetSeconds column (MySQL)');
  }

  logger.debug('✅ Migration 081 complete (MySQL)');
}
```

**Step 2: Register migration in database.ts**

Add import at line 89 (after the migration 080 import):
```typescript
import { migration as addTimeOffsetColumnsMigration, runMigration081Postgres, runMigration081Mysql } from '../server/migrations/081_add_time_offset_columns.js';
```

Register SQLite migration in `initializeDatabase()` — find the last migration block (migration 080 around line 2557) and add after it:
```typescript
    // Run migration 081: Add time offset detection columns to nodes
    try {
      const migrationKey = 'migration_081_time_offset_columns';
      if (this.getSetting(migrationKey)) {
        return;
      }
      logger.debug('Running migration 081: Add time offset detection columns...');
      addTimeOffsetColumnsMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('Add time offset columns migration completed successfully');
    } catch (error) {
      logger.error('Error running migration 081:', error);
    }
```

Register PostgreSQL migration (after `runMigration080Postgres(client)` call around line 11285):
```typescript
      // Run migration 081: Add time offset detection columns
      await runMigration081Postgres(client);
```

Register MySQL migration (after `runMigration080Mysql(pool)` call around line 11437):
```typescript
      // Run migration 081: Add time offset detection columns
      await runMigration081Mysql(pool);
```

**Step 3: Update Drizzle schema**

In `src/db/schema/nodes.ts`, add after the spam detection columns (after `packetRateLastChecked`) for all three schemas:

SQLite (after line ~49):
```typescript
  // Time offset detection
  isTimeOffsetIssue: integer('isTimeOffsetIssue', { mode: 'boolean' }).default(false),
  timeOffsetSeconds: integer('timeOffsetSeconds'),
```

PostgreSQL (after line ~115):
```typescript
  // Time offset detection
  isTimeOffsetIssue: pgBoolean('isTimeOffsetIssue').default(false),
  timeOffsetSeconds: pgInteger('timeOffsetSeconds'),
```

MySQL (after line ~180):
```typescript
  // Time offset detection
  isTimeOffsetIssue: myBoolean('isTimeOffsetIssue').default(false),
  timeOffsetSeconds: myInt('timeOffsetSeconds'),
```

Also add to the Postgres and MySQL create scripts:
- `src/db/schema/postgres-create.ts`: Add `"isTimeOffsetIssue" BOOLEAN DEFAULT false,` and `"timeOffsetSeconds" INTEGER,` to the nodes CREATE TABLE
- `src/db/schema/mysql-create.ts`: Add `isTimeOffsetIssue BOOLEAN DEFAULT false,` and `timeOffsetSeconds INT,` to the nodes CREATE TABLE

**Step 4: Commit**

```bash
git add src/server/migrations/081_add_time_offset_columns.ts src/services/database.ts src/db/schema/nodes.ts src/db/schema/postgres-create.ts src/db/schema/mysql-create.ts
git commit -m "feat: add migration 081 for time offset detection columns"
```

---

### Task 2: Add Database Service Methods

**Files:**
- Modify: `src/services/database.ts`

**Step 1: Add `updateNodeTimeOffsetFlags` method**

Add after the `updateNodeSpamFlagsAsync` method (around line 4087). Follow the exact same pattern as `updateNodeSpamFlags`/`updateNodeSpamFlagsAsync`:

```typescript
  /**
   * Update the time offset detection flags for a node
   */
  updateNodeTimeOffsetFlags(nodeNum: number, isTimeOffsetIssue: boolean, timeOffsetSeconds: number | null): void {
    const now = Date.now();

    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(nodeNum);
      if (cachedNode) {
        (cachedNode as any).isTimeOffsetIssue = isTimeOffsetIssue;
        (cachedNode as any).timeOffsetSeconds = timeOffsetSeconds;
        cachedNode.updatedAt = now;
      }

      // Fire-and-forget database update
      this.updateNodeTimeOffsetFlagsAsync(nodeNum, isTimeOffsetIssue, timeOffsetSeconds, now).catch(err => {
        logger.error(`Failed to update node time offset flags in database:`, err);
      });
      return;
    }

    // SQLite: synchronous update
    const stmt = this.db.prepare(`
      UPDATE nodes
      SET isTimeOffsetIssue = ?,
          timeOffsetSeconds = ?,
          updatedAt = ?
      WHERE nodeNum = ?
    `);
    stmt.run(isTimeOffsetIssue ? 1 : 0, timeOffsetSeconds, now, nodeNum);
  }

  /**
   * Update the time offset detection flags for a node (async)
   */
  async updateNodeTimeOffsetFlagsAsync(nodeNum: number, isTimeOffsetIssue: boolean, timeOffsetSeconds: number | null, updatedAt: number): Promise<void> {
    if (this.drizzleDbType === 'postgres' && this.postgresPool) {
      await this.postgresPool.query(`
        UPDATE nodes
        SET "isTimeOffsetIssue" = $1,
            "timeOffsetSeconds" = $2,
            "updatedAt" = $3
        WHERE "nodeNum" = $4
      `, [isTimeOffsetIssue, timeOffsetSeconds, updatedAt, nodeNum]);
      return;
    }

    if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
      await this.mysqlPool.query(`
        UPDATE nodes
        SET isTimeOffsetIssue = ?,
            timeOffsetSeconds = ?,
            updatedAt = ?
        WHERE nodeNum = ?
      `, [isTimeOffsetIssue, timeOffsetSeconds, updatedAt, nodeNum]);
      return;
    }
  }
```

**Step 2: Add `getNodesWithTimeOffsetIssues` method**

Add after the `getNodesWithExcessivePacketsAsync` method (around line 4119). Follow the same pattern:

```typescript
  /**
   * Get all nodes with time offset issues (for security page)
   */
  getNodesWithTimeOffsetIssues(): DbNode[] {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const result: DbNode[] = [];
      for (const node of this.nodesCache.values()) {
        if ((node as any).isTimeOffsetIssue) {
          result.push(node);
        }
      }
      return result;
    }

    const stmt = this.db.prepare(`
      SELECT * FROM nodes WHERE isTimeOffsetIssue = 1
    `);
    return stmt.all() as DbNode[];
  }

  /**
   * Get all nodes with time offset issues (async)
   */
  async getNodesWithTimeOffsetIssuesAsync(): Promise<DbNode[]> {
    return this.getNodesWithTimeOffsetIssues();
  }
```

**Step 3: Add `getLatestPacketTimestampsPerNodeAsync` method**

This new query gets the most recent telemetry record with a non-null `packetTimestamp` for each node. Add near the other telemetry query methods:

```typescript
  /**
   * Get the most recent packetTimestamp per node for time offset detection.
   * Returns nodeNum, server timestamp, and the node's self-reported packetTimestamp.
   */
  async getLatestPacketTimestampsPerNodeAsync(): Promise<Array<{ nodeNum: number; timestamp: number; packetTimestamp: number }>> {
    if (this.drizzleDbType === 'postgres' && this.postgresPool) {
      const result = await this.postgresPool.query(`
        SELECT DISTINCT ON ("nodeNum") "nodeNum", "timestamp", "packetTimestamp"
        FROM telemetry
        WHERE "packetTimestamp" IS NOT NULL AND "packetTimestamp" > 0
        ORDER BY "nodeNum", "timestamp" DESC
      `);
      return result.rows.map((r: any) => ({
        nodeNum: Number(r.nodeNum),
        timestamp: Number(r.timestamp),
        packetTimestamp: Number(r.packetTimestamp)
      }));
    }

    if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
      const [rows] = await this.mysqlPool.query(`
        SELECT t.nodeNum, t.timestamp, t.packetTimestamp
        FROM telemetry t
        INNER JOIN (
          SELECT nodeNum, MAX(timestamp) as maxTs
          FROM telemetry
          WHERE packetTimestamp IS NOT NULL AND packetTimestamp > 0
          GROUP BY nodeNum
        ) latest ON t.nodeNum = latest.nodeNum AND t.timestamp = latest.maxTs
        WHERE t.packetTimestamp IS NOT NULL
      `) as any;
      return (rows as any[]).map((r: any) => ({
        nodeNum: Number(r.nodeNum),
        timestamp: Number(r.timestamp),
        packetTimestamp: Number(r.packetTimestamp)
      }));
    }

    // SQLite
    const stmt = this.db.prepare(`
      SELECT t.nodeNum, t.timestamp, t.packetTimestamp
      FROM telemetry t
      INNER JOIN (
        SELECT nodeNum, MAX(timestamp) as maxTs
        FROM telemetry
        WHERE packetTimestamp IS NOT NULL AND packetTimestamp > 0
        GROUP BY nodeNum
      ) latest ON t.nodeNum = latest.nodeNum AND t.timestamp = latest.maxTs
      WHERE t.packetTimestamp IS NOT NULL
    `);
    return (stmt.all() as any[]).map((r: any) => ({
      nodeNum: Number(r.nodeNum),
      timestamp: Number(r.timestamp),
      packetTimestamp: Number(r.packetTimestamp)
    }));
  }
```

**Step 4: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add database methods for time offset detection"
```

---

### Task 3: Add Time Offset Detection to Security Scanner

**Files:**
- Modify: `src/server/services/duplicateKeySchedulerService.ts`

**Step 1: Add threshold constant and env var**

At the top of the file (after existing imports/constants around line 12), add:

```typescript
const TIME_OFFSET_THRESHOLD_MINUTES = parseInt(process.env.TIME_OFFSET_THRESHOLD_MINUTES || '30', 10);
const TIME_OFFSET_THRESHOLD_MS = TIME_OFFSET_THRESHOLD_MINUTES * 60 * 1000; // Convert to milliseconds (timestamps in telemetry are ms)
```

**Step 2: Add `runTimeOffsetDetection` method**

Add a new private method after `runSpamDetection()` (after line 301). Follow the same pattern:

```typescript
  /**
   * Detect nodes with significant clock offset.
   * Compares the node's self-reported packetTimestamp against the server's timestamp
   * from the most recent telemetry record.
   */
  private async runTimeOffsetDetection(): Promise<void> {
    try {
      logger.info('🔐 Running time offset detection...');

      const latestTimestamps = await databaseService.getLatestPacketTimestampsPerNodeAsync();

      if (latestTimestamps.length === 0) {
        logger.info('ℹ️  No packet timestamp data available for time offset detection');
        return;
      }

      const allNodes = databaseService.getAllNodes();
      const nodesWithTimestamps = new Set(latestTimestamps.map(t => t.nodeNum));

      let flaggedCount = 0;
      let clearedCount = 0;

      for (const { nodeNum, timestamp, packetTimestamp } of latestTimestamps) {
        const node = databaseService.getNode(nodeNum);
        if (!node) continue;

        // Both timestamp and packetTimestamp are in milliseconds
        const offsetMs = timestamp - packetTimestamp;
        const offsetSeconds = Math.round(offsetMs / 1000);
        const isOffsetExcessive = Math.abs(offsetMs) > TIME_OFFSET_THRESHOLD_MS;
        const wasOffsetIssue = (node as any).isTimeOffsetIssue;

        if (isOffsetExcessive && !wasOffsetIssue) {
          databaseService.updateNodeTimeOffsetFlags(nodeNum, true, offsetSeconds);
          flaggedCount++;
          logger.warn(`🕐 Time offset detected: Node ${nodeNum} (${node.shortName || 'Unknown'}) offset ${offsetSeconds}s (threshold: ${TIME_OFFSET_THRESHOLD_MINUTES}min)`);
        } else if (!isOffsetExcessive && wasOffsetIssue) {
          databaseService.updateNodeTimeOffsetFlags(nodeNum, false, offsetSeconds);
          clearedCount++;
          logger.info(`✅ Time offset cleared: Node ${nodeNum} (${node.shortName || 'Unknown'}) now at ${offsetSeconds}s`);
        } else if (isOffsetExcessive) {
          // Still has offset, update the value
          databaseService.updateNodeTimeOffsetFlags(nodeNum, true, offsetSeconds);
        } else {
          // No offset issue, update the value
          databaseService.updateNodeTimeOffsetFlags(nodeNum, false, offsetSeconds);
        }
      }

      // Clear flags from nodes with no recent timestamp data
      for (const node of allNodes) {
        if ((node as any).isTimeOffsetIssue && !nodesWithTimestamps.has(node.nodeNum)) {
          databaseService.updateNodeTimeOffsetFlags(node.nodeNum, false, null);
          clearedCount++;
          logger.info(`✅ Time offset cleared: Node ${node.nodeNum} (${node.shortName || 'Unknown'}) - no timestamp data`);
        }
      }

      if (flaggedCount > 0) {
        logger.info(`🕐 Time offset detection complete: ${flaggedCount} nodes flagged`);
      } else {
        logger.info(`✅ Time offset detection complete: No nodes exceeding ${TIME_OFFSET_THRESHOLD_MINUTES} minute threshold`);
      }

      if (clearedCount > 0) {
        logger.info(`✅ Cleared time offset flags from ${clearedCount} nodes`);
      }
    } catch (error) {
      logger.error('Error during time offset detection:', error);
    }
  }
```

**Step 3: Call `runTimeOffsetDetection` from `runScan`**

In the `runScan()` method, there are two places where `await this.runSpamDetection()` is called (lines ~155 and ~200). Add `await this.runTimeOffsetDetection();` immediately after each call:

After `await this.runSpamDetection();` (around line 155):
```typescript
      // Run time offset detection
      await this.runTimeOffsetDetection();
```

After `await this.runSpamDetection();` (around line 200):
```typescript
      // Run time offset detection
      await this.runTimeOffsetDetection();
```

**Step 4: Commit**

```bash
git add src/server/services/duplicateKeySchedulerService.ts
git commit -m "feat: add time offset detection to security scanner"
```

---

### Task 4: Update Security Routes

**Files:**
- Modify: `src/server/routes/securityRoutes.ts`

**Step 1: Update `/api/security/issues` endpoint**

In the `GET /issues` handler (starting line 19), add time offset nodes to the combined map. After the `nodesWithExcessivePackets` loop (after line 67), add:

```typescript
    // Add time offset nodes
    const nodesWithTimeOffset = await databaseService.getNodesWithTimeOffsetIssuesAsync();

    for (const node of nodesWithTimeOffset) {
      if (!allIssueNodes.has(node.nodeNum)) {
        allIssueNodes.set(node.nodeNum, {
          nodeNum: node.nodeNum,
          shortName: node.shortName || 'Unknown',
          longName: node.longName || 'Unknown',
          lastHeard: node.lastHeard,
          keyIsLowEntropy: node.keyIsLowEntropy || false,
          duplicateKeyDetected: node.duplicateKeyDetected || false,
          keySecurityIssueDetails: node.keySecurityIssueDetails,
          publicKey: node.publicKey,
          hwModel: node.hwModel,
          isExcessivePackets: (node as any).isExcessivePackets || false,
          packetRatePerHour: (node as any).packetRatePerHour || null,
          packetRateLastChecked: (node as any).packetRateLastChecked || null,
          isTimeOffsetIssue: (node as any).isTimeOffsetIssue || false,
          timeOffsetSeconds: (node as any).timeOffsetSeconds || null
        });
      } else {
        const existing = allIssueNodes.get(node.nodeNum)!;
        existing.isTimeOffsetIssue = (node as any).isTimeOffsetIssue || false;
        existing.timeOffsetSeconds = (node as any).timeOffsetSeconds || null;
      }
    }
```

Also update the existing node objects in the `nodesWithKeyIssues` and `nodesWithExcessivePackets` loops to include time offset fields:
```typescript
          isTimeOffsetIssue: (node as any).isTimeOffsetIssue || false,
          timeOffsetSeconds: (node as any).timeOffsetSeconds || null
```

Update the categorization (after line 74):
```typescript
    const timeOffsetNodes = nodesWithIssues.filter(node => node.isTimeOffsetIssue);
```

Update the response JSON (after line 83):
```typescript
      timeOffsetCount: timeOffsetNodes.length,
```

**Step 2: Update the clear endpoint**

In `POST /nodes/:nodeNum/clear` (around line 234), add to the `upsertNode` call:
```typescript
      isTimeOffsetIssue: false,
      timeOffsetSeconds: undefined,
```

Wait — `upsertNode` may not support these fields directly. Instead, also call:
```typescript
    databaseService.updateNodeTimeOffsetFlags(nodeNum, false, null);
```

**Step 3: Update the export endpoint**

In the JSON export (around line 164), add to the node mapping:
```typescript
          isTimeOffsetIssue: (node as any).isTimeOffsetIssue || false,
          timeOffsetSeconds: (node as any).timeOffsetSeconds || null,
```

In the CSV export (around line 188), update the header:
```
'Node ID,Short Name,Long Name,Hardware Model,Last Heard,Low-Entropy Key,Duplicate Key,Time Offset,Offset (seconds),Issue Details,Key Hash Prefix'
```

And add to each row:
```typescript
        const isTimeOffset = (node as any).isTimeOffsetIssue ? 'Yes' : 'No';
        const offsetSeconds = (node as any).timeOffsetSeconds || '';
```

**Step 4: Commit**

```bash
git add src/server/routes/securityRoutes.ts
git commit -m "feat: include time offset data in security API endpoints"
```

---

### Task 5: Update Frontend SecurityTab Component

**Files:**
- Modify: `src/components/SecurityTab.tsx`

**Step 1: Update interfaces**

Add to `SecurityNode` interface (after `packetRateLastChecked`):
```typescript
  isTimeOffsetIssue?: boolean;
  timeOffsetSeconds?: number | null;
```

Add to `SecurityIssuesResponse` (after `excessivePacketsCount`):
```typescript
  timeOffsetCount: number;
```

**Step 2: Add `formatTimeOffset` helper**

Add after the `formatRelativeTime` function (after line 122):

```typescript
  const formatTimeOffset = (seconds: number | null | undefined): string => {
    if (seconds === null || seconds === undefined) return t('security.unknown');
    const abs = Math.abs(seconds);
    const sign = seconds >= 0 ? '+' : '-';
    if (abs < 60) return `${sign}${abs}s`;
    if (abs < 3600) return `${sign}${Math.floor(abs / 60)}m ${abs % 60}s`;
    const hours = Math.floor(abs / 3600);
    const mins = Math.floor((abs % 3600) / 60);
    return `${sign}${hours}h ${mins}m`;
  };
```

**Step 3: Add Time Offset stat card**

In the stats section (after the excessive-packets stat-card around line 319), add:

```tsx
        <div className="stat-card time-offset">
          <div className="stat-value">{issues?.timeOffsetCount || 0}</div>
          <div className="stat-label">{t('security.have_time_offset')}</div>
        </div>
```

**Step 4: Add Time Offset section**

Between the Excessive Packets section (ending ~line 600) and the closing `</>` of the issues list, add:

```tsx
            {/* Time Offset Section */}
            {issues.timeOffsetCount > 0 && (
              <div className="issues-section">
                <h3>{t('security.time_offset_count', { count: issues.timeOffsetCount })}</h3>
                <p className="section-description">{t('security.time_offset_description')}</p>
                <div className="issues-list">
                  {issues.nodes.filter(node => node.isTimeOffsetIssue).map((node) => (
                    <div key={node.nodeNum} className="issue-card">
                      <div
                        className="issue-header"
                        onClick={() => setExpandedNode(expandedNode === node.nodeNum ? null : node.nodeNum)}
                      >
                        <div className="node-info">
                          <div className="node-name">
                            <span
                              className="node-link"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleNodeClick(node.nodeNum);
                              }}
                            >
                              {node.longName || node.shortName} ({node.shortName})
                            </span>
                          </div>
                          <div className="node-id">
                            Node #{node.nodeNum.toString(16).toUpperCase()}
                            {node.hwModel !== undefined && node.hwModel !== 0 && (
                              <span className="hw-model"> - {getHardwareModelName(node.hwModel)}</span>
                            )}
                          </div>
                          <div className="node-last-seen">
                            {t('security.last_seen', { time: formatRelativeTime(node.lastHeard) })}
                          </div>
                        </div>
                        <div className="issue-types">
                          <span className="badge time-offset">{t('security.badge_time_offset')}</span>
                          <span className="time-offset-value">{formatTimeOffset(node.timeOffsetSeconds)}</span>
                        </div>
                        <div className="expand-icon">
                          {expandedNode === node.nodeNum ? '▼' : '▶'}
                        </div>
                      </div>

                      {expandedNode === node.nodeNum && (
                        <div className="issue-details">
                          <div className="detail-row">
                            <span className="detail-label">{t('security.clock_offset')}:</span>
                            <span className="detail-value">{formatTimeOffset(node.timeOffsetSeconds)}</span>
                          </div>
                          <div className="detail-row">
                            <span className="detail-label">{t('security.last_heard')}:</span>
                            <span className="detail-value">{formatDate(node.lastHeard)}</span>
                          </div>
                          <div className="detail-row recommendations">
                            <span className="detail-label">{t('security.recommendations')}:</span>
                            <ul>
                              <li>{t('security.recommendation_time_offset')}</li>
                              <li>{t('security.recommendation_check_gps')}</li>
                            </ul>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
```

**Step 5: Commit**

```bash
git add src/components/SecurityTab.tsx
git commit -m "feat: add Time Offset section to Security tab"
```

---

### Task 6: Add i18n Translation Keys

**Files:**
- Modify: `public/locales/en.json`

**Step 1: Add translation keys**

Add after the existing security keys (after `"security.packets_hour"` around line 720):

```json
  "security.have_time_offset": "Have Time Offset",
  "security.time_offset_count": "Time Offset ({{count}} nodes)",
  "security.time_offset_description": "Nodes with clocks significantly out of sync with the server. This may indicate misconfigured devices or GPS issues.",
  "security.badge_time_offset": "Time Offset",
  "security.clock_offset": "Clock Offset",
  "security.unknown": "Unknown",
  "security.recommendation_time_offset": "This node's clock is significantly different from the server time, which can affect message ordering and duplicate detection.",
  "security.recommendation_check_gps": "Ensure the node has GPS connectivity or is configured with the correct time zone. A device restart may resolve temporary clock drift.",
```

**Step 2: Commit**

```bash
git add public/locales/en.json
git commit -m "feat: add i18n keys for time offset security section"
```

---

### Task 7: Add CSS Styles for Time Offset Section

**Files:**
- Modify: `src/styles/SecurityTab.css`

**Step 1: Add styles**

Add after the existing `.stat-card.excessive-packets` styles:

```css
.stat-card.time-offset {
  border-left: 4px solid #e67700;
}

.badge.time-offset {
  background: #e67700;
  color: white;
}

.time-offset-value {
  font-family: monospace;
  font-weight: bold;
  color: #e67700;
  margin-left: 0.5rem;
}
```

**Step 2: Commit**

```bash
git add src/styles/SecurityTab.css
git commit -m "feat: add CSS styles for time offset security section"
```

---

### Task 8: Write Tests

**Files:**
- Create: `src/server/services/duplicateKeySchedulerService.timeOffset.test.ts`

**Step 1: Write test for time offset detection**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock database service before importing the scheduler
vi.mock('../../services/database.js', () => ({
  default: {
    getLatestPacketTimestampsPerNodeAsync: vi.fn(),
    getAllNodes: vi.fn(),
    getNode: vi.fn(),
    updateNodeTimeOffsetFlags: vi.fn(),
    getSetting: vi.fn(),
    getNodesWithPublicKeys: vi.fn().mockReturnValue([]),
    getPacketCountsPerNodeLastHourAsync: vi.fn().mockResolvedValue([]),
    getTopBroadcastersAsync: vi.fn().mockResolvedValue([]),
  }
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}));

vi.mock('../services/lowEntropyKeyService.js', () => ({
  checkLowEntropyKey: vi.fn().mockReturnValue(false),
  detectDuplicateKeys: vi.fn().mockReturnValue(new Map()),
}));

import databaseService from '../../services/database.js';
import { DuplicateKeySchedulerService } from './duplicateKeySchedulerService.js';

describe('Time Offset Detection', () => {
  let scheduler: DuplicateKeySchedulerService;

  beforeEach(() => {
    vi.clearAllMocks();
    scheduler = new DuplicateKeySchedulerService();
    // Mock getAllNodes to return empty by default
    (databaseService.getAllNodes as any).mockReturnValue([]);
  });

  afterEach(() => {
    scheduler.stop();
  });

  it('should flag nodes with time offset exceeding threshold', async () => {
    const now = Date.now();
    const thirtyOneMinutesMs = 31 * 60 * 1000;

    (databaseService.getLatestPacketTimestampsPerNodeAsync as any).mockResolvedValue([
      { nodeNum: 100, timestamp: now, packetTimestamp: now - thirtyOneMinutesMs }
    ]);
    (databaseService.getNode as any).mockReturnValue({
      nodeNum: 100,
      shortName: 'Test',
      isTimeOffsetIssue: false
    });
    (databaseService.getAllNodes as any).mockReturnValue([]);

    await scheduler.runScan();

    expect(databaseService.updateNodeTimeOffsetFlags).toHaveBeenCalledWith(
      100, true, expect.any(Number)
    );
    // Offset should be ~1860 seconds (31 minutes)
    const call = (databaseService.updateNodeTimeOffsetFlags as any).mock.calls.find(
      (c: any[]) => c[0] === 100 && c[1] === true
    );
    expect(call).toBeDefined();
    expect(Math.abs(call[2])).toBeGreaterThanOrEqual(1800);
  });

  it('should not flag nodes within threshold', async () => {
    const now = Date.now();
    const tenMinutesMs = 10 * 60 * 1000;

    (databaseService.getLatestPacketTimestampsPerNodeAsync as any).mockResolvedValue([
      { nodeNum: 200, timestamp: now, packetTimestamp: now - tenMinutesMs }
    ]);
    (databaseService.getNode as any).mockReturnValue({
      nodeNum: 200,
      shortName: 'Test2',
      isTimeOffsetIssue: false
    });
    (databaseService.getAllNodes as any).mockReturnValue([]);

    await scheduler.runScan();

    expect(databaseService.updateNodeTimeOffsetFlags).toHaveBeenCalledWith(
      200, false, expect.any(Number)
    );
  });

  it('should clear flags from nodes with no timestamp data', async () => {
    (databaseService.getLatestPacketTimestampsPerNodeAsync as any).mockResolvedValue([]);
    (databaseService.getAllNodes as any).mockReturnValue([
      { nodeNum: 300, shortName: 'Old', isTimeOffsetIssue: true }
    ]);

    await scheduler.runScan();

    expect(databaseService.updateNodeTimeOffsetFlags).toHaveBeenCalledWith(
      300, false, null
    );
  });
});
```

**Step 2: Run tests**

```bash
npx vitest run src/server/services/duplicateKeySchedulerService.timeOffset.test.ts
```

Expected: PASS

**Step 3: Commit**

```bash
git add src/server/services/duplicateKeySchedulerService.timeOffset.test.ts
git commit -m "test: add tests for time offset detection in security scanner"
```

---

### Task 9: Update Security Routes Test (if needed) and Full Test Run

**Step 1: Run the full test suite**

```bash
npm test
```

Fix any TypeScript errors or test failures.

**Step 2: Build Docker image and test**

```bash
docker compose -f docker-compose.dev.yml build
docker compose -f docker-compose.dev.yml up -d
```

Verify the Security tab loads and shows the new Time Offset stat card (should show 0 initially).

**Step 3: Final commit for any fixups**

```bash
git add -A
git commit -m "fix: address test and build issues for time offset feature"
```

---

## File Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/server/migrations/081_add_time_offset_columns.ts` | Create | Migration for new columns |
| `src/services/database.ts` | Modify | Register migration, add DB methods |
| `src/db/schema/nodes.ts` | Modify | Add Drizzle schema columns |
| `src/db/schema/postgres-create.ts` | Modify | Add columns to Postgres CREATE |
| `src/db/schema/mysql-create.ts` | Modify | Add columns to MySQL CREATE |
| `src/server/services/duplicateKeySchedulerService.ts` | Modify | Add `runTimeOffsetDetection()` |
| `src/server/routes/securityRoutes.ts` | Modify | Include time offset in API responses |
| `src/components/SecurityTab.tsx` | Modify | New Time Offset UI section |
| `src/styles/SecurityTab.css` | Modify | Styles for new section |
| `public/locales/en.json` | Modify | Translation keys |
| `src/server/services/duplicateKeySchedulerService.timeOffset.test.ts` | Create | Tests |
