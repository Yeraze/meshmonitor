# Key Mismatch Detection & Immediate Purge Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proactively detect key mismatches when mesh-received NodeInfo keys differ from stored keys, display mismatch history on the Security Tab, and optionally auto-purge mismatched nodes immediately.

**Architecture:** Extends the existing auto-key repair infrastructure. Detection happens in `processNodeInfoMessageProtobuf` before the key overwrite. Resolution happens during device DB sync when the device's key matches the last mesh-received key. A new "immediate purge" setting bypasses the exchange-then-purge cycle.

**Tech Stack:** TypeScript, React, Drizzle ORM (SQLite/PostgreSQL/MySQL), Express routes

**Spec:** `docs/superpowers/specs/2026-03-14-key-mismatch-detection-design.md`

---

## Chunk 1: Database Foundation

### Task 1: Migration 084 — Add columns to nodes and repair log

**Files:**
- Create: `src/server/migrations/084_add_key_mismatch_columns.ts`
- Modify: `src/services/database.ts` (import + registration in 3 init paths)

- [ ] **Step 1: Create migration file**

Create `src/server/migrations/084_add_key_mismatch_columns.ts` following the pattern from migration 083:

```typescript
import type { Database } from 'better-sqlite3';
import type { PoolClient } from 'pg';
import type { Pool } from 'mysql2/promise';

export function runMigration084Sqlite(db: Database): void {
  // Add lastMeshReceivedKey to nodes
  const hasLastMeshReceivedKey = db.prepare(
    "SELECT COUNT(*) as count FROM pragma_table_info('nodes') WHERE name='lastMeshReceivedKey'"
  ).get() as { count: number };
  if (hasLastMeshReceivedKey.count === 0) {
    db.exec("ALTER TABLE nodes ADD COLUMN lastMeshReceivedKey TEXT");
  }

  // Add oldKeyFragment to auto_key_repair_log
  const hasOldKeyFragment = db.prepare(
    "SELECT COUNT(*) as count FROM pragma_table_info('auto_key_repair_log') WHERE name='oldKeyFragment'"
  ).get() as { count: number };
  if (hasOldKeyFragment.count === 0) {
    db.exec("ALTER TABLE auto_key_repair_log ADD COLUMN oldKeyFragment TEXT");
  }

  // Add newKeyFragment to auto_key_repair_log
  const hasNewKeyFragment = db.prepare(
    "SELECT COUNT(*) as count FROM pragma_table_info('auto_key_repair_log') WHERE name='newKeyFragment'"
  ).get() as { count: number };
  if (hasNewKeyFragment.count === 0) {
    db.exec("ALTER TABLE auto_key_repair_log ADD COLUMN newKeyFragment TEXT");
  }
}

export async function runMigration084Postgres(client: PoolClient): Promise<void> {
  // Add lastMeshReceivedKey to nodes
  const nodesCheck = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'nodes' AND column_name = 'lastMeshReceivedKey'"
  );
  if (nodesCheck.rows.length === 0) {
    await client.query('ALTER TABLE nodes ADD COLUMN "lastMeshReceivedKey" TEXT');
  }

  // Add oldKeyFragment to auto_key_repair_log
  const oldKeyCheck = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'auto_key_repair_log' AND column_name = 'oldKeyFragment'"
  );
  if (oldKeyCheck.rows.length === 0) {
    await client.query('ALTER TABLE auto_key_repair_log ADD COLUMN "oldKeyFragment" VARCHAR(8)');
  }

  // Add newKeyFragment to auto_key_repair_log
  const newKeyCheck = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'auto_key_repair_log' AND column_name = 'newKeyFragment'"
  );
  if (newKeyCheck.rows.length === 0) {
    await client.query('ALTER TABLE auto_key_repair_log ADD COLUMN "newKeyFragment" VARCHAR(8)');
  }
}

export async function runMigration084Mysql(pool: Pool): Promise<void> {
  // Add lastMeshReceivedKey to nodes
  const [nodesRows] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'nodes' AND column_name = 'lastMeshReceivedKey'"
  );
  if ((nodesRows as any[]).length === 0) {
    await pool.query('ALTER TABLE nodes ADD COLUMN lastMeshReceivedKey VARCHAR(128)');
  }

  // Add oldKeyFragment to auto_key_repair_log
  const [oldKeyRows] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'auto_key_repair_log' AND column_name = 'oldKeyFragment'"
  );
  if ((oldKeyRows as any[]).length === 0) {
    await pool.query('ALTER TABLE auto_key_repair_log ADD COLUMN oldKeyFragment VARCHAR(8)');
  }

  // Add newKeyFragment to auto_key_repair_log
  const [newKeyRows] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'auto_key_repair_log' AND column_name = 'newKeyFragment'"
  );
  if ((newKeyRows as any[]).length === 0) {
    await pool.query('ALTER TABLE auto_key_repair_log ADD COLUMN newKeyFragment VARCHAR(8)');
  }
}
```

