# MeshMonitor 4.0 Phase 2: Database Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `sourceId TEXT` (nullable) column to all 9 data tables, expose it through Drizzle schemas, add `BaseRepository.withSourceScope()` helper, update repository insert/upsert methods to accept an optional `sourceId`, and assign existing rows to the default source — while keeping all existing tests green and single-node behavior unchanged.

**Architecture:** Migration 021 adds the column to the live DB; Drizzle schema files expose it for type-safe queries. A `withSourceScope(table, sourceId?)` helper on `BaseRepository` returns a Drizzle SQL condition used for optional per-source filtering. Insert paths conditionally include `sourceId` only when explicitly provided (backward-compat: existing callers pass nothing and the column stays NULL). On startup, `SourcesRepository.assignNullSourceIds(id)` bulk-assigns legacy NULL rows to the default source.

**Tech Stack:** TypeScript, Drizzle ORM, SQLite (better-sqlite3), PostgreSQL (pg), MySQL (mysql2), Vitest

---

## File Map

### New files
| File | Purpose |
|------|---------|
| `src/server/migrations/021_add_source_id_columns.ts` | SQLite/PG/MySQL migration — adds `sourceId TEXT` + indexes |
| `src/db/repositories/sourceScope.test.ts` | Tests for `withSourceScope` and data-assignment helpers |

### Modified files
| File | Change |
|------|--------|
| `src/db/migrations.ts` | Register migration 021 |
| `src/db/migrations.test.ts` | Update count (20 → 21) and last-migration assertions |
| `src/db/schema/nodes.ts` | Add `sourceId` to all 3 dialect tables |
| `src/db/schema/messages.ts` | Add `sourceId` to all 3 dialect tables |
| `src/db/schema/telemetry.ts` | Add `sourceId` to all 3 dialect tables |
| `src/db/schema/traceroutes.ts` | Add `sourceId` to all 3 dialect tables |
| `src/db/schema/channels.ts` | Add `sourceId` to all 3 dialect tables |
| `src/db/schema/neighbors.ts` | Add `sourceId` to all 3 dialect tables |
| `src/db/schema/packets.ts` | Add `sourceId` to all 3 dialect tables |
| `src/db/schema/ignoredNodes.ts` | Add `sourceId` to all 3 dialect tables |
| `src/db/schema/channelDatabase.ts` | Add `sourceId` to all 3 dialect tables |
| `src/db/repositories/base.ts` | Add `withSourceScope(table, sourceId?)` helper |
| `src/db/repositories/nodes.ts` | `upsertNode` accepts `sourceId?`, stores it |
| `src/db/repositories/messages.ts` | `insertMessage` accepts `sourceId?`, stores it |
| `src/db/repositories/telemetry.ts` | `insertTelemetry` accepts `sourceId?`, stores it |
| `src/db/repositories/traceroutes.ts` | `insertTraceroute` accepts `sourceId?`, stores it |
| `src/db/repositories/channels.ts` | `upsertChannel` accepts `sourceId?`, stores it |
| `src/db/repositories/neighbors.ts` | `upsertNeighborInfo` (and batch) accept `sourceId?` |
| `src/db/repositories/misc.ts` | `insertPacketLog` accepts `sourceId?`, stores it |
| `src/db/repositories/ignoredNodes.ts` | `addIgnoredNodeAsync` accepts `sourceId?`, stores it |
| `src/db/repositories/channelDatabase.ts` | `createAsync` accepts `sourceId?`, stores it |
| `src/db/repositories/sources.ts` | Add `assignNullSourceIds(sourceId: string)` |
| `src/server/server.ts` | Call `assignNullSourceIds` after default source is created |

---

## Task 1: Migration 021 — Add sourceId columns to data tables

**Files:**
- Create: `src/server/migrations/021_add_source_id_columns.ts`
- Modify: `src/db/migrations.ts`
- Modify: `src/db/migrations.test.ts`

### Step 1: Write the failing test

Update `src/db/migrations.test.ts` — change the two assertions that reference migration 20:

```typescript
// In src/db/migrations.test.ts
// Change:
it('has all 20 migrations registered', () => {
  expect(registry.count()).toBe(20);
});

it('last migration is create sources table', () => {
  const all = registry.getAll();
  const last = all[all.length - 1];
  expect(last.number).toBe(20);
  expect(last.name).toContain('create_sources');
});

it('migrations are sequentially numbered from 1 to 20', () => {
  const all = registry.getAll();
  for (let i = 0; i < all.length; i++) {
    expect(all[i].number).toBe(i + 1);
  }
});

// To:
it('has all 21 migrations registered', () => {
  expect(registry.count()).toBe(21);
});

it('last migration is add source_id columns', () => {
  const all = registry.getAll();
  const last = all[all.length - 1];
  expect(last.number).toBe(21);
  expect(last.name).toContain('add_source_id_columns');
});

it('migrations are sequentially numbered from 1 to 21', () => {
  const all = registry.getAll();
  for (let i = 0; i < all.length; i++) {
    expect(all[i].number).toBe(i + 1);
  }
});
```

