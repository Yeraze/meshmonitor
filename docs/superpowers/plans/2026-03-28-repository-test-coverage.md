# Repository Test Coverage Expansion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase repository test coverage from ~16% to 80%+ across all three database backends (SQLite, PostgreSQL, MySQL).

**Architecture:** Create shared test utilities for multi-backend testing, then systematically add tests for each repository. Each test file follows the `telemetry.multidb.test.ts` pattern: SQLite always runs, PostgreSQL/MySQL run when available (graceful skip otherwise). Tests focus on CRUD operations, edge cases, and backend-specific behavior (BigInt handling, column naming, upsert semantics).

**Tech Stack:** Vitest, better-sqlite3 (in-memory), pg (Pool), mysql2 (createPool), Drizzle ORM

**Coverage report baseline:** `src/db/repositories/` = 16.3% statement coverage

---

## Plan Structure

- **Part A** (Tasks 1-2): Test infrastructure — shared helpers, multi-backend factory
- **Part B** (Tasks 3-5): High-impact repositories — nodes, channels, notifications
- **Part C** (Tasks 6-9): Remaining repositories — settings, neighbors, traceroutes, ignoredNodes, channelDatabase

Each part is independently mergeable.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db/repositories/test-utils.ts` | Create | Shared multi-backend test factory and helpers |
| `src/db/repositories/settings.test.ts` | Create | Settings repository tests (simplest, validates factory) |
| `src/db/repositories/nodes.test.ts` | Create | Node CRUD, upsert, security flags, cleanup |
| `src/db/repositories/channels.test.ts` | Create | Channel CRUD, upsert, cleanup |
| `src/db/repositories/notifications.test.ts` | Create | Push subscriptions, preferences, read-marks |
| `src/db/repositories/neighbors.test.ts` | Create | Neighbor info CRUD, batch insert, cleanup, RSSI stats |
| `src/db/repositories/traceroutes.test.ts` | Create | Traceroute CRUD, route segments, cleanup |
| `src/db/repositories/ignoredNodes.test.ts` | Create | Ignored nodes CRUD |
| `src/db/repositories/channelDatabase.test.ts` | Create | Channel database entries and permissions |

---

## Part A: Test Infrastructure

### Task 1: Create Multi-Backend Test Factory

**Files:**
- Create: `src/db/repositories/test-utils.ts`

- [ ] **Step 1: Create the test utility file**

```typescript
/**
 * Multi-backend test utilities for repository tests.
 * Provides a factory that creates test database connections for SQLite, PostgreSQL, and MySQL.
 * SQLite always runs (in-memory). PG/MySQL run when available (graceful skip in dev, fail in CI).
 */
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';

export type DbType = 'sqlite' | 'postgres' | 'mysql';

export interface TestBackend {
  dbType: DbType;
  drizzleDb: any;
  /** Run raw SQL for setup/teardown */
  exec: (sql: string) => Promise<void>;
  /** Clean up connections */
  close: () => Promise<void>;
  /** Whether this backend is available */
  available: boolean;
  /** Skip message if unavailable */
  skipReason?: string;
}

/** Standard test PostgreSQL config (port 5433 to avoid dev conflicts) */
const PG_TEST_CONFIG = {
  host: process.env.TEST_PG_HOST || 'localhost',
  port: parseInt(process.env.TEST_PG_PORT || '5433'),
  user: process.env.TEST_PG_USER || 'meshmonitor',
  password: process.env.TEST_PG_PASSWORD || 'meshmonitor',
  database: process.env.TEST_PG_DATABASE || 'meshmonitor_test',
  connectionTimeoutMillis: 3000,
};

/** Standard test MySQL config */
const MYSQL_TEST_CONFIG = {
  host: process.env.TEST_MYSQL_HOST || 'localhost',
  port: parseInt(process.env.TEST_MYSQL_PORT || '3307'),
  user: process.env.TEST_MYSQL_USER || 'meshmonitor',
  password: process.env.TEST_MYSQL_PASSWORD || 'meshmonitor',
  database: process.env.TEST_MYSQL_DATABASE || 'meshmonitor_test',
  connectionLimit: 5,
};