- [ ] **Step 2: Register migration in database.ts**

Add import near line 91 (alongside migration 083 import):
```typescript
import { runMigration084Sqlite, runMigration084Postgres, runMigration084Mysql } from '../server/migrations/084_add_key_mismatch_columns.js';
```

Add SQLite registration after migration 083 block (around line 2623):
```typescript
const migrationKey084 = 'migration_084_key_mismatch_columns';
if (!this.getSetting(migrationKey084)) {
  try {
    logger.debug('Running migration 084: Add key mismatch columns...');
    runMigration084Sqlite(this.db);
    this.setSetting(migrationKey084, 'completed');
    logger.debug('Migration 084 completed successfully');
  } catch (error) {
    logger.error('Error running migration 084:', error);
  }
}
```

Add Postgres registration after migration 083 call (around line 11698):
```typescript
await runMigration084Postgres(client);
```

Add MySQL registration after migration 083 call (around line 11859):
```typescript
await runMigration084Mysql(pool);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/server/migrations/084_add_key_mismatch_columns.ts src/services/database.ts
git commit -m "feat: add migration 084 for key mismatch columns"
```

### Task 2: Port key repair logging to PostgreSQL/MySQL

**Files:**
- Modify: `src/services/database.ts` — replace stubs in `logKeyRepairAttempt`, `getKeyRepairLog`, `clearKeyRepairState`, `setKeyRepairState`, `getNodesNeedingKeyRepair`

This is a prerequisite — the existing methods return no-ops for Postgres/MySQL.

- [ ] **Step 1: Implement async `logKeyRepairAttemptAsync`**

Add new async method near line 7535 in `database.ts`:

```typescript
async logKeyRepairAttemptAsync(
  nodeNum: number,
  nodeName: string | null,
  action: string,
  success: boolean | null = null,
  oldKeyFragment: string | null = null,
  newKeyFragment: string | null = null
): Promise<number> {
  if (this.drizzleDbType === 'postgres') {
    const client = await (this as any).pgPool.connect();
    try {
      const result = await client.query(
        `INSERT INTO auto_key_repair_log (timestamp, "nodeNum", "nodeName", action, success, created_at, "oldKeyFragment", "newKeyFragment")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [Date.now(), nodeNum, nodeName, action, success === null ? null : (success ? 1 : 0), Date.now(), oldKeyFragment, newKeyFragment]
      );
      // Cleanup old entries
      await client.query(
        `DELETE FROM auto_key_repair_log WHERE id NOT IN (
          SELECT id FROM auto_key_repair_log ORDER BY timestamp DESC LIMIT 100
        )`
      );
      return result.rows[0]?.id || 0;
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = (this as any).mysqlPool;
    const [result] = await pool.query(
      `INSERT INTO auto_key_repair_log (timestamp, nodeNum, nodeName, action, success, created_at, oldKeyFragment, newKeyFragment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [Date.now(), nodeNum, nodeName, action, success === null ? null : (success ? 1 : 0), Date.now(), oldKeyFragment, newKeyFragment]
    );
    // Cleanup old entries
    await pool.query(
      `DELETE FROM auto_key_repair_log WHERE id NOT IN (
        SELECT id FROM (SELECT id FROM auto_key_repair_log ORDER BY timestamp DESC LIMIT 100) as t
      )`
    );
    return (result as any).insertId || 0;
  }
  // SQLite fallback - use existing sync method plus new columns
  const stmt = this.db.prepare(`
    INSERT INTO auto_key_repair_log (timestamp, nodeNum, nodeName, action, success, created_at, oldKeyFragment, newKeyFragment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(Date.now(), nodeNum, nodeName, action, success === null ? null : (success ? 1 : 0), Date.now(), oldKeyFragment, newKeyFragment);
  // Cleanup
  this.db.prepare('DELETE FROM auto_key_repair_log WHERE id NOT IN (SELECT id FROM auto_key_repair_log ORDER BY timestamp DESC LIMIT 100)').run();
  return Number(info.lastInsertRowid);
}
```

- [ ] **Step 2: Implement async `getKeyRepairLogAsync`**

Add new async method:

```typescript
async getKeyRepairLogAsync(limit: number = 50): Promise<{
  id: number;
  timestamp: number;
  nodeNum: number;
  nodeName: string | null;
  action: string;
  success: boolean | null;
  oldKeyFragment: string | null;
  newKeyFragment: string | null;
}[]> {
  if (this.drizzleDbType === 'postgres') {
    const client = await (this as any).pgPool.connect();
    try {
      const result = await client.query(
        `SELECT id, timestamp, "nodeNum", "nodeName", action, success, "oldKeyFragment", "newKeyFragment"
         FROM auto_key_repair_log ORDER BY timestamp DESC LIMIT $1`,
        [limit]
      );
      return result.rows.map((row: any) => ({
        id: row.id,
        timestamp: Number(row.timestamp),
        nodeNum: Number(row.nodeNum),
        nodeName: row.nodeName,
        action: row.action,
        success: row.success === null ? null : Boolean(row.success),
        oldKeyFragment: row.oldKeyFragment || null,
        newKeyFragment: row.newKeyFragment || null,
      }));
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = (this as any).mysqlPool;
    const [rows] = await pool.query(
      `SELECT id, timestamp, nodeNum, nodeName, action, success, oldKeyFragment, newKeyFragment
       FROM auto_key_repair_log ORDER BY timestamp DESC LIMIT ?`,
      [limit]
    );
    return (rows as any[]).map((row: any) => ({
      id: row.id,
      timestamp: Number(row.timestamp),
      nodeNum: Number(row.nodeNum),
      nodeName: row.nodeName,
      action: row.action,
      success: row.success === null ? null : Boolean(row.success),
      oldKeyFragment: row.oldKeyFragment || null,
      newKeyFragment: row.newKeyFragment || null,
    }));
  }
  // SQLite — query directly with new columns (available after migration 084)
  const rows = this.db.prepare(`
    SELECT id, timestamp, nodeNum, nodeName, action, success, oldKeyFragment, newKeyFragment
    FROM auto_key_repair_log ORDER BY timestamp DESC LIMIT ?
  `).all(limit) as any[];
  return rows.map((row: any) => ({
    id: row.id,
    timestamp: Number(row.timestamp),
    nodeNum: Number(row.nodeNum),
    nodeName: row.nodeName,
    action: row.action,
    success: row.success === null ? null : Boolean(row.success),
    oldKeyFragment: row.oldKeyFragment || null,
    newKeyFragment: row.newKeyFragment || null,
  }));
}
```

- [ ] **Step 3: Port `clearKeyRepairState` to PostgreSQL/MySQL**

The existing method (lines 7431-7443) is a no-op for Postgres/MySQL. Add async version and update the sync method:

```typescript
async clearKeyRepairStateAsync(nodeNum: number): Promise<void> {
  if (this.drizzleDbType === 'postgres') {
    const client = await (this as any).pgPool.connect();
    try {
      await client.query('DELETE FROM auto_key_repair_state WHERE "nodeNum" = $1', [nodeNum]);
    } finally {
      client.release();
    }
  } else if (this.drizzleDbType === 'mysql') {
    const pool = (this as any).mysqlPool;
    await pool.query('DELETE FROM auto_key_repair_state WHERE nodeNum = ?', [nodeNum]);
  } else {
    this.clearKeyRepairState(nodeNum);
  }
}
```

Update existing sync `clearKeyRepairState` stub to fire-and-forget:
```typescript
if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
  this.clearKeyRepairStateAsync(nodeNum).catch(err =>
    logger.error('Error clearing key repair state:', err)
  );
  return;
}
```

- [ ] **Step 4: Update existing sync methods to call async for Postgres/MySQL**

Update `logKeyRepairAttempt` stub (lines 7511-7513) to fire-and-forget the async version:
```typescript
if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
  this.logKeyRepairAttemptAsync(nodeNum, nodeName, action, success).catch(err =>
    logger.error('Error logging key repair attempt:', err)
  );
  return 0;
}
```

Update `getKeyRepairLog` stub (lines 7545-7547) — this stays sync but callers should migrate to async. Leave as-is for backwards compat.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Run tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: port key repair logging to PostgreSQL/MySQL"
```

### Task 3: Add Drizzle schema field for `lastMeshReceivedKey`

**Files:**
- Modify: `src/db/schema/nodes.ts` — add field to all 3 schema definitions