- [ ] **Step 2: Run the failing test**

```bash
./node_modules/.bin/vitest run src/db/migrations.test.ts
```

Expected: FAIL — "expected 20 to be 21"

- [ ] **Step 3: Create the migration file**

Create `src/server/migrations/021_add_source_id_columns.ts`:

```typescript
/**
 * Migration 021: Add sourceId column to all data tables (Phase 2)
 *
 * Adds a nullable TEXT `sourceId` column to every data table so rows can be
 * associated with a specific source. NULL means "belongs to the legacy default
 * source" (assigned during startup by server.ts).
 *
 * Tables: nodes, messages, telemetry, traceroutes, channels,
 *         neighbor_info, packet_log, ignored_nodes, channel_database
 *
 * Indexes are created on nodes, messages, and telemetry for query efficiency.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const DATA_TABLES = [
  'nodes', 'messages', 'telemetry', 'traceroutes',
  'channels', 'neighbor_info', 'packet_log', 'ignored_nodes', 'channel_database',
] as const;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 021 (SQLite): Adding sourceId column to data tables...');

    for (const table of DATA_TABLES) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN sourceId TEXT`);
        logger.debug(`Added sourceId to ${table}`);
      } catch (e: any) {
        if (e.message?.includes('duplicate column')) {
          logger.debug(`${table}.sourceId already exists, skipping`);
        } else {
          logger.warn(`Could not add sourceId to ${table}:`, e.message);
        }
      }
    }

    // Indexes for most-queried tables
    db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_source_id ON nodes(sourceId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_source_id ON messages(sourceId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_source_id ON telemetry(sourceId)`);

    logger.info('Migration 021 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 021 down: Not implemented (column drops are destructive)');
  },
};

// ============ PostgreSQL ============

export async function runMigration021Postgres(client: any): Promise<void> {
  logger.info('Running migration 021 (PostgreSQL): Adding sourceId column to data tables...');

  const pgTables = [
    'nodes', 'messages', 'telemetry', 'traceroutes',
    'channels', 'neighbor_info', 'packet_log', 'ignored_nodes', 'channel_database',
  ];

  for (const table of pgTables) {
    await client.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "sourceId" TEXT`
    );
    logger.debug(`Ensured sourceId column on ${table}`);
  }

  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_nodes_source_id ON nodes("sourceId")`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_messages_source_id ON messages("sourceId")`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_telemetry_source_id ON telemetry("sourceId")`
  );

  logger.info('Migration 021 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration021Mysql(pool: any): Promise<void> {
  logger.info('Running migration 021 (MySQL): Adding sourceId column to data tables...');

  const mysqlTables = [
    'nodes', 'messages', 'telemetry', 'traceroutes',
    'channels', 'neighbor_info', 'packet_log', 'ignored_nodes', 'channel_database',
  ];

  const conn = await pool.getConnection();
  try {
    for (const table of mysqlTables) {
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'sourceId'`,
        [table]
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        await conn.query(`ALTER TABLE ${table} ADD COLUMN sourceId VARCHAR(36)`);
        logger.debug(`Added sourceId to ${table}`);
      } else {
        logger.debug(`${table}.sourceId already exists, skipping`);
      }
    }

    // Indexes
    const indexChecks: Array<[string, string]> = [
      ['nodes', 'idx_nodes_source_id'],
      ['messages', 'idx_messages_source_id'],
      ['telemetry', 'idx_telemetry_source_id'],
    ];
    for (const [table, indexName] of indexChecks) {
      const [idxRows] = await conn.query(
        `SELECT COUNT(*) as cnt FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [table, indexName]
      );
      if (!(idxRows as any)[0]?.cnt) {
        await conn.query(`CREATE INDEX ${indexName} ON ${table}(sourceId)`);
        logger.debug(`Created index ${indexName}`);
      }
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 021 complete (MySQL)');
}
```

- [ ] **Step 4: Register migration 021 in `src/db/migrations.ts`**

Add the import at the bottom of the imports block:

```typescript
import { migration as addSourceIdColumnsMigration, runMigration021Postgres, runMigration021Mysql } from '../server/migrations/021_add_source_id_columns.js';
```

Then add the registry entry at the bottom of the file:

```typescript
// ---------------------------------------------------------------------------
// Migration 021: Add sourceId columns to all data tables (Phase 2)
// ---------------------------------------------------------------------------

registry.register({
  number: 21,
  name: 'add_source_id_columns',
  settingsKey: 'migration_021_add_source_id_columns',
  sqlite: (db) => addSourceIdColumnsMigration.up(db),
  postgres: (client) => runMigration021Postgres(client),
  mysql: (pool) => runMigration021Mysql(pool),
});
```

- [ ] **Step 5: Run the migration test**

```bash
./node_modules/.bin/vitest run src/db/migrations.test.ts
```

Expected: All tests PASS — count is 21, last migration is add_source_id_columns.

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/migrations/021_add_source_id_columns.ts src/db/migrations.ts src/db/migrations.test.ts
git commit -m "feat(4.0/phase2): migration 021 — add sourceId column to data tables"
```

---

## Task 2: Update Drizzle schemas — add sourceId to all 9 table definitions

**Files:**
- Modify: `src/db/schema/nodes.ts`
- Modify: `src/db/schema/messages.ts`
- Modify: `src/db/schema/telemetry.ts`
- Modify: `src/db/schema/traceroutes.ts`
- Modify: `src/db/schema/channels.ts`
- Modify: `src/db/schema/neighbors.ts`
- Modify: `src/db/schema/packets.ts`
- Modify: `src/db/schema/ignoredNodes.ts`
- Modify: `src/db/schema/channelDatabase.ts`

**Column names (actual DB column = `sourceId`, camelCase matching the project convention):**
- SQLite: `text('sourceId')` — nullable by default
- PostgreSQL: `pgText('sourceId')` — nullable
- MySQL: `myVarchar('sourceId', { length: 36 })` — nullable

**Pattern to follow** (shown for nodes.ts — repeat identically for all 9 files):

In each schema file, add `sourceId` as the last column before the closing `})` of each table definition.

- [ ] **Step 1: Add sourceId to nodes.ts**

In `src/db/schema/nodes.ts`, add to the end of each table definition (before `}`):

For `nodesSqlite`:
```typescript
  // Source association (nullable — NULL = legacy default source)
  sourceId: text('sourceId'),