/**
 * Create an in-memory SQLite test backend.
 * @param createTablesSql Raw SQL to create tables (SQLite dialect)
 */
export function createSqliteBackend(createTablesSql: string): TestBackend {
  const db = new Database(':memory:');
  db.exec(createTablesSql);
  const drizzleDb = drizzleSqlite(db, { schema });
  return {
    dbType: 'sqlite',
    drizzleDb,
    exec: async (sql: string) => { db.exec(sql); },
    close: async () => { db.close(); },
    available: true,
  };
}

/**
 * Try to create a PostgreSQL test backend.
 * Returns unavailable backend if PG is not running.
 * @param createTablesSql Raw SQL to create tables (PostgreSQL dialect)
 */
export async function createPostgresBackend(createTablesSql: string): Promise<TestBackend> {
  const pool = new Pool(PG_TEST_CONFIG);
  try {
    const client = await pool.connect();
    client.release();
    const drizzleDb = drizzlePg(pool, { schema });
    await pool.query(createTablesSql);
    return {
      dbType: 'postgres',
      drizzleDb,
      exec: async (sql: string) => { await pool.query(sql); },
      close: async () => { await pool.end(); },
      available: true,
    };
  } catch (error) {
    await pool.end().catch(() => {});
    const msg = `PostgreSQL not available at ${PG_TEST_CONFIG.host}:${PG_TEST_CONFIG.port}`;
    if (process.env.CI === 'true') {
      throw new Error(`${msg} (required in CI)`);
    }
    return {
      dbType: 'postgres',
      drizzleDb: null,
      exec: async () => {},
      close: async () => {},
      available: false,
      skipReason: msg,
    };
  }
}

/**
 * Try to create a MySQL test backend.
 * Returns unavailable backend if MySQL is not running.
 * @param createTablesSql Raw SQL to create tables (MySQL dialect)
 */
export async function createMysqlBackend(createTablesSql: string): Promise<TestBackend> {
  try {
    const pool = await mysql.createPool(MYSQL_TEST_CONFIG);
    const conn = await pool.getConnection();
    conn.release();
    const drizzleDb = drizzleMysql(pool, { schema, mode: 'default' });
    await pool.execute(createTablesSql);
    return {
      dbType: 'mysql',
      drizzleDb,
      exec: async (sql: string) => { await pool.execute(sql); },
      close: async () => { await pool.end(); },
      available: true,
    };
  } catch (error) {
    const msg = `MySQL not available at ${MYSQL_TEST_CONFIG.host}:${MYSQL_TEST_CONFIG.port}`;
    if (process.env.CI === 'true') {
      throw new Error(`${msg} (required in CI)`);
    }
    return {
      dbType: 'mysql',
      drizzleDb: null,
      exec: async () => {},
      close: async () => {},
      available: false,
      skipReason: msg,
    };
  }
}

/**
 * Helper: truncate/clear a table for test isolation.
 * Handles syntax differences across backends.
 */