- [ ] **Step 1: Add field to SQLite schema**

Find the SQLite nodes schema and add after `publicKey`:
```typescript
lastMeshReceivedKey: text('lastMeshReceivedKey'),
```

- [ ] **Step 2: Add field to PostgreSQL schema**

Find the PostgreSQL nodes schema and add after `publicKey`:
```typescript
lastMeshReceivedKey: pgText('lastMeshReceivedKey'),
```

- [ ] **Step 3: Add field to MySQL schema**

Find the MySQL nodes schema and add after `publicKey`:
```typescript
lastMeshReceivedKey: varchar('lastMeshReceivedKey', { length: 128 }),
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/db/schema/nodes.ts
git commit -m "feat: add lastMeshReceivedKey to node schemas"
```

---

## Chunk 2: Backend Detection & Resolution Logic

### Task 4: Implement mismatch detection in NodeInfo processing

**Files:**
- Modify: `src/server/meshtasticManager.ts` — update `processNodeInfoMessageProtobuf` around line 4200

- [ ] **Step 1: Add mismatch detection before existing key-fix logic**

In `processNodeInfoMessageProtobuf`, after `existingNode` is fetched (line 4202) but **before** the existing `keyMismatchDetected` check (line 4203), add a guard flag and detection logic:

```typescript
// --- NEW: Proactive key mismatch detection ---
let newMismatchDetected = false;

// Detect key mismatch: incoming mesh key differs from stored key
if (existingNode && existingNode.publicKey && nodeData.publicKey && existingNode.publicKey !== nodeData.publicKey) {
  const oldFragment = existingNode.publicKey.substring(0, 8);
  const newFragment = nodeData.publicKey.substring(0, 8);

  if (!existingNode.keyMismatchDetected) {
    // First mismatch — flag it
    logger.warn(`🔐 Key mismatch detected for node ${nodeId} (${user.longName}): stored=${oldFragment}... mesh=${newFragment}...`);

    nodeData.keyMismatchDetected = true;
    nodeData.lastMeshReceivedKey = nodeData.publicKey;
    nodeData.keySecurityIssueDetails = `Key mismatch: node broadcast key ${newFragment}... but device has ${oldFragment}...`;
    newMismatchDetected = true;

    const nodeName = user.longName || user.shortName || nodeId;
    databaseService.logKeyRepairAttemptAsync(
      fromNum, nodeName, 'mismatch', null, oldFragment, newFragment
    ).catch(err => logger.error('Error logging mismatch:', err));

    dataEventEmitter.emitNodeUpdate(fromNum, {
      keyMismatchDetected: true,
      keySecurityIssueDetails: nodeData.keySecurityIssueDetails
    });

    // Immediate purge if enabled
    if (this.keyRepairEnabled && this.keyRepairImmediatePurge) {
      try {
        logger.info(`🔐 Immediate purge: removing node ${nodeName} from device database`);
        await this.sendRemoveNode(fromNum);
        databaseService.logKeyRepairAttemptAsync(
          fromNum, nodeName, 'purge', true, oldFragment, newFragment
        ).catch(err => logger.error('Error logging purge:', err));

        // Request fresh NodeInfo exchange
        await this.sendNodeInfoRequest(fromNum, 0);
      } catch (error) {
        logger.error(`🔐 Immediate purge failed for ${nodeName}:`, error);
        databaseService.logKeyRepairAttemptAsync(
          fromNum, nodeName, 'purge', false, oldFragment, newFragment
        ).catch(err => logger.error('Error logging purge failure:', err));
      }
    }
  } else {
    // Already flagged from prior detection — update lastMeshReceivedKey with latest key
    nodeData.lastMeshReceivedKey = nodeData.publicKey;
    newMismatchDetected = true; // prevent existing block from clearing the flag
  }
}
```

- [ ] **Step 2: Guard existing key-fix block with `newMismatchDetected` flag**

The existing block at line 4203-4227 clears `keyMismatchDetected` when `oldKey !== newKey`. **Without a guard, it would immediately clear the flag we just set** (since the incoming key IS different from stored). Wrap the entire existing block in `if (!newMismatchDetected)`:

```typescript
// Existing block — only runs for PKI-error-based mismatches, NOT our proactive detection
if (!newMismatchDetected) {
  if (existingNode && existingNode.keyMismatchDetected) {
    // ... existing code unchanged ...
    nodeData.lastMeshReceivedKey = undefined; // ADD: clear on resolution
  }
}
```