```

For `nodesPostgres`:
```typescript
  // Source association (nullable — NULL = legacy default source)
  sourceId: pgText('sourceId'),
```

For `nodesMysql`:
```typescript
  // Source association (nullable — NULL = legacy default source)
  sourceId: myVarchar('sourceId', { length: 36 }),
```

- [ ] **Step 2: Add sourceId to messages.ts**

In `src/db/schema/messages.ts`, add to the end of each table definition:

For `messagesSqlite`:
```typescript
  sourceId: text('sourceId'),
```

For `messagesPostgres`:
```typescript
  sourceId: pgText('sourceId'),
```

For `messagesMysql`:
```typescript
  sourceId: myVarchar('sourceId', { length: 36 }),
```

- [ ] **Step 3: Add sourceId to telemetry.ts**

In `src/db/schema/telemetry.ts`, add to the end of each table definition:

For `telemetrySqlite`:
```typescript
  sourceId: text('sourceId'),
```

For `telemetryPostgres`:
```typescript
  sourceId: pgText('sourceId'),
```

For `telemetryMysql`:
```typescript
  sourceId: myVarchar('sourceId', { length: 36 }),
```

- [ ] **Step 4: Add sourceId to traceroutes.ts**

In `src/db/schema/traceroutes.ts`, add to the end of the `traceroutes*` table definitions only (not `routeSegments*`):

For `traceroutesSqlite`:
```typescript
  sourceId: text('sourceId'),
```

For `traceroutesPostgres`:
```typescript
  sourceId: pgText('sourceId'),
```

For `traceroutesMysql`:
```typescript
  sourceId: myVarchar('sourceId', { length: 36 }),
```

- [ ] **Step 5: Add sourceId to channels.ts**

In `src/db/schema/channels.ts`, add to the end of each table definition:

For `channelsSqlite`:
```typescript
  sourceId: text('sourceId'),
```

For `channelsPostgres`:
```typescript
  sourceId: pgText('sourceId'),
```

For `channelsMysql`:
```typescript
  sourceId: myVarchar('sourceId', { length: 36 }),
```

- [ ] **Step 6: Add sourceId to neighbors.ts**

In `src/db/schema/neighbors.ts`, add to the end of the `neighborInfo*` table definitions:

For `neighborInfoSqlite`:
```typescript
  sourceId: text('sourceId'),
```

For `neighborInfoPostgres`:
```typescript
  sourceId: pgText('sourceId'),
```

For `neighborInfoMysql`:
```typescript
  sourceId: myVarchar('sourceId', { length: 36 }),
```

- [ ] **Step 7: Add sourceId to packets.ts**

In `src/db/schema/packets.ts`, add to the end of the `packetLog*` table definitions:

For `packetLogSqlite`:
```typescript
  sourceId: text('sourceId'),
```

For `packetLogPostgres`:
```typescript
  sourceId: pgText('sourceId'),
```

For `packetLogMysql`:
```typescript
  sourceId: myVarchar('sourceId', { length: 36 }),
```

- [ ] **Step 8: Add sourceId to ignoredNodes.ts**

In `src/db/schema/ignoredNodes.ts`, add to the end of the `ignoredNodes*` table definitions:

For `ignoredNodesSqlite`:
```typescript
  sourceId: text('sourceId'),
```

For `ignoredNodesPostgres`:
```typescript
  sourceId: pgText('sourceId'),
```

For `ignoredNodesMysql`:
```typescript
  sourceId: myVarchar('sourceId', { length: 36 }),
```

- [ ] **Step 9: Add sourceId to channelDatabase.ts**

In `src/db/schema/channelDatabase.ts`, add to the end of the `channelDatabase*` table definitions only (NOT `channelDatabasePermissions*`):

For `channelDatabaseSqlite`:
```typescript
  sourceId: text('sourceId'),