export async function clearTable(backend: TestBackend, tableName: string): Promise<void> {
  if (!backend.available) return;
  if (backend.dbType === 'sqlite') {
    await backend.exec(`DELETE FROM ${tableName}`);
  } else if (backend.dbType === 'postgres') {
    await backend.exec(`TRUNCATE TABLE ${tableName} RESTART IDENTITY CASCADE`);
  } else {
    await backend.exec(`TRUNCATE TABLE ${tableName}`);
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Clean compilation

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/test-utils.ts
git commit -m "test: add multi-backend test factory for repository tests"
```

---

### Task 2: Validate Factory with Settings Repository Tests

**Files:**
- Create: `src/db/repositories/settings.test.ts`

Settings is the simplest repository (key-value pairs, no foreign keys) — perfect for validating the test factory works.

- [ ] **Step 1: Create settings test file**

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createSqliteBackend, createPostgresBackend, createMysqlBackend, clearTable, type TestBackend } from './test-utils.js';
import { SettingsRepository } from './settings.js';

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

const PG_SCHEMA = `
  DROP TABLE IF EXISTS settings CASCADE;
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

const MYSQL_SCHEMA = `
  DROP TABLE IF EXISTS settings;
  CREATE TABLE settings (
    \`key\` VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

function runSettingsTests(getBackend: () => TestBackend) {
  let repo: SettingsRepository;

  beforeEach(async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await clearTable(backend, 'settings');
    repo = new SettingsRepository(backend.drizzleDb, backend.dbType);
  });

  it('should set and get a setting', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await repo.setSetting('testKey', 'testValue');
    const result = await repo.getSetting('testKey');
    expect(result).toBe('testValue');
  });

  it('should return null for missing setting', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const result = await repo.getSetting('nonexistent');
    expect(result).toBeNull();
  });

  it('should overwrite existing setting', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await repo.setSetting('key1', 'value1');
    await repo.setSetting('key1', 'value2');
    expect(await repo.getSetting('key1')).toBe('value2');
  });

  it('should set multiple settings at once', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await repo.setSettings({ a: '1', b: '2', c: '3' });
    expect(await repo.getSetting('a')).toBe('1');
    expect(await repo.getSetting('b')).toBe('2');
    expect(await repo.getSetting('c')).toBe('3');
  });

  it('should get all settings', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await repo.setSettings({ x: '10', y: '20' });
    const all = await repo.getAllSettings();
    expect(all.x).toBe('10');
    expect(all.y).toBe('20');
  });

  it('should delete a setting', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await repo.setSetting('toDelete', 'value');
    await repo.deleteSetting('toDelete');
    expect(await repo.getSetting('toDelete')).toBeNull();
  });

  it('should check if setting exists', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await repo.setSetting('exists', 'yes');
    expect(await repo.hasSetting('exists')).toBe(true);
    expect(await repo.hasSetting('nope')).toBe(false);
  });

  it('should get setting with default', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const result = await repo.getSettingWithDefault('missing', 'fallback');
    expect(result).toBe('fallback');
  });

  it('should get setting as number', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await repo.setSetting('num', '42');
    expect(await repo.getSettingAsNumber('num')).toBe(42);
    expect(await repo.getSettingAsNumber('missing', 99)).toBe(99);
  });

  it('should get/set setting as boolean', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await repo.setSettingBoolean('flag', true);
    expect(await repo.getSettingAsBoolean('flag')).toBe(true);
    await repo.setSettingBoolean('flag', false);
    expect(await repo.getSettingAsBoolean('flag')).toBe(false);
  });

  it('should get/set setting as JSON', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const obj = { foo: 'bar', nums: [1, 2, 3] };
    await repo.setSettingJson('jsonKey', obj);
    const result = await repo.getSettingAsJson('jsonKey');
    expect(result).toEqual(obj);
  });

  it('should delete all settings', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await repo.setSettings({ a: '1', b: '2' });
    await repo.deleteAllSettings();
    const all = await repo.getAllSettings();
    expect(Object.keys(all).length).toBe(0);
  });
}

describe('SettingsRepository', () => {
  // === SQLite ===
  describe('SQLite', () => {
    let backend: TestBackend;
    beforeEach(() => {
      // Create fresh DB each test for isolation
      if (backend) backend.close();
      backend = createSqliteBackend(SQLITE_SCHEMA);
    });
    afterAll(async () => { if (backend) await backend.close(); });
    runSettingsTests(() => backend);
  });

  // === PostgreSQL ===
  describe('PostgreSQL', () => {
    let backend: TestBackend;
    beforeEach(async () => {
      if (!backend) {
        backend = await createPostgresBackend(PG_SCHEMA);
        if (!backend.available) return;
      }
      await clearTable(backend, 'settings');
    });
    afterAll(async () => { if (backend) await backend.close(); });
    runSettingsTests(() => backend);
  });

  // === MySQL ===
  describe('MySQL', () => {
    let backend: TestBackend;
    beforeEach(async () => {
      if (!backend) {
        backend = await createMysqlBackend(MYSQL_SCHEMA);
        if (!backend.available) return;
      }
      await clearTable(backend, 'settings');
    });
    afterAll(async () => { if (backend) await backend.close(); });
    runSettingsTests(() => backend);
  });
});
```

- [ ] **Step 2: Run tests (SQLite should pass, PG/MySQL skip gracefully)**

Run: `npx vitest run src/db/repositories/settings.test.ts`
Expected: SQLite tests PASS, PG/MySQL tests skip (unless running)

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/settings.test.ts
git commit -m "test: add settings repository tests across all backends"
```

---

## Part B: High-Impact Repositories

### Task 3: Nodes Repository Tests

**Files:**
- Create: `src/db/repositories/nodes.test.ts`

The nodes repository is the largest (865 lines, 30+ methods) and most critical. Focus on: upsert, get, security flags, cleanup, favorites.

- [ ] **Step 1: Create nodes test file**

Create `src/db/repositories/nodes.test.ts` with the multi-backend pattern. SQLite table schema:

```sql
CREATE TABLE nodes (
  nodeNum INTEGER PRIMARY KEY,
  nodeId TEXT,
  longName TEXT,
  shortName TEXT,
  lastHeard INTEGER,
  snr REAL,
  rssi INTEGER,
  channel INTEGER,
  hopsAway INTEGER,
  batteryLevel INTEGER,
  voltage REAL,
  channelUtilization REAL,
  airUtilTx REAL,
  latitude REAL,
  longitude REAL,
  altitude REAL,
  positionTimestamp INTEGER,
  positionPdop INTEGER,
  hwModel INTEGER,
  role INTEGER,
  publicKey TEXT,
  duplicateKeyDetected INTEGER DEFAULT 0,
  keyIsLowEntropy INTEGER DEFAULT 0,
  keySecurityIssueDetails TEXT,
  viaMqtt INTEGER DEFAULT 0,
  welcomed INTEGER DEFAULT 0,
  isFavorite INTEGER DEFAULT 0,
  favoriteLocked INTEGER DEFAULT 0,
  isIgnored INTEGER DEFAULT 0,
  mobile INTEGER,
  lastTracerouteRequest INTEGER,
  messageHops INTEGER,
  hasRemoteAdmin INTEGER,
  remoteAdminMetadata TEXT,
  lastRemoteAdminCheck INTEGER,
  lastTimeSyncSent INTEGER
)
```

Tests to include:
- `upsertNode` — insert new, update existing
- `getNode` — by nodeNum, returns null for missing
- `getNodeByNodeId` — by hex ID string
- `getNodesByNums` — batch fetch, returns Map
- `getAllNodes` / `getNodeCount`
- `updateNodeSecurityFlags` — duplicate key detection
- `updateNodeLowEntropyFlag`
- `setNodeFavorite` / `setNodeIgnored`
- `deleteNodeRecord`
- `cleanupInactiveNodes`
- `markAllNodesAsWelcomed`

Use the `runTests(getBackend)` pattern from Task 2. PostgreSQL schema uses `BIGINT` for nodeNum and quoted `"camelCase"` identifiers. MySQL schema uses `BIGINT` for nodeNum.

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/db/repositories/nodes.test.ts`
Expected: SQLite tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/nodes.test.ts
git commit -m "test: add nodes repository tests across all backends"
```

---

### Task 4: Channels Repository Tests

**Files:**
- Create: `src/db/repositories/channels.test.ts`

Channels is small (7 methods) — quick coverage win.

- [ ] **Step 1: Create channels test file**

Create `src/db/repositories/channels.test.ts`. SQLite schema:

```sql
CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  name TEXT,
  psk TEXT,
  role INTEGER DEFAULT 0,
  uplinkEnabled INTEGER DEFAULT 0,
  downlinkEnabled INTEGER DEFAULT 0,
  positionPrecision INTEGER DEFAULT 0
)
```

Tests to include:
- `upsertChannel` — insert and update
- `getChannelById` — found and not found
- `getAllChannels` / `getChannelCount`
- `deleteChannel`
- `cleanupInvalidChannels` — channels with no name/psk
- `cleanupEmptyChannels`

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/db/repositories/channels.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/channels.test.ts
git commit -m "test: add channels repository tests across all backends"
```

---

### Task 5: Notifications Repository Tests

**Files:**
- Create: `src/db/repositories/notifications.test.ts`

Notifications has push subscriptions, user preferences, and read-mark tracking.

- [ ] **Step 1: Create notifications test file**

Create `src/db/repositories/notifications.test.ts`. Requires `users` table (foreign key), `push_subscriptions` table, `user_notification_preferences` table, and `read_messages` table.

Tests to include:
- `saveSubscription` / `getUserSubscriptions` / `removeSubscription`
- `saveUserPreferences` / `getUserPreferences`
- `getUsersWithServiceEnabled` — 'web_push' and 'apprise'
- `getUsersWithAppriseEnabled`
- `markChannelMessagesAsRead` / `markDMMessagesAsRead`

Note: Read-mark tests need a `messages` table with test data.

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/db/repositories/notifications.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/notifications.test.ts
git commit -m "test: add notifications repository tests across all backends"
```

---

## Part C: Remaining Repositories

### Task 6: Neighbors Repository Tests

**Files:**
- Create: `src/db/repositories/neighbors.test.ts`

- [ ] **Step 1: Create neighbors test file**

Tests to include:
- `insertNeighborInfo` / `insertNeighborInfoBatch`
- `getNeighborsForNode` / `getAllNeighborInfo`
- `deleteNeighborInfoForNode`
- `getNeighborCount` / `getNeighborCountForNode`
- `cleanupOldNeighborInfo` — timestamp-based cleanup (uses milliseconds!)
- `getDirectNeighborRssiAsync` — aggregation from packet_log (needs packet_log table)

SQLite schema for neighbor_info:
```sql
CREATE TABLE neighbor_info (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nodeNum INTEGER NOT NULL,
  neighborNodeNum INTEGER NOT NULL,
  snr REAL,
  lastRxTime INTEGER,
  timestamp INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
)
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/db/repositories/neighbors.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/neighbors.test.ts
git commit -m "test: add neighbors repository tests across all backends"
```

---

### Task 7: Traceroutes Repository Tests

**Files:**
- Create: `src/db/repositories/traceroutes.test.ts`

- [ ] **Step 1: Create traceroutes test file**

Tests to include:
- `insertTraceroute` / `getAllTraceroutes`
- `findPendingTraceroute` / `updateTracerouteResponse`
- `getTraceroutesByNodes`
- `cleanupOldTraceroutes` — time-based cleanup
- `getTracerouteCount`
- `deleteTraceroutesForNode`
- `insertRouteSegment` / `getLongestActiveRouteSegment` / `getRecordHolderRouteSegment`
- `cleanupOldRouteSegments`

SQLite schema for traceroutes:
```sql
CREATE TABLE traceroutes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fromNodeNum INTEGER NOT NULL,
  toNodeNum INTEGER NOT NULL,
  fromNodeId TEXT,
  toNodeId TEXT,
  route TEXT,
  routeBack TEXT,
  snrTowards TEXT,
  snrBack TEXT,
  timestamp INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  status TEXT DEFAULT 'pending'
)
```

Route segments table:
```sql
CREATE TABLE route_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fromNodeNum INTEGER NOT NULL,
  toNodeNum INTEGER NOT NULL,
  fromNodeId TEXT,
  toNodeId TEXT,
  distanceKm REAL,
  isRecordHolder INTEGER DEFAULT 0,
  fromLatitude REAL,
  fromLongitude REAL,
  toLatitude REAL,
  toLongitude REAL,
  timestamp INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
)
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/db/repositories/traceroutes.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/traceroutes.test.ts
git commit -m "test: add traceroutes repository tests across all backends"
```

---

### Task 8: Ignored Nodes Repository Tests

**Files:**
- Create: `src/db/repositories/ignoredNodes.test.ts`

Smallest repository (4 methods) — easy coverage.

- [ ] **Step 1: Create ignored nodes test file**

Tests to include:
- `addIgnoredNodeAsync` — insert
- `removeIgnoredNodeAsync` — delete
- `getIgnoredNodesAsync` — list all
- `isNodeIgnoredAsync` — check exists

SQLite schema:
```sql
CREATE TABLE ignored_nodes (
  nodeNum INTEGER PRIMARY KEY,
  nodeId TEXT NOT NULL,
  longName TEXT,
  shortName TEXT,
  ignoredBy TEXT,
  ignoredAt INTEGER NOT NULL
)
```

Note: PostgreSQL/MySQL use `BIGINT` for nodeNum per the nodeNum BIGINT pattern.

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/db/repositories/ignoredNodes.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/ignoredNodes.test.ts
git commit -m "test: add ignored nodes repository tests across all backends"
```

