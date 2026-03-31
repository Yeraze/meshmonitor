# Database Architecture Remediation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the N×3 complexity explosion, fix active data corruption bugs, and establish sustainable patterns for MeshMonitor's three-database architecture.

**Architecture:** Drizzle ORM requires separate table definitions per dialect — that's correct and stays. The fix is a runtime "active schema" map in BaseRepository that resolves the right table objects once at construction, eliminating 440+ three-way branches in repositories. Combined with a migration registry, raw SQL elimination, and DatabaseService decomposition, this reduces the maintenance surface by ~60%.

**Tech Stack:** Drizzle ORM 0.45.1, TypeScript, better-sqlite3, pg, mysql2, Vitest

---

## Phase Overview

| Phase | Title | Risk | Effort | Independent? |
|-------|-------|------|--------|-------------|
| 0 | Fix Active BIGINT Bugs | **Critical** — active data corruption | Small (1 PR) | Yes |
| 1 | Active Schema Map | Medium — core refactor | Large (1 PR) | Yes |
| 2 | Migration Registry | Low — reduces human error | Medium (1 PR) | Yes |
| 3 | Eliminate Raw SQL Schema Files | Medium — removes drift source | **Large** (1-2 PRs, ~46 migration backfills) | After Phase 2 |
| 4 | DatabaseService Decomposition | Low — code organization | Large (multiple PRs) | After Phase 1 |
| 5 | Test Infrastructure | Low — improves safety net | Medium (1 PR) | Yes |

Each phase is a separate branch and PR. Phases 0, 1, 2, and 5 can run in parallel. Phase 3 depends on Phase 2. Phase 4 depends on Phase 1.

---

## Phase 0: Fix Active BIGINT Bugs

**Goal:** Fix `messages.relayNode` and `messages.ackFromNode` columns that use INTEGER in PG/MySQL but hold nodeNum values (unsigned 32-bit, max 4,294,967,295 — exceeds signed 32-bit max of 2,147,483,647).

> **Migration number warning:** This plan uses migration number 087. Before implementing, verify that no other branch has claimed 087. Check with: `ls src/server/migrations/087*`. If 087 is taken, increment to the next available number.

**Files:**
- Create: `src/server/migrations/087_fix_message_nodenum_bigint.ts`
- Modify: `src/db/schema/messages.ts:57,68,89,100`
- Modify: `src/services/database.ts` (add migration imports + calls)
- Modify: `src/db/schema/postgres-create.ts` (update raw SQL)
- Modify: `src/db/schema/mysql-create.ts` (update raw SQL)
- Test: `src/db/repositories/messages.bigint.test.ts`

### Task 0.1: Update Schema Definitions

- [ ] **Step 1: Fix messages.ts PostgreSQL schema**

In `src/db/schema/messages.ts`, line 57, change:
```typescript
relayNode: pgInteger('relayNode'),
```
to:
```typescript
relayNode: pgBigint('relayNode', { mode: 'number' }),
```

And line 68, change:
```typescript
ackFromNode: pgInteger('ackFromNode'),
```
to:
```typescript
ackFromNode: pgBigint('ackFromNode', { mode: 'number' }),
```

- [ ] **Step 2: Fix messages.ts MySQL schema**

In `src/db/schema/messages.ts`, line 89, change:
```typescript
relayNode: myInt('relayNode'),
```
to:
```typescript
relayNode: myBigint('relayNode', { mode: 'number' }),
```

And line 100, change:
```typescript
ackFromNode: myInt('ackFromNode'),
```
to:
```typescript
ackFromNode: myBigint('ackFromNode', { mode: 'number' }),
```

- [ ] **Step 3: Update raw SQL files**

In `src/db/schema/postgres-create.ts`, find the messages CREATE TABLE and change `relayNode INTEGER` to `relayNode BIGINT` and `ackFromNode INTEGER` to `ackFromNode BIGINT`.

Same changes in `src/db/schema/mysql-create.ts`.

### Task 0.2: Write Migration

- [ ] **Step 4: Create migration file**

Create `src/server/migrations/087_fix_message_nodenum_bigint.ts`:
```typescript
/**
 * Migration 087: Fix relayNode and ackFromNode to BIGINT
 *
 * These columns hold nodeNum values (unsigned 32-bit, max 4,294,967,295)
 * which exceeds signed 32-bit INTEGER max of 2,147,483,647.
 * SQLite INTEGER is already 64-bit, so no change needed there.
 *
 * Reference: Same pattern as migrations 075 and 077.
 */
import type { PoolClient } from 'pg';
import type { Pool as MySQLPool } from 'mysql2/promise';

// SQLite: No-op (INTEGER is already 64-bit)
export const migration = {
  up: (_db: any) => { /* SQLite INTEGER handles full range */ },
  down: (_db: any) => { /* No-op */ },
};

export async function runMigration087Postgres(client: PoolClient): Promise<void> {
  // Check current type before altering (idempotent)
  const relayCheck = await client.query(`
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'relayNode'
  `);
  if (relayCheck.rows.length > 0 && relayCheck.rows[0].data_type === 'integer') {
    await client.query('ALTER TABLE messages ALTER COLUMN "relayNode" TYPE BIGINT');
  }

  const ackCheck = await client.query(`
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'ackFromNode'
  `);
  if (ackCheck.rows.length > 0 && ackCheck.rows[0].data_type === 'integer') {
    await client.query('ALTER TABLE messages ALTER COLUMN "ackFromNode" TYPE BIGINT');
  }
}

export async function runMigration087Mysql(pool: MySQLPool): Promise<void> {
  const [relayRows]: any = await pool.query(`
    SELECT DATA_TYPE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'relayNode'
  `);
  if (relayRows.length > 0 && relayRows[0].DATA_TYPE === 'int') {
    await pool.query('ALTER TABLE messages MODIFY COLUMN relayNode BIGINT');
  }

  const [ackRows]: any = await pool.query(`
    SELECT DATA_TYPE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'ackFromNode'
  `);
  if (ackRows.length > 0 && ackRows[0].DATA_TYPE === 'int') {
    await pool.query('ALTER TABLE messages MODIFY COLUMN ackFromNode BIGINT');
  }
}
```