```

For `channelDatabasePostgres`:
```typescript
  sourceId: pgText('sourceId'),
```

For `channelDatabaseMysql`:
```typescript
  sourceId: myVarchar('sourceId', { length: 36 }),
```

- [ ] **Step 10: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: No errors.

- [ ] **Step 11: Run the full test suite**

```bash
./node_modules/.bin/vitest run 2>&1 | tail -15
```

Expected: All tests PASS (zero failures). The schema changes are additive — existing repositories don't reference `sourceId` yet so nothing breaks.

- [ ] **Step 12: Commit**

```bash
git add src/db/schema/
git commit -m "feat(4.0/phase2): add sourceId column to all 9 data table Drizzle schemas"
```

---

## Task 3: BaseRepository.withSourceScope() helper

**Files:**
- Modify: `src/db/repositories/base.ts`
- Create: `src/db/repositories/sourceScope.test.ts`

The helper returns a Drizzle SQL equality condition when a `sourceId` is provided, or `undefined` when not. Drizzle's `and(...)` treats `undefined` arguments as no-ops, so callers can do `and(existingCond, this.withSourceScope(table, sourceId))` safely.

- [ ] **Step 1: Write the failing test**

Create `src/db/repositories/sourceScope.test.ts`:

```typescript
/**
 * Tests for BaseRepository.withSourceScope helper
 * Uses a concrete subclass to access the protected method.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../schema/index.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { eq } from 'drizzle-orm';

// Concrete subclass for testing protected methods
class TestRepo extends BaseRepository {
  constructor(db: DrizzleDatabase) {
    super(db, 'sqlite');
  }
  public testWithSourceScope(table: any, sourceId?: string) {
    return this.withSourceScope(table, sourceId);
  }
}

describe('BaseRepository.withSourceScope', () => {
  let repo: TestRepo;

  beforeEach(() => {
    const rawDb = new Database(':memory:');
    const drizzleDb = drizzle(rawDb, { schema });
    repo = new TestRepo(drizzleDb as any);
  });

  it('returns undefined when sourceId is not provided', () => {
    const result = repo.testWithSourceScope({}, undefined);
    expect(result).toBeUndefined();
  });

  it('returns a SQL condition when sourceId is provided', () => {
    // Using the nodes table from the active schema
    const { nodes } = repo['tables'];
    const result = repo.testWithSourceScope(nodes, 'source-abc-123');
    expect(result).toBeDefined();
  });

  it('returns undefined when sourceId is empty string', () => {
    const result = repo.testWithSourceScope({}, '');
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
./node_modules/.bin/vitest run src/db/repositories/sourceScope.test.ts
```

Expected: FAIL — "withSourceScope is not a function"

- [ ] **Step 3: Implement withSourceScope in base.ts**

Add the following to `src/db/repositories/base.ts`, after the existing `now()` method:

First, add `SQL` to the import from `drizzle-orm` at the top of the file:
```typescript
import { sql, eq, SQL } from 'drizzle-orm';
```
(Replace the existing `import { sql } from 'drizzle-orm';`)

Then add the method to the `BaseRepository` class:
```typescript
  /**
   * Return a Drizzle WHERE condition that filters by sourceId.
   *
   * Returns `undefined` when no sourceId is given — Drizzle's `and(...)` treats
   * undefined entries as no-ops, so existing callers that omit sourceId continue
   * to see all rows regardless of their source_id value.
   *
   * Usage:
   *   .where(and(eq(nodes.nodeNum, num), this.withSourceScope(nodes, sourceId)))
   */
  protected withSourceScope(table: any, sourceId?: string): SQL | undefined {
    if (!sourceId) return undefined;
    return eq(table.sourceId, sourceId);
  }
```

- [ ] **Step 4: Run the tests**

```bash
./node_modules/.bin/vitest run src/db/repositories/sourceScope.test.ts
```

Expected: All 3 tests PASS.

- [ ] **Step 5: Run full suite**

```bash
./node_modules/.bin/vitest run 2>&1 | tail -10
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/base.ts src/db/repositories/sourceScope.test.ts
git commit -m "feat(4.0/phase2): add withSourceScope helper to BaseRepository"
```

---

## Task 4: Update NodesRepository and MessagesRepository insert paths

**Files:**
- Modify: `src/db/repositories/nodes.ts`
- Modify: `src/db/repositories/messages.ts`
- Modify: `src/db/repositories/sourceScope.test.ts` (extend with data tests)

**Design:** `sourceId` is only added to the `values` object when it is explicitly provided (non-null, non-empty). This preserves backward compatibility: existing callers pass nothing and the column stays NULL in the DB. No changes to existing test `CREATE TABLE` strings are needed.

For `upsertNode`: include sourceId on INSERT only (don't overwrite existing sourceId on UPDATE — preserves source association once set).

- [ ] **Step 1: Add sourceId tests for nodes**

Append to `src/db/repositories/sourceScope.test.ts`:

```typescript
import { NodesRepository } from './nodes.js';