---

### Task 9: Channel Database Repository Tests

**Files:**
- Create: `src/db/repositories/channelDatabase.test.ts`

Channel database stores custom channel definitions with PSK for retroactive decryption, plus per-user permissions.

- [ ] **Step 1: Create channel database test file**

Tests to include:
- `createAsync` / `getByIdAsync` / `getAllAsync`
- `getEnabledAsync`
- `updateAsync`
- `deleteAsync`
- `incrementDecryptedCountAsync`
- `reorderAsync`
- `setPermissionAsync` / `getPermissionAsync` / `getPermissionsForUserAsync`
- `deletePermissionAsync`

Requires `users` table (foreign key for permissions).

SQLite schema:
```sql
CREATE TABLE channel_database (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  psk TEXT NOT NULL,
  channelIndex INTEGER,
  isEnabled INTEGER DEFAULT 1,
  decryptedCount INTEGER DEFAULT 0,
  sortOrder INTEGER DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE channel_database_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channelDatabaseId INTEGER NOT NULL REFERENCES channel_database(id) ON DELETE CASCADE,
  canRead INTEGER DEFAULT 1,
  canWrite INTEGER DEFAULT 0,
  grantedAt INTEGER NOT NULL,
  UNIQUE(userId, channelDatabaseId)
)
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/db/repositories/channelDatabase.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/channelDatabase.test.ts
git commit -m "test: add channel database repository tests across all backends"
```