Add `nodeData.lastMeshReceivedKey = undefined;` after `nodeData.keyMismatchDetected = false;` inside the existing block.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/server/meshtasticManager.ts
git commit -m "feat: detect key mismatch on mesh-received NodeInfo"
```

### Task 5: Implement mismatch resolution in device DB sync

**Files:**
- Modify: `src/server/meshtasticManager.ts` — update device DB sync processing around line 5596

- [ ] **Step 1: Add resolution check before the skip-stale-key logic**

In the device DB sync section, **before** the `publicKey` handling block (line 5596), add a resolution check. Use a flag to skip the normal stale-key check when a mismatch is resolved:

```typescript
// --- NEW: Check if device sync resolves a key mismatch ---
let mismatchResolved = false;

if (nodeInfo.user.publicKey && nodeInfo.user.publicKey.length > 0) {
  const deviceSyncKey = Buffer.from(nodeInfo.user.publicKey).toString('base64');
  const existingNode = databaseService.getNode(Number(nodeInfo.num));

  // Check if device sync resolves a key mismatch
  if (existingNode?.keyMismatchDetected && existingNode.lastMeshReceivedKey) {
    if (deviceSyncKey === existingNode.lastMeshReceivedKey) {
      // Device now has the same key as the mesh broadcast — mismatch resolved!
      logger.info(`🔐 Key mismatch RESOLVED via device sync for ${nodeId}: device key matches mesh key`);
      nodeData.keyMismatchDetected = false;
      nodeData.lastMeshReceivedKey = null;
      nodeData.publicKey = deviceSyncKey;
      nodeData.hasPKC = true;
      mismatchResolved = true;

      const nodeName = nodeInfo.user?.longName || nodeInfo.user?.shortName || nodeId;
      databaseService.clearKeyRepairStateAsync(Number(nodeInfo.num)).catch(err =>
        logger.error('Error clearing repair state:', err)
      );
      databaseService.logKeyRepairAttemptAsync(
        Number(nodeInfo.num), nodeName, 'fixed', true
      ).catch(err => logger.error('Error logging fix:', err));

      dataEventEmitter.emitNodeUpdate(Number(nodeInfo.num), {
        keyMismatchDetected: false,
        keySecurityIssueDetails: undefined
      });
    }
  }

  // Existing stale-key skip logic — only run if mismatch was NOT just resolved
  if (!mismatchResolved) {
    const isLocalNode = this.localNodeInfo?.nodeNum === Number(nodeInfo.num);
    // ... existing stale-key skip code (lines 5608-5621) stays as-is ...
  }
}
```

**Important:** This replaces the existing `existingNode` fetch at line 5606 — both the resolution check and the stale-key skip share the same `existingNode` lookup. The `existingNode` variable must be hoisted above both blocks. Use `clearKeyRepairStateAsync` (from Task 2 Step 3) instead of the sync `clearKeyRepairState`.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/server/meshtasticManager.ts
git commit -m "feat: resolve key mismatch during device DB sync"
```

### Task 6: Add immediate purge setting to meshtasticManager

**Files:**
- Modify: `src/server/meshtasticManager.ts` — update state variables, `setKeyRepairSettings`, and scheduler

- [ ] **Step 1: Add state variable**

Near line 308, after `private keyRepairAutoPurge: boolean = false;`:
```typescript
private keyRepairImmediatePurge: boolean = false;
```

- [ ] **Step 2: Update `setKeyRepairSettings`**

Update the interface at line 1332 to accept `immediatePurge`:
```typescript
setKeyRepairSettings(settings: {
  enabled?: boolean;
  intervalMinutes?: number;
  maxExchanges?: number;
  autoPurge?: boolean;
  immediatePurge?: boolean;
}): void
```

Add inside the method body:
```typescript
if (settings.immediatePurge !== undefined) {
  this.keyRepairImmediatePurge = settings.immediatePurge;
}
```

Update the log line (line 1357) to include `immediatePurge`.

- [ ] **Step 3: Update scheduler to skip nodes when immediate purge is enabled**

In `processKeyRepairs` (line 1268), inside the loop that iterates `nodesNeedingRepair`, add a check at the **start of each iteration** to skip nodes that were already immediately purged:

```typescript
// When immediate purge is enabled, skip nodes whose most recent log action is 'purge'
// Those nodes were already purged at detection time and await device sync resolution.
// Nodes flagged via PKI routing errors (not our proactive detection) still need
// the exchange-then-purge cycle, so we don't skip the entire scheduler.
if (this.keyRepairImmediatePurge) {
  const recentLog = await databaseService.getKeyRepairLogAsync(1);
  const lastAction = recentLog.find(e => e.nodeNum === node.nodeNum);
  if (lastAction?.action === 'purge') {
    logger.debug(`🔐 Key repair: skipping ${node.nodeNum} — already immediately purged, awaiting device sync`);
    continue;
  }
}
```

This allows PKI-error-flagged nodes to still go through the exchange-then-purge cycle even when immediate purge is enabled, while skipping nodes that were already purged at detection time.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/server/meshtasticManager.ts
git commit -m "feat: add immediate purge setting to key repair"
```

### Task 7: Wire up the new setting in server.ts and settingsRoutes.ts

**Files:**
- Modify: `src/server/server.ts` — load setting on startup (line 413-425)
- Modify: `src/server/routes/settingsRoutes.ts` — handle setting in POST (line 532-561)

- [ ] **Step 1: Load setting on startup**

In `server.ts` around line 416, after loading `keyRepairAutoPurge`:
```typescript
const keyRepairImmediatePurge = databaseService.getSetting('autoKeyManagementImmediatePurge');
```

Update the `setKeyRepairSettings` call (line 419) to include:
```typescript
immediatePurge: keyRepairImmediatePurge === 'true'
```

- [ ] **Step 2: Handle in settings route**

In `settingsRoutes.ts`, add `'autoKeyManagementImmediatePurge'` to the `keyRepairSettings` array (line 535).

Update the `callbacks.setKeyRepairSettings` call (line 540) to include:
```typescript
immediatePurge:
  filteredSettings.autoKeyManagementImmediatePurge === 'true' ||
  (filteredSettings.autoKeyManagementImmediatePurge === undefined &&
    databaseService.getSetting('autoKeyManagementImmediatePurge') === 'true'),
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/server/server.ts src/server/routes/settingsRoutes.ts
git commit -m "feat: wire immediate purge setting through server startup and settings API"
```

---

## Chunk 3: API & Security Routes

### Task 8: Add key mismatch history endpoint

**Files:**
- Modify: `src/server/routes/securityRoutes.ts` — add `GET /api/security/key-mismatches`

- [ ] **Step 1: Add endpoint**

Add after existing endpoints (around line 305):

```typescript
/**
 * GET /api/security/key-mismatches
 * Returns recent key mismatch events from the repair log
 */