describe('NodesRepository sourceId support', () => {
  let db: Database.Database;
  let drizzleDb: any;
  let repo: NodesRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        nodeNum INTEGER PRIMARY KEY,
        nodeId TEXT NOT NULL UNIQUE,
        longName TEXT,
        shortName TEXT,
        hwModel INTEGER,
        role INTEGER,
        hopsAway INTEGER,
        lastMessageHops INTEGER,
        viaMqtt INTEGER,
        macaddr TEXT,
        latitude REAL,
        longitude REAL,
        altitude REAL,
        batteryLevel INTEGER,
        voltage REAL,
        channelUtilization REAL,
        airUtilTx REAL,
        lastHeard INTEGER,
        snr REAL,
        rssi INTEGER,
        lastTracerouteRequest INTEGER,
        firmwareVersion TEXT,
        channel INTEGER,
        isFavorite INTEGER DEFAULT 0,
        favoriteLocked INTEGER DEFAULT 0,
        isIgnored INTEGER DEFAULT 0,
        mobile INTEGER DEFAULT 0,
        rebootCount INTEGER,
        publicKey TEXT,
        lastMeshReceivedKey TEXT,
        hasPKC INTEGER,
        lastPKIPacket INTEGER,
        keyIsLowEntropy INTEGER,
        duplicateKeyDetected INTEGER,
        keyMismatchDetected INTEGER,
        keySecurityIssueDetails TEXT,
        isExcessivePackets INTEGER DEFAULT 0,
        packetRatePerHour INTEGER,
        packetRateLastChecked INTEGER,
        isTimeOffsetIssue INTEGER DEFAULT 0,
        timeOffsetSeconds INTEGER,
        welcomedAt INTEGER,
        positionChannel INTEGER,
        positionPrecisionBits INTEGER,
        positionGpsAccuracy REAL,
        positionHdop REAL,
        positionTimestamp INTEGER,
        positionOverrideEnabled INTEGER DEFAULT 0,
        latitudeOverride REAL,
        longitudeOverride REAL,
        altitudeOverride REAL,
        positionOverrideIsPrivate INTEGER DEFAULT 0,
        hasRemoteAdmin INTEGER DEFAULT 0,
        lastRemoteAdminCheck INTEGER,
        remoteAdminMetadata TEXT,
        lastTimeSync INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        sourceId TEXT
      )
    `);
    const { drizzle: drizzleSqlite } = require('drizzle-orm/better-sqlite3');
    drizzleDb = drizzleSqlite(db, { schema });
    repo = new NodesRepository(drizzleDb, 'sqlite');
  });

  it('stores sourceId when provided to upsertNode', async () => {
    await repo.upsertNode(
      { nodeNum: 1, nodeId: '!00000001', longName: 'Test', createdAt: 1000, updatedAt: 1000 },
      'source-abc'
    );
    const row = db.prepare('SELECT sourceId FROM nodes WHERE nodeNum = 1').get() as any;
    expect(row.sourceId).toBe('source-abc');
  });

  it('leaves sourceId NULL when not provided (backward compat)', async () => {
    await repo.upsertNode(
      { nodeNum: 2, nodeId: '!00000002', longName: 'Test2', createdAt: 1000, updatedAt: 1000 }
    );
    const row = db.prepare('SELECT sourceId FROM nodes WHERE nodeNum = 2').get() as any;
    expect(row.sourceId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
./node_modules/.bin/vitest run src/db/repositories/sourceScope.test.ts
```

Expected: FAIL — "Expected 'source-abc' but received null"

- [ ] **Step 3: Update NodesRepository.upsertNode signature and insert path**

In `src/db/repositories/nodes.ts`, change `upsertNode`:

```typescript
async upsertNode(nodeData: Partial<DbNode>, sourceId?: string): Promise<void> {
```

In the INSERT path (inside the `else` block that builds `newNode`), add `sourceId` conditionally:

```typescript
  const newNode: any = {
    nodeNum: nodeData.nodeNum,
    nodeId: nodeData.nodeId,
    // ... all existing fields unchanged ...
    createdAt: now,
    updatedAt: now,
  };
  // Only include sourceId when explicitly provided — backward-compat with callers
  // that don't pass sourceId (column stays NULL for legacy single-source mode).
  if (sourceId) {
    newNode.sourceId = sourceId;
  }
```

Do NOT add `sourceId` to the `upsertSet` used in the UPDATE path — once a node is associated with a source, that association should not change on subsequent upserts.

- [ ] **Step 4: Run the nodes sourceId tests**

```bash
./node_modules/.bin/vitest run src/db/repositories/sourceScope.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Add sourceId tests for MessagesRepository**

Append to `src/db/repositories/sourceScope.test.ts`:

```typescript
import { MessagesRepository } from './messages.js';

describe('MessagesRepository sourceId support', () => {
  let db: Database.Database;
  let drizzleDb: any;
  let repo: MessagesRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        nodeNum INTEGER PRIMARY KEY,
        nodeId TEXT NOT NULL UNIQUE,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        fromNodeNum INTEGER NOT NULL REFERENCES nodes(nodeNum),
        toNodeNum INTEGER NOT NULL REFERENCES nodes(nodeNum),
        fromNodeId TEXT NOT NULL,
        toNodeId TEXT NOT NULL,
        text TEXT NOT NULL,
        channel INTEGER NOT NULL DEFAULT 0,
        portnum INTEGER,
        requestId INTEGER,
        timestamp INTEGER NOT NULL,
        rxTime INTEGER,
        hopStart INTEGER,
        hopLimit INTEGER,
        relayNode INTEGER,
        replyId INTEGER,
        emoji INTEGER,
        viaMqtt INTEGER,
        rxSnr REAL,
        rxRssi REAL,
        ackFailed INTEGER,
        routingErrorReceived INTEGER,
        deliveryState TEXT,
        wantAck INTEGER,
        ackFromNode INTEGER,
        createdAt INTEGER NOT NULL,
        decrypted_by TEXT,
        sourceId TEXT
      )
    `);
    db.exec(`INSERT INTO nodes (nodeNum, nodeId, createdAt, updatedAt) VALUES (1, '!00000001', 1000, 1000)`);
    db.exec(`INSERT INTO nodes (nodeNum, nodeId, createdAt, updatedAt) VALUES (4294967295, '!FFFFFFFF', 1000, 1000)`);
    const { drizzle: drizzleSqlite } = require('drizzle-orm/better-sqlite3');
    drizzleDb = drizzleSqlite(db, { schema });
    repo = new MessagesRepository(drizzleDb, 'sqlite');
  });

  it('stores sourceId when provided to insertMessage', async () => {
    const msg = {
      id: 'msg-1', fromNodeNum: 1, toNodeNum: 4294967295,
      fromNodeId: '!00000001', toNodeId: '!FFFFFFFF',
      text: 'hello', channel: 0, timestamp: 1000, createdAt: 1000,
    } as any;
    await repo.insertMessage(msg, 'source-xyz');
    const row = db.prepare('SELECT sourceId FROM messages WHERE id = ?').get('msg-1') as any;
    expect(row.sourceId).toBe('source-xyz');
  });

  it('leaves sourceId NULL when not provided', async () => {
    const msg = {
      id: 'msg-2', fromNodeNum: 1, toNodeNum: 4294967295,
      fromNodeId: '!00000001', toNodeId: '!FFFFFFFF',
      text: 'world', channel: 0, timestamp: 1001, createdAt: 1001,
    } as any;
    await repo.insertMessage(msg);
    const row = db.prepare('SELECT sourceId FROM messages WHERE id = ?').get('msg-2') as any;
    expect(row.sourceId).toBeNull();
  });
});
```

- [ ] **Step 6: Confirm new message tests fail**

```bash
./node_modules/.bin/vitest run src/db/repositories/sourceScope.test.ts
```

Expected: FAIL on message sourceId tests.

- [ ] **Step 7: Update MessagesRepository.insertMessage**

In `src/db/repositories/messages.ts`, change `insertMessage`:

```typescript
async insertMessage(messageData: DbMessage, sourceId?: string): Promise<boolean> {
```

In the `values` object inside `insertMessage`, add sourceId conditionally after the existing fields:

```typescript
    const values: any = {
      id: messageData.id,
      fromNodeNum: messageData.fromNodeNum,
      toNodeNum: messageData.toNodeNum,
      fromNodeId: messageData.fromNodeId,
      toNodeId: messageData.toNodeId,
      text: messageData.text,
      channel: messageData.channel,
      portnum: messageData.portnum ?? null,
      requestId: messageData.requestId ?? null,
      timestamp: messageData.timestamp,
      rxTime: messageData.rxTime ?? null,
      hopStart: messageData.hopStart ?? null,
      hopLimit: messageData.hopLimit ?? null,
      relayNode: messageData.relayNode ?? null,
      replyId: messageData.replyId ?? null,
      emoji: messageData.emoji ?? null,
      viaMqtt: messageData.viaMqtt ?? null,
      rxSnr: messageData.rxSnr ?? null,
      rxRssi: messageData.rxRssi ?? null,
      ackFailed: messageData.ackFailed ?? null,
      routingErrorReceived: messageData.routingErrorReceived ?? null,
      deliveryState: messageData.deliveryState ?? null,
      wantAck: messageData.wantAck ?? null,
      ackFromNode: messageData.ackFromNode ?? null,
      createdAt: messageData.createdAt,
      decryptedBy: messageData.decryptedBy ?? null,
    };
    if (sourceId) {
      values.sourceId = sourceId;
    }

    const result = await this.insertIgnore(messages, values);
    return this.getAffectedRows(result) > 0;
```

Note: Change `const values = {` to `const values: any = {` and remove the existing `const result = await this.insertIgnore(messages, values);` line (it will be re-added after the conditional sourceId block above).

- [ ] **Step 8: Run all sourceScope tests**

```bash
./node_modules/.bin/vitest run src/db/repositories/sourceScope.test.ts
```

Expected: All tests PASS.

- [ ] **Step 9: Run the full test suite**

```bash
./node_modules/.bin/vitest run 2>&1 | tail -10
```

Expected: All tests PASS. (Existing nodes.test.ts, messages.bigint.test.ts etc. still pass because they don't use the sourceId parameter.)

- [ ] **Step 10: Commit**

```bash
git add src/db/repositories/nodes.ts src/db/repositories/messages.ts src/db/repositories/sourceScope.test.ts
git commit -m "feat(4.0/phase2): add sourceId to NodesRepository.upsertNode + MessagesRepository.insertMessage"
```

---

## Task 5: Update remaining repositories and assign NULL rows to default source

**Files:**
- Modify: `src/db/repositories/telemetry.ts`
- Modify: `src/db/repositories/traceroutes.ts`
- Modify: `src/db/repositories/channels.ts`
- Modify: `src/db/repositories/neighbors.ts`
- Modify: `src/db/repositories/misc.ts`
- Modify: `src/db/repositories/ignoredNodes.ts`
- Modify: `src/db/repositories/channelDatabase.ts`
- Modify: `src/db/repositories/sources.ts`
- Modify: `src/server/server.ts`

**Pattern for every repository** (same approach as Task 4):
1. Add `sourceId?: string` to the insert/upsert method signature
2. Change the `values` object to `const values: any = {...}` (if not already typed as `any`)
3. After the values object, add: `if (sourceId) { values.sourceId = sourceId; }`

### 5a: TelemetryRepository

- [ ] **Step 1: Update `insertTelemetry` in `src/db/repositories/telemetry.ts`**

```typescript
async insertTelemetry(telemetryData: DbTelemetry, sourceId?: string): Promise<void> {
```

Inside the method, change the `values` construction. Find the existing `values` object (after the `const { telemetry } = this.tables;` line), change it to `any` type, and append:
```typescript
  if (sourceId) {
    values.sourceId = sourceId;
  }
```

### 5b: TraceroutesRepository

- [ ] **Step 2: Update `insertTraceroute` in `src/db/repositories/traceroutes.ts`**

```typescript
async insertTraceroute(tracerouteData: DbTraceroute, sourceId?: string): Promise<void> {
```

Add the same `if (sourceId) { values.sourceId = sourceId; }` pattern before the insert call.

### 5c: ChannelsRepository

- [ ] **Step 3: Update `upsertChannel` in `src/db/repositories/channels.ts`**

```typescript
async upsertChannel(channelData: ChannelInput, sourceId?: string): Promise<void> {
```

Add `if (sourceId) { values.sourceId = sourceId; }` (or `newChannel.sourceId = sourceId` if values is inlined as a literal). If the insert uses a literal object, change it to a declared `const values: any = {...}` first.

### 5d: NeighborsRepository

- [ ] **Step 4: Update `upsertNeighborInfo` and `insertNeighborInfoBatch` in `src/db/repositories/neighbors.ts`**

```typescript
async upsertNeighborInfo(neighborData: DbNeighborInfo, sourceId?: string): Promise<void> {
```

```typescript
async insertNeighborInfoBatch(records: DbNeighborInfo[], sourceId?: string): Promise<void> {
```

For `upsertNeighborInfo`, add `if (sourceId) { values.sourceId = sourceId; }` before the insert.

For `insertNeighborInfoBatch`, propagate sourceId to each record's values: when building the batch values array, conditionally add `sourceId` to each item.

### 5e: MiscRepository (packet log)

- [ ] **Step 5: Update `insertPacketLog` in `src/db/repositories/misc.ts`**

```typescript
async insertPacketLog(packet: Omit<DbPacketLog, 'id' | 'created_at'>, sourceId?: string): Promise<number> {
```

Add `if (sourceId) { values.sourceId = sourceId; }` before the insert call.

### 5f: IgnoredNodesRepository

- [ ] **Step 6: Update `addIgnoredNodeAsync` in `src/db/repositories/ignoredNodes.ts`**

```typescript
async addIgnoredNodeAsync(nodeNum: number, sourceId?: string): Promise<void> {
```

(Exact signature depends on current implementation — add `sourceId?: string` as last parameter.) Add `if (sourceId) { values.sourceId = sourceId; }` before the insert.

### 5g: ChannelDatabaseRepository

- [ ] **Step 7: Update `createAsync` in `src/db/repositories/channelDatabase.ts`**

```typescript
async createAsync(data: ChannelDatabaseInput, sourceId?: string): Promise<number> {
```

Add `if (sourceId) { values.sourceId = sourceId; }` before the insert call.

### 5h: Type-check after repository updates

- [ ] **Step 8: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: No errors. Fix any type issues before continuing.

### 5i: Add `assignNullSourceIds` to SourcesRepository

This method runs a bulk UPDATE to assign all NULL sourceId rows to the specified source. It uses raw SQL via `executeRun` for efficiency across all 9 tables.

- [ ] **Step 9: Add `assignNullSourceIds` to `src/db/repositories/sources.ts`**

```typescript
  /**
   * Assign all rows with NULL sourceId to the specified source.
   *
   * Called during server startup after the default source is created/confirmed,
   * to migrate legacy data from single-source mode. Safe to call multiple times
   * (subsequent calls update 0 rows).
   *
   * @param sourceId - UUID of the source to assign NULL rows to
   */
  async assignNullSourceIds(sourceId: string): Promise<void> {
    const dataTables = [
      'nodes', 'messages', 'telemetry', 'traceroutes',
      'channels', 'neighbor_info', 'packet_log', 'ignored_nodes', 'channel_database',
    ];

    for (const table of dataTables) {
      try {
        if (this.isPostgres()) {
          await this.executeRun(
            sql`UPDATE ${sql.raw(table)} SET "sourceId" = ${sourceId} WHERE "sourceId" IS NULL`
          );
        } else {
          await this.executeRun(
            sql`UPDATE ${sql.raw(table)} SET sourceId = ${sourceId} WHERE sourceId IS NULL`
          );
        }
      } catch (err: any) {
        // Column may not exist if migration 021 hasn't run yet (e.g., first boot before migration)
        if (err?.message?.includes('no column named sourceId') ||
            err?.message?.includes('Unknown column')) {
          logger.debug(`assignNullSourceIds: sourceId column not yet in ${table}, skipping`);
        } else {
          logger.warn(`assignNullSourceIds: unexpected error on ${table}:`, err?.message);
        }
      }
    }
  }
```

Also add the `sql` import from `drizzle-orm` at the top of `sources.ts` if not already present:
```typescript
import { eq, sql } from 'drizzle-orm';
```

And add the `logger` import if not already present:
```typescript
import { logger } from '../../utils/logger.js';
```

### 5j: Call `assignNullSourceIds` in server.ts

- [ ] **Step 10: Update `src/server/server.ts`**

Find the existing auto-create block (~line 499-513):

```typescript
    // Auto-create default source if none exist
    const sourceCount = await databaseService.sources.getSourceCount();
    if (sourceCount === 0) {
      const env = getEnvironmentConfig();
      if (env.meshtasticNodeIp) {
        await databaseService.sources.createSource({
          id: uuidv4(),
          name: 'Default',
          type: 'meshtastic_tcp',
          config: { host: env.meshtasticNodeIp, port: env.meshtasticTcpPort },
          enabled: true,
        });
        logger.info(`📡 Auto-created default source from environment config`);
      }
    }
```

Replace with:

```typescript
    // Auto-create default source if none exist
    const sourceCount = await databaseService.sources.getSourceCount();
    if (sourceCount === 0) {
      const env = getEnvironmentConfig();
      if (env.meshtasticNodeIp) {
        await databaseService.sources.createSource({
          id: uuidv4(),
          name: 'Default',
          type: 'meshtastic_tcp',
          config: { host: env.meshtasticNodeIp, port: env.meshtasticTcpPort },
          enabled: true,
        });
        logger.info(`📡 Auto-created default source from environment config`);
      }
    }

    // Assign legacy NULL-sourceId rows to the default source (Phase 2 data migration).
    // Safe to run every startup — updates 0 rows after the first run.
    const allSources = await databaseService.sources.getAllSources();
    if (allSources.length > 0) {
      const defaultSource = allSources[0];
      await databaseService.sources.assignNullSourceIds(defaultSource.id);
      logger.debug(`Assigned NULL sourceId rows to default source ${defaultSource.id}`);
    }
```

### 5k: Final verification

- [ ] **Step 11: Type-check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: No errors.

- [ ] **Step 12: Run the full test suite**

```bash
./node_modules/.bin/vitest run 2>&1 | tail -15
```

Expected: All tests PASS — zero failures, zero type errors.

- [ ] **Step 13: Commit**

```bash
git add \
  src/db/repositories/telemetry.ts \
  src/db/repositories/traceroutes.ts \
  src/db/repositories/channels.ts \
  src/db/repositories/neighbors.ts \
  src/db/repositories/misc.ts \
  src/db/repositories/ignoredNodes.ts \
  src/db/repositories/channelDatabase.ts \
  src/db/repositories/sources.ts \
  src/server/server.ts
git commit -m "feat(4.0/phase2): add sourceId to remaining repos + assign NULL rows to default source on startup"
```

---

## Self-Review

### Spec Coverage

| Spec requirement | Task |
|-----------------|------|
| Add `source_id` columns via migration | Task 1 |
| `BaseRepository.withSourceScope()` | Task 3 |
| All repository methods accept `sourceId` | Tasks 4 + 5 |
| Assign existing data to default source | Task 5j |
| Tests pass, single-node behavior unchanged | All tasks (optional param, conditional insert) |

### Gaps Fixed

- Migration 021 adds composite indexes on the 3 most-queried tables (nodes, messages, telemetry). Phase 3 can add the remaining table indexes when those query paths are hot.
- `routeSegments` table is NOT in the 9 data tables per spec — traceroutes are tracked at the traceroute level only.
- `channelDatabasePermissions` table is NOT scoped — permissions are per-user, not per-source.
- `assignNullSourceIds` is safe to call on every startup (idempotent: subsequent calls update 0 rows). The try/catch handles the migration-not-yet-run edge case.