---

## Implementation Notes

### PostgreSQL Schema Differences
- Use quoted `"camelCase"` identifiers: `"nodeNum"`, `"longName"`, etc.
- Use `BIGINT` for nodeNum, neighborNodeNum, and other node number columns
- Use `BOOLEAN` instead of `INTEGER` for flags
- Use `SERIAL` instead of `INTEGER PRIMARY KEY AUTOINCREMENT`
- Use `TIMESTAMP` or `BIGINT` for timestamps

### MySQL Schema Differences
- Use backtick-quoted identifiers: `` `nodeNum` ``, `` `longName` ``
- Use `BIGINT` for node numbers
- Use `BOOLEAN` (alias for `TINYINT(1)`) for flags
- Use `AUTO_INCREMENT` instead of `AUTOINCREMENT`
- Use `INT` or `BIGINT` for timestamps

### BigInt Handling
- SQLite returns `BigInt` for BIGINT columns — always coerce with `Number()` in assertions
- PostgreSQL returns regular numbers for BIGINT
- MySQL returns `string` for BIGINT unless using `supportBigNumbers: true`

### Test Isolation
- SQLite: fresh in-memory DB per test (or `DELETE FROM` table)
- PostgreSQL: `TRUNCATE TABLE ... RESTART IDENTITY CASCADE`
- MySQL: `TRUNCATE TABLE`

### Running Tests
```bash
# SQLite only (always works)
npx vitest run src/db/repositories/settings.test.ts

# With PostgreSQL (start test DB first)
docker run -d --name pg-test -p 5433:5432 -e POSTGRES_USER=meshmonitor -e POSTGRES_PASSWORD=meshmonitor -e POSTGRES_DB=meshmonitor_test postgres:16

# With MySQL (start test DB first)
docker run -d --name mysql-test -p 3307:3306 -e MYSQL_ROOT_PASSWORD=root -e MYSQL_USER=meshmonitor -e MYSQL_PASSWORD=meshmonitor -e MYSQL_DATABASE=meshmonitor_test mysql:8

# Run all repository tests
npx vitest run src/db/repositories/
```

---

## Expected Outcome

| Repository | Before | After |
|-----------|--------|-------|
| settings | 6.7% | ~95% |
| nodes | 0.5% | ~70% |
| channels | 1.9% | ~90% |
| notifications | 0.6% | ~60% |
| neighbors | 2.4% | ~80% |
| traceroutes | 1.2% | ~70% |
| ignoredNodes | 6.7% | ~95% |
| channelDatabase | 1.5% | ~70% |
| **Category average** | **16.3%** | **~75%** |