router.get('/key-mismatches', async (req: Request, res: Response) => {
  try {
    const log = await databaseService.getKeyRepairLogAsync(100);

    // Filter to mismatch-related actions
    const mismatchActions = new Set(['mismatch', 'purge', 'fixed', 'exhausted']);
    const filtered = log.filter(entry => mismatchActions.has(entry.action));

    // Filter to last 7 days
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const recent = filtered.filter(entry => entry.timestamp >= sevenDaysAgo);

    // Limit to 50 entries
    const limited = recent.slice(0, 50);

    res.json({
      success: true,
      count: limited.length,
      events: limited
    });
  } catch (error) {
    logger.error('Error fetching key mismatch history:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch key mismatch history' });
  }
});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/securityRoutes.ts
git commit -m "feat: add key mismatch history API endpoint"
```

---

## Chunk 4: Frontend — Security Tab

### Task 9: Add Key Mismatch section to SecurityTab

**Files:**
- Modify: `src/components/SecurityTab.tsx` — add new section after Duplicate Keys
- Modify: `public/locales/en.json` — add translation keys

- [ ] **Step 1: Add translation keys**

Add to `public/locales/en.json` in the security section:

```json
"security.key_mismatch_title": "Key Mismatch Events",
"security.key_mismatch_empty": "No key mismatch events detected",
"security.key_mismatch_detected": "Detected",
"security.key_mismatch_old_key": "Old Key",
"security.key_mismatch_new_key": "New Key",
"security.key_mismatch_status": "Status",
"security.key_mismatch_resolved": "Resolved",
"security.key_mismatch_status_pending": "Pending",
"security.key_mismatch_status_purged": "Purged",
"security.key_mismatch_status_fixed": "Fixed",
"security.key_mismatch_status_exhausted": "Exhausted"
```

- [ ] **Step 2: Add state and data fetching**

In `SecurityTab.tsx`, add state for mismatch events:

```typescript
const [mismatchEvents, setMismatchEvents] = useState<any[]>([]);
```

In the `fetchSecurityData` function, add a fetch for mismatch history:

```typescript
const [issuesData, statusData, mismatchData] = await Promise.all([
  api.get<SecurityIssuesResponse>('/api/security/issues'),
  api.get<ScannerStatus>('/api/security/scanner/status'),
  api.get<{ events: any[] }>('/api/security/key-mismatches')
]);
setMismatchEvents(mismatchData.events || []);
```

- [ ] **Step 3: Add Key Mismatch section UI**

After the Duplicate Keys section (around line 507), add:

```tsx
{/* Key Mismatch Events Section */}
<div className="issues-section">
  <h3>{t('security.key_mismatch_title')}</h3>
  {mismatchEvents.length === 0 ? (
    <p className="no-issues">{t('security.key_mismatch_empty')}</p>
  ) : (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
      <thead>
        <tr style={{ background: 'var(--ctp-surface1)' }}>
          <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
            {t('automation.auto_key_management.log_node')}
          </th>
          <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
            {t('security.key_mismatch_detected')}
          </th>
          <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
            {t('security.key_mismatch_old_key')}
          </th>
          <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
            {t('security.key_mismatch_new_key')}
          </th>
          <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
            {t('security.key_mismatch_status')}
          </th>
          <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
            {t('security.key_mismatch_resolved')}
          </th>
        </tr>
      </thead>
      <tbody>
        {mismatchEvents.map((event) => (
          <tr key={event.id} style={{ borderTop: '1px solid var(--ctp-surface1)' }}>
            <td style={{ padding: '0.4rem 0.75rem' }}>
              {event.nodeName || `!${event.nodeNum.toString(16).padStart(8, '0')}`}
            </td>
            <td style={{ padding: '0.4rem 0.75rem', color: 'var(--ctp-subtext0)' }}>
              {new Date(event.timestamp).toLocaleString()}
            </td>
            <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', fontSize: '0.8rem' }}>
              {event.oldKeyFragment || '-'}
            </td>
            <td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', fontSize: '0.8rem' }}>
              {event.newKeyFragment || '-'}
            </td>
            <td style={{ padding: '0.4rem 0.75rem' }}>
              {getMismatchStatusLabel(event.action)}
            </td>
            <td style={{ padding: '0.4rem 0.75rem', color: 'var(--ctp-subtext0)' }}>
              {event.action === 'fixed' ? new Date(event.timestamp).toLocaleString() : '-'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )}
</div>
```

Add helper function:

```typescript
const getMismatchStatusLabel = (action: string): string => {
  switch (action) {
    case 'mismatch': return t('security.key_mismatch_status_pending');
    case 'purge': return t('security.key_mismatch_status_purged');
    case 'fixed': return t('security.key_mismatch_status_fixed');
    case 'exhausted': return t('security.key_mismatch_status_exhausted');
    default: return action;
  }
};
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/components/SecurityTab.tsx public/locales/en.json
git commit -m "feat: add key mismatch history section to Security tab"
```

---

## Chunk 5: Frontend — Auto-Key Management UI

### Task 10: Add immediate purge toggle and key fragment columns

**Files:**
- Modify: `src/components/AutoKeyManagementSection.tsx` — add toggle and columns
- Modify: `public/locales/en.json` — add translation keys

- [ ] **Step 1: Add translation keys**

Add to `public/locales/en.json`:

```json
"automation.auto_key_management.immediate_purge": "Immediately Purge on Key Mismatch",
"automation.auto_key_management.immediate_purge_description": "When a node broadcasts a different key than what your device has cached, immediately remove it from the device database to trigger re-discovery. If disabled, the standard exchange-then-purge cycle is used.",
"automation.auto_key_management.action_mismatch": "Mismatch",
"automation.auto_key_management.log_old_key": "Old Key",
"automation.auto_key_management.log_new_key": "New Key"
```

- [ ] **Step 2: Add prop for immediate purge**

Update component props interface to include:
```typescript
immediatePurge: boolean;
onImmediatePurgeChange: (value: boolean) => void;
```

Add local state:
```typescript
const [localImmediatePurge, setLocalImmediatePurge] = useState(immediatePurge);
```

- [ ] **Step 3: Add toggle UI**

After the existing auto-purge toggle (around line 292), add:

```tsx
<div className="setting-item" style={{ marginTop: '1rem' }}>
  <label htmlFor="immediatePurge">
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <input
        id="immediatePurge"
        type="checkbox"
        checked={localImmediatePurge}
        onChange={(e) => setLocalImmediatePurge(e.target.checked)}
        disabled={!localEnabled}
        style={{
          width: 'auto',
          margin: 0,
          cursor: localEnabled ? 'pointer' : 'not-allowed',
        }}
      />
      {t('automation.auto_key_management.immediate_purge')}
    </div>
    <span className="setting-description">
      {t('automation.auto_key_management.immediate_purge_description')}
    </span>
  </label>
</div>
```

- [ ] **Step 4: Wire up save logic**

In the save handler, include `autoKeyManagementImmediatePurge` in the settings object sent to the API. Also call `onImmediatePurgeChange(localImmediatePurge)`.

- [ ] **Step 5: Add key fragment columns to activity log table**

Update the table header (around line 330) to include two new columns:

```tsx
<th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
  {t('automation.auto_key_management.log_old_key')}
</th>
<th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 500 }}>
  {t('automation.auto_key_management.log_new_key')}
</th>
```

Add corresponding cells in the tbody:

```tsx
<td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', fontSize: '0.8rem' }}>
  {entry.oldKeyFragment || '-'}
</td>
<td style={{ padding: '0.4rem 0.75rem', fontFamily: 'monospace', fontSize: '0.8rem' }}>
  {entry.newKeyFragment || '-'}
</td>
```

Update `getActionLabel` to handle the new `'mismatch'` action:
```typescript
case 'mismatch': return t('automation.auto_key_management.action_mismatch');
```

- [ ] **Step 6: Update parent component `src/App.tsx`**

`AutoKeyManagementSection` is rendered in `src/App.tsx`. Add:

1. State variable:
```typescript
const [keyRepairImmediatePurge, setKeyRepairImmediatePurge] = useState(false);
```

2. Load the setting in the settings fetch (where other key repair settings are loaded):
```typescript
setKeyRepairImmediatePurge(settings.autoKeyManagementImmediatePurge === 'true');
```

3. Pass new props to `<AutoKeyManagementSection>`:
```tsx
immediatePurge={keyRepairImmediatePurge}
onImmediatePurgeChange={setKeyRepairImmediatePurge}
```

- [ ] **Step 7: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/components/AutoKeyManagementSection.tsx src/App.tsx public/locales/en.json
git commit -m "feat: add immediate purge toggle and key fragment columns to auto-key management"
```

---

## Chunk 6: Testing & Verification

### Task 11: Run full test suite and fix failures

- [ ] **Step 1: Run unit tests**

Run: `npx vitest run`
Expected: All tests pass. Fix any failures caused by new method signatures or missing mocks.

Common fixes needed:
- Mock `logKeyRepairAttemptAsync` in test files that mock `databaseService`
- Mock `getKeyRepairLogAsync` similarly
- Add `lastMeshReceivedKey` to any test node data fixtures if needed

- [ ] **Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit any test fixes**

```bash
git add -A
git commit -m "test: fix test mocks for key mismatch feature"
```

### Task 12: Build and deploy for manual testing

- [ ] **Step 1: Stop running containers**

```bash
docker compose -f docker-compose.dev.yml --profile sqlite down 2>&1
```

- [ ] **Step 2: Build and deploy SQLite**

```bash
docker image rm meshmonitor-meshmonitor-sqlite:latest 2>/dev/null
docker compose -f docker-compose.dev.yml build --no-cache meshmonitor-sqlite
docker compose -f docker-compose.dev.yml --profile sqlite up -d
```

- [ ] **Step 3: Verify migration ran**

Check container logs for "migration 084" success message.

- [ ] **Step 4: Verify Security Tab shows Key Mismatch section**

Open http://localhost:8081/meshmonitor/ → Security tab → verify "Key Mismatch Events" section appears.

- [ ] **Step 5: Verify Auto-Key Management shows new toggle**

Settings → Auto Key Management → verify "Immediately Purge on Key Mismatch" toggle appears.

- [ ] **Step 6: Test on PostgreSQL**

Stop SQLite, start PostgreSQL profile, verify migration runs and features work.

### Task 13: Run system tests and create PR

- [ ] **Step 1: Stop all containers**

```bash
docker compose -f docker-compose.dev.yml --profile sqlite down
docker compose -f docker-compose.dev.yml down tileserver
```

- [ ] **Step 2: Run system tests**

```bash
bash tests/system-tests.sh
```

Expected: All system tests pass.

- [ ] **Step 3: Create branch and PR**

```bash
git checkout -b feat/key-mismatch-detection
git push -u origin feat/key-mismatch-detection
gh pr create --title "feat: key mismatch detection and immediate purge" --body "..."
```