- [ ] **Step 5: Register migration in database.ts**

Add import near line 94 of `src/services/database.ts`:
```typescript
import { runMigration087Postgres, runMigration087Mysql } from '../server/migrations/087_fix_message_nodenum_bigint.js';
```

Add call in `createPostgresSchema()` after the migration 086 call:
```typescript
await runMigration087Postgres(client);
```

Add call in `createMySQLSchema()` after the migration 086 call:
```typescript
await runMigration087Mysql(pool);
```

SQLite initialize() needs no change (no-op migration).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema/messages.ts src/server/migrations/087_fix_message_nodenum_bigint.ts src/services/database.ts src/db/schema/postgres-create.ts src/db/schema/mysql-create.ts
git commit -m "fix: upgrade messages.relayNode and ackFromNode to BIGINT for PG/MySQL

These columns hold nodeNum values (unsigned 32-bit) which exceed signed
INTEGER max. Same root cause as #1967 and #1973."
```

### Task 0.3: Test

- [ ] **Step 7: Run unit tests**

```bash
npm test
```
Expected: All 2972+ tests pass.

- [ ] **Step 8: Run system tests**

```bash
docker compose -f docker-compose.dev.yml down
tests/system-tests.sh
```
Expected: All three backends pass.

---

## Phase 1: Active Schema Map (Eliminate Repository Branching)

**Goal:** Replace 440+ three-way if/else branches in repositories with a single-path query using a runtime-resolved table map.

**Key Insight:** Drizzle's query builder API is identical across dialects at runtime. The only difference is which table object you pass to `.from()`. By storing the active table objects once at construction, every method collapses from 3 branches to 1.

**Type Safety Trade-off:** The active table references use `any` typing since Drizzle's table types are dialect-specific. Runtime behavior is identical and return types are already cast to unified `Db*` interfaces. This trades compile-time table reference checking (which was never catching bugs anyway — the bugs come from schema drift, not wrong table references) for a 60% code reduction.

**Files:**
- Create: `src/db/activeSchema.ts` — Runtime table map builder
- Modify: `src/db/repositories/base.ts` — Add active schema + unified `db` accessor
- Modify: All 13 repository files in `src/db/repositories/` — Collapse branching
- Test: `src/db/activeSchema.test.ts`
- Test: `src/db/repositories/nodes.test.ts` (update existing or create)

### Task 1.1: Create Active Schema Map

- [ ] **Step 1: Write failing test for activeSchema**

Create `src/db/activeSchema.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildActiveSchema } from './activeSchema.js';
import { nodesSqlite, nodesPostgres, nodesMysql } from './schema/nodes.js';
import { messagesSqlite, messagesPostgres, messagesMysql } from './schema/messages.js';

describe('buildActiveSchema', () => {
  it('returns SQLite tables for sqlite type', () => {
    const schema = buildActiveSchema('sqlite');
    expect(schema.nodes).toBe(nodesSqlite);
    expect(schema.messages).toBe(messagesSqlite);
  });

  it('returns PostgreSQL tables for postgres type', () => {
    const schema = buildActiveSchema('postgres');
    expect(schema.nodes).toBe(nodesPostgres);
    expect(schema.messages).toBe(messagesPostgres);
  });

  it('returns MySQL tables for mysql type', () => {
    const schema = buildActiveSchema('mysql');
    expect(schema.nodes).toBe(nodesMysql);
    expect(schema.messages).toBe(messagesMysql);
  });

  it('includes all table groups', () => {
    const schema = buildActiveSchema('sqlite');
    // Verify every table group is present
    const expectedTables = [
      // nodes.ts
      'nodes',
      // messages.ts
      'messages',
      // channels.ts
      'channels',
      // telemetry.ts
      'telemetry',
      // traceroutes.ts
      'traceroutes', 'routeSegments',
      // settings.ts
      'settings',
      // neighbors.ts
      'neighborInfo',
      // auth.ts
      'users', 'permissions', 'sessions', 'auditLog', 'apiTokens',
      // notifications.ts
      'pushSubscriptions', 'userNotificationPreferences', 'readMessages',
      // packets.ts
      'packetLog',
      // misc.ts
      'backupHistory', 'systemBackupHistory', 'customThemes',
      'userMapPreferences', 'upgradeHistory', 'solarEstimates',
      'autoTracerouteNodes', 'autoTimeSyncNodes', 'newsCache', 'userNewsStatus',
      // channelDatabase.ts
      'channelDatabase', 'channelDatabasePermissions',
      // ignoredNodes.ts
      'ignoredNodes',
      // meshcoreNodes.ts, meshcoreMessages.ts
      'meshcoreNodes', 'meshcoreMessages',
      // embedProfiles.ts
      'embedProfiles',
    ];
    for (const table of expectedTables) {
      expect(schema).toHaveProperty(table);
      expect(schema[table]).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/activeSchema.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement activeSchema.ts**

Create `src/db/activeSchema.ts`:
```typescript
/**
 * Active Schema Map
 *
 * Resolves the correct dialect-specific Drizzle table objects at runtime.
 * This eliminates the need for 3-way branching in every repository method.
 *
 * Usage:
 *   const tables = buildActiveSchema('postgres');
 *   db.select().from(tables.nodes).where(eq(tables.nodes.nodeNum, 123));
 */
import { DatabaseType } from './types.js';

// Import all triple-defined schemas
import { nodesSqlite, nodesPostgres, nodesMysql } from './schema/nodes.js';
import { messagesSqlite, messagesPostgres, messagesMysql } from './schema/messages.js';
import { channelsSqlite, channelsPostgres, channelsMysql } from './schema/channels.js';
import { telemetrySqlite, telemetryPostgres, telemetryMysql } from './schema/telemetry.js';
import {
  traceroutesSqlite, traceroutesPostgres, traceroutesMysql,
  routeSegmentsSqlite, routeSegmentsPostgres, routeSegmentsMysql,
} from './schema/traceroutes.js';
import { settingsSqlite, settingsPostgres, settingsMysql } from './schema/settings.js';
import { neighborInfoSqlite, neighborInfoPostgres, neighborInfoMysql } from './schema/neighbors.js';
import {
  usersSqlite, usersPostgres, usersMysql,
  permissionsSqlite, permissionsPostgres, permissionsMysql,
  sessionsSqlite, sessionsPostgres, sessionsMysql,
  auditLogSqlite, auditLogPostgres, auditLogMysql,
  apiTokensSqlite, apiTokensPostgres, apiTokensMysql,
} from './schema/auth.js';
import {
  pushSubscriptionsSqlite, pushSubscriptionsPostgres, pushSubscriptionsMysql,
  userNotificationPreferencesSqlite, userNotificationPreferencesPostgres, userNotificationPreferencesMysql,
  readMessagesSqlite, readMessagesPostgres, readMessagesMysql,
} from './schema/notifications.js';
import { packetLogSqlite, packetLogPostgres, packetLogMysql } from './schema/packets.js';
import {
  upgradeHistorySqlite, upgradeHistoryPostgres, upgradeHistoryMysql,
  backupHistorySqlite, backupHistoryPostgres, backupHistoryMysql,
  systemBackupHistorySqlite, systemBackupHistoryPostgres, systemBackupHistoryMysql,
  customThemesSqlite, customThemesPostgres, customThemesMysql,
  userMapPreferencesSqlite, userMapPreferencesPostgres, userMapPreferencesMysql,
  solarEstimatesSqlite, solarEstimatesPostgres, solarEstimatesMysql,
  autoTracerouteNodesSqlite, autoTracerouteNodesPostgres, autoTracerouteNodesMysql,
  autoTimeSyncNodesSqlite, autoTimeSyncNodesPostgres, autoTimeSyncNodesMysql,
  newsCacheSqlite, newsCachePostgres, newsCacheMysql,
  userNewsStatusSqlite, userNewsStatusPostgres, userNewsStatusMysql,
} from './schema/misc.js';
import {
  channelDatabaseSqlite, channelDatabasePostgres, channelDatabaseMysql,
  channelDatabasePermissionsSqlite, channelDatabasePermissionsPostgres, channelDatabasePermissionsMysql,
} from './schema/channelDatabase.js';
import { ignoredNodesSqlite, ignoredNodesPostgres, ignoredNodesMysql } from './schema/ignoredNodes.js';
import { meshcoreNodesSqlite, meshcoreNodesPostgres, meshcoreNodesMysql } from './schema/meshcoreNodes.js';
import { meshcoreMessagesSqlite, meshcoreMessagesPostgres, meshcoreMessagesMysql } from './schema/meshcoreMessages.js';
import { embedProfilesSqlite, embedProfilesPostgres, embedProfilesMysql } from './schema/embedProfiles.js';

/**
 * The active schema type — uses `any` for table references because Drizzle's
 * dialect-specific table types are incompatible at compile time, but the query
 * builder API is identical at runtime. Return types are already cast to
 * unified Db* interfaces in repositories.
 */
export interface ActiveSchema {
  // nodes.ts
  nodes: any;
  // messages.ts
  messages: any;
  // channels.ts
  channels: any;
  // telemetry.ts
  telemetry: any;
  // traceroutes.ts
  traceroutes: any;
  routeSegments: any;
  // settings.ts
  settings: any;
  // neighbors.ts
  neighborInfo: any;
  // auth.ts
  users: any;
  permissions: any;
  sessions: any;
  auditLog: any;
  apiTokens: any;
  // notifications.ts
  pushSubscriptions: any;
  userNotificationPreferences: any;
  readMessages: any;
  // packets.ts
  packetLog: any;
  // misc.ts
  upgradeHistory: any;
  backupHistory: any;
  systemBackupHistory: any;
  customThemes: any;
  userMapPreferences: any;
  solarEstimates: any;
  autoTracerouteNodes: any;
  autoTimeSyncNodes: any;
  newsCache: any;
  userNewsStatus: any;
  // channelDatabase.ts
  channelDatabase: any;
  channelDatabasePermissions: any;
  // ignoredNodes.ts
  ignoredNodes: any;
  // meshcoreNodes.ts, meshcoreMessages.ts
  meshcoreNodes: any;
  meshcoreMessages: any;
  // embedProfiles.ts
  embedProfiles: any;
  [key: string]: any;
}

const SCHEMA_MAP: Record<DatabaseType, ActiveSchema> = {
  sqlite: {
    nodes: nodesSqlite,
    messages: messagesSqlite,
    channels: channelsSqlite,
    telemetry: telemetrySqlite,
    traceroutes: traceroutesSqlite,
    routeSegments: routeSegmentsSqlite,
    settings: settingsSqlite,
    neighborInfo: neighborInfoSqlite,
    users: usersSqlite,
    permissions: permissionsSqlite,
    sessions: sessionsSqlite,
    auditLog: auditLogSqlite,
    apiTokens: apiTokensSqlite,
    pushSubscriptions: pushSubscriptionsSqlite,
    userNotificationPreferences: userNotificationPreferencesSqlite,
    readMessages: readMessagesSqlite,
    packetLog: packetLogSqlite,
    upgradeHistory: upgradeHistorySqlite,
    backupHistory: backupHistorySqlite,
    systemBackupHistory: systemBackupHistorySqlite,
    customThemes: customThemesSqlite,
    userMapPreferences: userMapPreferencesSqlite,
    solarEstimates: solarEstimatesSqlite,
    autoTracerouteNodes: autoTracerouteNodesSqlite,
    autoTimeSyncNodes: autoTimeSyncNodesSqlite,
    newsCache: newsCacheSqlite,
    userNewsStatus: userNewsStatusSqlite,
    channelDatabase: channelDatabaseSqlite,
    channelDatabasePermissions: channelDatabasePermissionsSqlite,
    ignoredNodes: ignoredNodesSqlite,
    meshcoreNodes: meshcoreNodesSqlite,
    meshcoreMessages: meshcoreMessagesSqlite,
    embedProfiles: embedProfilesSqlite,
  },
  postgres: {
    nodes: nodesPostgres,
    messages: messagesPostgres,
    channels: channelsPostgres,
    telemetry: telemetryPostgres,
    traceroutes: traceroutesPostgres,
    routeSegments: routeSegmentsPostgres,
    settings: settingsPostgres,
    neighborInfo: neighborInfoPostgres,
    users: usersPostgres,
    permissions: permissionsPostgres,
    sessions: sessionsPostgres,
    auditLog: auditLogPostgres,
    apiTokens: apiTokensPostgres,
    pushSubscriptions: pushSubscriptionsPostgres,
    userNotificationPreferences: userNotificationPreferencesPostgres,
    readMessages: readMessagesPostgres,
    packetLog: packetLogPostgres,
    upgradeHistory: upgradeHistoryPostgres,
    backupHistory: backupHistoryPostgres,
    systemBackupHistory: systemBackupHistoryPostgres,
    customThemes: customThemesPostgres,
    userMapPreferences: userMapPreferencesPostgres,
    solarEstimates: solarEstimatesPostgres,
    autoTracerouteNodes: autoTracerouteNodesPostgres,
    autoTimeSyncNodes: autoTimeSyncNodesPostgres,
    newsCache: newsCachePostgres,
    userNewsStatus: userNewsStatusPostgres,
    channelDatabase: channelDatabasePostgres,
    channelDatabasePermissions: channelDatabasePermissionsPostgres,
    ignoredNodes: ignoredNodesPostgres,
    meshcoreNodes: meshcoreNodesPostgres,
    meshcoreMessages: meshcoreMessagesPostgres,
    embedProfiles: embedProfilesPostgres,
  },
  mysql: {
    nodes: nodesMysql,
    messages: messagesMysql,
    channels: channelsMysql,
    telemetry: telemetryMysql,
    traceroutes: traceroutesMysql,
    routeSegments: routeSegmentsMysql,
    settings: settingsMysql,
    neighborInfo: neighborInfoMysql,
    users: usersMysql,
    permissions: permissionsMysql,
    sessions: sessionsMysql,
    auditLog: auditLogMysql,
    apiTokens: apiTokensMysql,
    pushSubscriptions: pushSubscriptionsMysql,
    userNotificationPreferences: userNotificationPreferencesMysql,
    readMessages: readMessagesMysql,
    packetLog: packetLogMysql,
    upgradeHistory: upgradeHistoryMysql,
    backupHistory: backupHistoryMysql,
    systemBackupHistory: systemBackupHistoryMysql,
    customThemes: customThemesMysql,
    userMapPreferences: userMapPreferencesMysql,
    solarEstimates: solarEstimatesMysql,
    autoTracerouteNodes: autoTracerouteNodesMysql,
    autoTimeSyncNodes: autoTimeSyncNodesMysql,
    newsCache: newsCacheMysql,
    userNewsStatus: userNewsStatusMysql,
    channelDatabase: channelDatabaseMysql,
    channelDatabasePermissions: channelDatabasePermissionsMysql,
    ignoredNodes: ignoredNodesMysql,
    meshcoreNodes: meshcoreNodesMysql,
    meshcoreMessages: meshcoreMessagesMysql,
    embedProfiles: embedProfilesMysql,
  },
};

export function buildActiveSchema(dbType: DatabaseType): ActiveSchema {
  return SCHEMA_MAP[dbType];
}
```

> **Note for implementer:** The export names in this plan have been verified against the actual schema files as of 2026-03-16. If new schema files are added before implementation, check `src/db/schema/index.ts` for any new exports and add them to the map.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/activeSchema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/activeSchema.ts src/db/activeSchema.test.ts
git commit -m "feat: add active schema map for runtime table resolution"
```

### Task 1.2: Update BaseRepository

- [ ] **Step 6: Modify base.ts to add active schema and unified db accessor**

Replace the three nullable DB fields with a single `db` reference and an `ActiveSchema`:

```typescript
import { buildActiveSchema, ActiveSchema } from '../activeSchema.js';

export abstract class BaseRepository {
  protected readonly dbType: DatabaseType;
  protected readonly tables: ActiveSchema;

  // Keep typed accessors for the few methods that need raw driver access
  // (raw SQL, upserts, dialect-specific syntax)
  protected readonly sqliteDb: SQLiteDrizzle | null;
  protected readonly postgresDb: PostgresDrizzle | null;
  protected readonly mysqlDb: MySQLDrizzle | null;

  // Unified db accessor — typed as `any` because Drizzle's dialect types
  // are incompatible at compile time but identical at runtime for query building
  protected readonly db: any;

  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    this.dbType = dbType;
    this.db = db;
    this.tables = buildActiveSchema(dbType);

    // Keep typed accessors for raw SQL escape hatches
    if (dbType === 'sqlite') {
      this.sqliteDb = db as SQLiteDrizzle;
      this.postgresDb = null;
      this.mysqlDb = null;
    } else if (dbType === 'postgres') {
      this.sqliteDb = null;
      this.postgresDb = db as PostgresDrizzle;
      this.mysqlDb = null;
    } else {
      this.sqliteDb = null;
      this.postgresDb = null;
      this.mysqlDb = db as MySQLDrizzle;
    }
  }

  // ... keep existing isSQLite/isPostgres/isMySQL and normalizeBigInts

  // WHEN TO USE TYPED ACCESSORS vs this.db:
  // - Use this.db + this.tables for standard Drizzle query builder operations
  //   (select, insert, update, delete with .from/.values/.set/.where)
  // - Use this.getSqliteDb()/getPostgresDb()/getMysqlDb() ONLY when you need:
  //   1. Raw SQL via db.execute() or db.run() (driver-specific API)
  //   2. Driver-specific result shapes (e.g., result.rowCount vs affectedRows)
  //   3. Dialect-specific SQL syntax (DISTINCT ON, INSERT IGNORE, etc.)
}
```

- [ ] **Step 7: Commit**

```bash
git add src/db/repositories/base.ts
git commit -m "feat: add unified db accessor and active schema to BaseRepository"
```

### Task 1.3: Convert One Repository as Proof of Concept

Convert `NodesRepository` first since it's the most representative.

- [ ] **Step 8: Convert simple query methods in nodes.ts**

Before (getNode — 33 lines, 3 branches):
```typescript
async getNode(nodeNum: number): Promise<DbNode | null> {
  if (this.isSQLite()) {
    const db = this.getSqliteDb();
    const result = await db.select().from(nodesSqlite).where(eq(nodesSqlite.nodeNum, nodeNum)).limit(1);
    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbNode;
  } else if (this.isMySQL()) {
    // ... identical except nodesMysql
  } else {
    // ... identical except nodesPostgres
  }
}
```

After (getNode — 6 lines, 0 branches):
```typescript
async getNode(nodeNum: number): Promise<DbNode | null> {
  const { nodes } = this.tables;
  const result = await this.db.select().from(nodes).where(eq(nodes.nodeNum, nodeNum)).limit(1);
  if (result.length === 0) return null;
  return this.normalizeBigInts(result[0]) as DbNode;
}
```

Apply this pattern to every method in `NodesRepository` where the only difference between branches is the table reference. Methods that have genuinely different SQL per backend (raw SQL with `DISTINCT ON`, etc.) should keep their branching but use `this.db` and `this.tables` where possible.

- [ ] **Step 9: Run full test suite**

```bash
npm test
```
Expected: All tests pass — no behavioral change.

- [ ] **Step 10: Run system tests**

```bash
docker compose -f docker-compose.dev.yml down
tests/system-tests.sh
```
Expected: All three backends pass.

- [ ] **Step 11: Commit**

```bash
git add src/db/repositories/nodes.ts
git commit -m "refactor: eliminate 3-way branching in NodesRepository via active schema"
```

### Task 1.4: Convert Remaining Repositories

Convert each remaining repository file one at a time, running tests after each:

- [ ] **Step 12:** Convert `src/db/repositories/settings.ts` → test → commit
- [ ] **Step 13:** Convert `src/db/repositories/channels.ts` → test → commit
- [ ] **Step 14:** Convert `src/db/repositories/messages.ts` → test → commit
- [ ] **Step 15:** Convert `src/db/repositories/telemetry.ts` → test → commit
- [ ] **Step 16:** Convert `src/db/repositories/traceroutes.ts` → test → commit
- [ ] **Step 17:** Convert `src/db/repositories/neighbors.ts` → test → commit
- [ ] **Step 18:** Convert `src/db/repositories/auth.ts` → test → commit
- [ ] **Step 19:** Convert `src/db/repositories/notifications.ts` → test → commit
- [ ] **Step 20:** Convert `src/db/repositories/misc.ts` → test → commit
- [ ] **Step 21:** Convert `src/db/repositories/channelDatabase.ts` → test → commit
- [ ] **Step 22:** Convert `src/db/repositories/ignoredNodes.ts` → test → commit
- [ ] **Step 23:** Convert `src/db/repositories/meshcore.ts` → test → commit
- [ ] **Step 24:** Convert `src/db/repositories/embedProfiles.ts` → test → commit

**Pattern for each conversion:**

1. Open the repository file
2. Remove direct schema imports (e.g., `import { nodesSqlite, nodesPostgres, nodesMysql }`)
3. For each method:
   - If the three branches are identical except for table reference → collapse to single path using `this.tables.xxx` and `this.db`
   - If branches have genuinely different SQL (raw SQL, `DISTINCT ON`, upsert syntax differences) → keep branching but simplify where possible using `this.tables` for the table references
4. Run `npm test` after each file
5. Commit each file individually

**Methods that MUST keep branching** (genuinely different SQL per dialect):
- `telemetry.ts`: `getLatestTelemetryValue()` — uses `DISTINCT ON` on Postgres vs `MAX()` subquery
- `messages.ts`: `searchMessages()` — uses `instr()` on SQLite, `BINARY LIKE` on MySQL, `LIKE` on Postgres
- `notifications.ts`: upsert methods — different `ON CONFLICT` / `INSERT IGNORE` syntax
- `nodes.ts`: `getEligibleNodesForTraceroute()` — raw SQL with quoted vs unquoted columns
- Any method using `(result as any).affectedRows` vs `result.rowCount`

For these ~15 methods, use this pattern:
```typescript
async someMethod(): Promise<Result> {
  const { nodes } = this.tables;
  // Shared query building...
  if (this.isSQLite()) {
    // SQLite-specific raw SQL only
  } else if (this.isMySQL()) {
    // MySQL-specific raw SQL only
  } else {
    // Postgres-specific raw SQL only
  }
}
```

- [ ] **Step 25: Final system test**

```bash
docker compose -f docker-compose.dev.yml down
tests/system-tests.sh
```
Expected: All three backends pass.

- [ ] **Step 26: Commit and create PR**

---

## Phase 2: Migration Registry

**Goal:** Replace the flat 85-line call chain in `initialize()` and the manual import/call pattern in `createPostgresSchema()`/`createMySQLSchema()` with a declarative registry that prevents the class of bug seen in PR #2301.

**Files:**
- Create: `src/db/migrationRegistry.ts`
- Modify: `src/services/database.ts` (replace flat call chains with registry loop)
- Test: `src/db/migrationRegistry.test.ts`

### Task 2.1: Design the Registry

- [ ] **Step 1: Write failing test**

Create `src/db/migrationRegistry.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { MigrationRegistry } from './migrationRegistry.js';

describe('MigrationRegistry', () => {
  it('registers and returns migrations in order', () => {
    const registry = new MigrationRegistry();
    const sqlite1 = () => {};
    const sqlite2 = () => {};
    registry.register({ number: 1, name: 'first', sqlite: sqlite1 });
    registry.register({ number: 2, name: 'second', sqlite: sqlite2 });

    const migrations = registry.getAll();
    expect(migrations).toHaveLength(2);
    expect(migrations[0].number).toBe(1);
    expect(migrations[1].number).toBe(2);
  });

  it('prevents duplicate registration', () => {
    const registry = new MigrationRegistry();
    registry.register({ number: 1, name: 'first', sqlite: () => {} });
    expect(() => {
      registry.register({ number: 1, name: 'duplicate', sqlite: () => {} });
    }).toThrow('Migration 1 already registered');
  });

  it('enforces sequential numbering', () => {
    const registry = new MigrationRegistry();
    registry.register({ number: 1, name: 'first', sqlite: () => {} });
    expect(() => {
      registry.register({ number: 3, name: 'skipped', sqlite: () => {} });
    }).toThrow('Migration 3 registered out of order');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/migrationRegistry.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement migrationRegistry.ts**

Create `src/db/migrationRegistry.ts`:
```typescript
/**
 * Migration Registry
 *
 * Declarative registry for database migrations. Prevents:
 * - Missing migrations (compile-time: all must be registered)
 * - Ordering bugs (enforces sequential numbering)
 * - Duplicate registrations (throws on duplicate number)
 * - Forgotten call sites (single loop replaces per-migration calls)
 */

export interface MigrationEntry {
  number: number;
  name: string;
  /** SQLite migration function. Called with (db, getSetting, setSetting) */
  sqlite?: (db: any, getSetting: (key: string) => string | null, setSetting: (key: string, value: string) => void) => void;
  /** PostgreSQL migration function. Called with (client) */
  postgres?: (client: any) => Promise<void>;
  /** MySQL migration function. Called with (pool) */
  mysql?: (pool: any) => Promise<void>;
  /** Settings key for SQLite idempotency tracking */
  settingsKey?: string;
  /**
   * If true, the SQLite migration handles its own idempotency internally
   * (e.g., old-style migrations 001-046 that check sqlite_master or
   * have CREATE TABLE IF NOT EXISTS). The registry loop will call
   * the sqlite function without checking/setting the settingsKey.
   */
  selfIdempotent?: boolean;
}

export class MigrationRegistry {
  private migrations: MigrationEntry[] = [];
  private registered = new Set<number>();

  register(entry: MigrationEntry): void {
    if (this.registered.has(entry.number)) {
      throw new Error(`Migration ${entry.number} already registered: ${entry.name}`);
    }
    if (this.migrations.length > 0) {
      const last = this.migrations[this.migrations.length - 1];
      if (entry.number !== last.number + 1) {
        throw new Error(
          `Migration ${entry.number} registered out of order (expected ${last.number + 1})`
        );
      }
    }
    this.registered.add(entry.number);
    this.migrations.push(entry);
  }

  getAll(): ReadonlyArray<MigrationEntry> {
    return this.migrations;
  }

  getFrom(startNumber: number): ReadonlyArray<MigrationEntry> {
    return this.migrations.filter(m => m.number >= startNumber);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/migrationRegistry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/migrationRegistry.ts src/db/migrationRegistry.test.ts
git commit -m "feat: add migration registry with ordering and duplicate prevention"
```

### Task 2.2: Populate Registry and Replace Call Chains

This is the largest task in Phase 2. It involves:

1. Creating a `src/db/migrations.ts` file that imports all 87 migration files and registers them
2. Replacing the flat call chain in `initialize()` with a registry loop
3. Replacing the sequential calls in `createPostgresSchema()` and `createMySQLSchema()` with registry loops

- [ ] **Step 6: Create migrations.ts barrel that registers all migrations**

Create `src/db/migrations.ts` that imports all migration files and registers them into a singleton registry instance. Each registration maps the migration number to its sqlite/postgres/mysql functions.

> **Note for implementer:** This file will be ~300 lines of imports and registrations. Follow the exact import names from the current `database.ts` imports (lines 13-94). For old-style migrations (001-046), the sqlite function is `migration.up`. For new-style (047+), use the named exports `runMigrationNNNSqlite/Postgres/Mysql`.

- [ ] **Step 7: Replace initialize() call chain**

In `database.ts`, replace the 85-line sequence of `this.runXxxMigration()` calls with:

```typescript
import { registry } from '../db/migrations.js';

// In initialize():
for (const migration of registry.getAll()) {
  if (!migration.sqlite) continue;

  if (migration.selfIdempotent) {
    // Old-style migrations (001-046) handle their own idempotency
    migration.sqlite(this.db, this.getSetting.bind(this), this.setSetting.bind(this));
  } else if (migration.settingsKey) {
    // New-style migrations use settings key guard
    if (this.getSetting(migration.settingsKey) !== 'completed') {
      migration.sqlite(this.db, this.getSetting.bind(this), this.setSetting.bind(this));
      this.setSetting(migration.settingsKey, 'completed');
    }
  }
}
```

> **Note for implementer:** The old-style migrations (001-046) have their own idempotency checks inside `migration.up()`. For these, the `settingsKey` may be omitted and the sqlite function called unconditionally (matching current behavior). Study each migration's current call site to determine whether it uses a settings key guard.

- [ ] **Step 8: Replace createPostgresSchema() call chain**

```typescript
// In createPostgresSchema():
for (const migration of registry.getFrom(47)) {
  if (migration.postgres) {
    await migration.postgres(client);
  }
}
```

- [ ] **Step 9: Replace createMySQLSchema() call chain**

Same pattern as Postgres.

- [ ] **Step 10: Run full test suite + system tests**

```bash
npm test
docker compose -f docker-compose.dev.yml down
tests/system-tests.sh
```

- [ ] **Step 11: Commit**

```bash
git commit -m "refactor: replace flat migration call chains with declarative registry

Prevents the class of bug from PR #2301 where migrations 083/084 were
skipped due to an early return in migration 082's method."
```

---

## Phase 3: Eliminate Raw SQL Schema Files

**Goal:** Remove `postgres-create.ts` and `mysql-create.ts` as sources of schema truth. These static SQL strings have drifted from Drizzle schemas repeatedly, causing migrations 047, 052, 056, and 085 to exist solely as drift fixes.

**Approach:** Use `drizzle-kit` to generate the initial CREATE TABLE SQL from the Drizzle schema files, or generate the SQL at runtime. This ensures a single source of truth.

**Files:**
- Modify: `src/db/schema/postgres-create.ts` — Replace hand-written SQL with generated SQL
- Modify: `src/db/schema/mysql-create.ts` — Same
- Create: `src/db/generateSchema.ts` — Script to generate CREATE TABLE SQL from Drizzle schemas
- Modify: `src/services/database.ts` — Use generated SQL in `createPostgresSchema()` and `createMySQLSchema()`

**Depends on:** Phase 2 (migration registry), because the migration registry changes how `createPostgresSchema` works.

### Task 3.1: Evaluate drizzle-kit push

- [ ] **Step 1: Test if drizzle-kit can generate SQL for each dialect**

```bash
npx drizzle-kit generate --dialect postgresql --schema src/db/schema/index.ts --out /tmp/drizzle-pg
npx drizzle-kit generate --dialect mysql --schema src/db/schema/index.ts --out /tmp/drizzle-mysql
```

Review the generated SQL. If it matches the current `POSTGRES_SCHEMA_SQL` / `MYSQL_SCHEMA_SQL` (modulo the drift), this is the path forward.

- [ ] **Step 2: Decide approach based on drizzle-kit output**

**Option A (preferred):** If drizzle-kit generates correct `CREATE TABLE IF NOT EXISTS` SQL, replace the static SQL strings with a build step that generates them.

**Option B:** If drizzle-kit output is incompatible, write a small TypeScript utility that reads the Drizzle schema objects and generates `CREATE TABLE IF NOT EXISTS` SQL for each dialect.

**Option C (simplest):** Remove `POSTGRES_SCHEMA_SQL` and `MYSQL_SCHEMA_SQL` entirely. For fresh installs, rely solely on the migration chain starting from migration 001. This means fresh Postgres/MySQL installs run all 87+ migrations instead of a bulk CREATE + migrations-from-047. This is slower for initial setup but eliminates the drift problem entirely.

> **Recommendation:** Option C is the simplest and most maintainable. The initial setup time increase is negligible (< 1 second for all migrations). The migration registry from Phase 2 makes this clean.

### Task 3.2: Add Drizzle Schema Definitions for Missing Tables

Five tables exist only in raw SQL with no Drizzle schema: `auto_traceroute_log`, `auto_key_repair_state`, `auto_key_repair_log`, `geofence_cooldowns`, `auto_distance_delete_log`.

- [ ] **Step 3: Create Drizzle schema definitions for each missing table**

For each table, create schema definitions in the appropriate existing schema file (e.g., `misc.ts`) following the triple-definition pattern. Match the column types exactly to the current raw SQL.

- [ ] **Step 4: Add the new schemas to activeSchema.ts (if Phase 1 complete)**

- [ ] **Step 5: Run tests + system tests**

- [ ] **Step 6: Commit**

### Task 3.3: Remove Raw SQL and Switch to Migration-Only Init

- [ ] **Step 7: Remove POSTGRES_SCHEMA_SQL and MYSQL_SCHEMA_SQL exports**

- [ ] **Step 8: Update createPostgresSchema() to run all migrations from 001**

- [ ] **Step 9: Update createMySQLSchema() to run all migrations from 001**

- [ ] **Step 10: Backfill Postgres/MySQL migration functions for migrations 001-046**

Many early migrations (001-046) only have SQLite `migration.up()` functions. Add `runMigrationNNNPostgres` and `runMigrationNNNMysql` functions for each one that performs the equivalent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` for that migration's changes.

> **Note for implementer:** This is the most labor-intensive step. Reference the current `POSTGRES_SCHEMA_SQL` to understand what each migration should produce for Postgres. Consider doing this incrementally — start with the tables that have the most drift.

- [ ] **Step 11: Run full test suite + system tests**

- [ ] **Step 12: Commit**

---

## Phase 4: DatabaseService Decomposition

**Goal:** Reduce `database.ts` from 14,107 lines by extracting the 136 `Async` wrapper methods and moving consumers to direct repository imports.

**Depends on:** Phase 1 (active schema map), because repository consumers need a stable API.

**This phase should be broken into sub-PRs:**

### Task 4.1: Audit Async Wrapper Usage

- [ ] **Step 1: Search for all `databaseService.xxxAsync(` calls across the codebase**

```bash
grep -rn 'databaseService\.\w*Async(' src/ --include='*.ts' --include='*.tsx' | wc -l
```

Catalog which wrappers are used and where. Group by repository domain.

- [ ] **Step 2: Search for direct repository access**

```bash
grep -rn 'databaseService\.\w*Repo\b' src/ --include='*.ts' --include='*.tsx'
```

Catalog which callers already bypass the facade.

### Task 4.2: Expose Repositories via Getter (Incremental Migration)

Rather than a big-bang rewrite, add typed getters that return repositories directly:

```typescript
// In database.ts
get nodes(): NodesRepository {
  if (!this.nodesRepo) throw new Error('Database not initialized');
  return this.nodesRepo;
}
```

Then incrementally migrate callers from `databaseService.getNodeAsync(nodeNum)` to `databaseService.nodes.getNode(nodeNum)`.

- [ ] **Step 3: Add typed getters for all repositories**
- [ ] **Step 4: Migrate callers one route file at a time**
- [ ] **Step 5: Remove Async wrapper methods that have zero remaining callers**
- [ ] **Step 6: Run tests after each route file migration**

### Task 4.3: Extract Migration Orchestration

- [ ] **Step 7: Move initialize(), createPostgresSchema(), createMySQLSchema() into a MigrationOrchestrator class**

This reduces `database.ts` to: driver initialization, repository instantiation, and public getters.

---

## Phase 5: Test Infrastructure

**Goal:** Add the testing infrastructure that would have caught the bugs found in this analysis.

**Files:**
- Create: `src/db/repositories/messages.bigint.test.ts`
- Create: `src/db/repositories/ignoredNodes.test.ts`
- Modify: `.github/workflows/test.yml` (add PostgreSQL service)
- Modify: `src/db/repositories/telemetry.multidb.test.ts` (fail instead of skip)

### Task 5.1: BIGINT Round-Trip Regression Tests

- [ ] **Step 1: Create BIGINT test for messages repository**

Create `src/db/repositories/messages.bigint.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
// Test that nodeNum values > 2^31 round-trip correctly
// Use the same in-memory SQLite setup as telemetry.test.ts

describe('Messages BIGINT round-trip', () => {
  const HIGH_NODE_NUM = 3_000_000_000; // > 2,147,483,647 (signed 32-bit max)

  it('stores and retrieves relayNode > 2^31', async () => {
    // Insert a message with high relayNode, retrieve it, verify value
  });

  it('stores and retrieves ackFromNode > 2^31', async () => {
    // Insert a message with high ackFromNode, retrieve it, verify value
  });
});
```

- [ ] **Step 2: Create test for ignoredNodes repository**

Test that `nodeNum` values > 2^31 work correctly in the ignored nodes table.

### Task 5.2: Add PostgreSQL to CI

- [ ] **Step 3: Add PostgreSQL service to GitHub Actions**

In `.github/workflows/test.yml`:
```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_USER: meshmonitor
      POSTGRES_PASSWORD: testpassword
      POSTGRES_DB: meshmonitor_test
    ports:
      - 5433:5432
    options: >-
      --health-cmd pg_isready
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

Set `DATABASE_URL=postgresql://meshmonitor:testpassword@localhost:5433/meshmonitor_test` for a separate test step that runs the multi-db tests.

### Task 5.3: Make Multi-DB Tests Fail Instead of Skip

- [ ] **Step 4: Update telemetry.multidb.test.ts**

Change the skip logic so that in CI (when `CI=true` env var is set), a missing Postgres container fails the test rather than silently skipping. Locally, skipping is fine.

```typescript
const REQUIRE_POSTGRES = process.env.CI === 'true';

describe.skipIf(!pgAvailable && !REQUIRE_POSTGRES)('PostgreSQL tests', () => {
  // ...
});

if (!pgAvailable && REQUIRE_POSTGRES) {
  it('FAIL: PostgreSQL required in CI but not available', () => {
    expect.fail('PostgreSQL service not running — check CI configuration');
  });
}
```

### Task 5.4: Schema Integrity Smoke Test

- [ ] **Step 5: Add a test that runs all migrations against in-memory SQLite and verifies key columns exist**

```typescript
describe('Migration integrity', () => {
  it('all migrations produce expected schema columns', () => {
    // Create in-memory SQLite DB
    // Run all migrations
    // Verify critical columns exist:
    //   nodes.lastMeshReceivedKey
    //   messages.relayNode
    //   messages.ackFromNode
    //   ignored_nodes.nodeNum
    //   telemetry.packetId
    // This would have caught the 082/083/084 skip bug
  });
});
```

---

## Schema Drift Issues to Fix (Opportunistic)

These should be addressed during the relevant phase but are not blockers:

| Issue | Fix In Phase |
|-------|-------------|
| `users.updatedAt` missing from SQLite schema | 3 (when backfilling migrations) |
| `permissions.canDelete` missing from SQLite schema | 3 |
| `permissions.grantedAt/grantedBy` missing from PG/MySQL | 3 |
| `notifyOnChannelMessage` missing from SQLite | 3 |
| SQLite `auth_provider` vs PG/MySQL `authMethod` column name | 3 (migration to rename) |
| SQLite snake_case vs PG/MySQL camelCase in auth tables | 3 (migration to standardize) |
| `neighbor_info.snr` REAL vs DOUBLE PRECISION | 0 or standalone migration |
| `backup_history.fileSize` INTEGER vs BIGINT | 0 or standalone migration |

---

## Success Metrics

| Metric | Before | After |
|--------|--------|-------|
| Three-way branches in repositories | ~440 | ~15 (only genuinely different SQL) |
| Lines in database.ts | 14,107 | ~3,000 (after Phase 4) |
| Migration call sites per new migration | 3 imports + 3 calls | 1 registration |
| Sources of schema truth | 2 (Drizzle + raw SQL) | 1 (Drizzle only) |
| BIGINT bugs in production | 2 known active | 0 |
| Multi-DB test coverage in CI | SQLite only | SQLite + PostgreSQL |
| Repositories with direct tests | 4/13 | 8/13 (minimum) |
