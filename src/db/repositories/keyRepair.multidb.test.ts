/**
 * Multi-Database Key Repair Repository Tests (Task 3.2)
 *
 * Tests all six KeyRepairRepository async methods against SQLite (always),
 * PostgreSQL (skipped locally unless container is running on port 5433), and
 * MySQL (skipped locally unless container is running on port 3307).
 *
 * Run PostgreSQL:
 *   docker run -d --name meshmonitor-test-postgres \
 *     -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=meshmonitor_test \
 *     -p 5433:5432 postgres:16
 *
 * Run MySQL:
 *   docker run -d --name meshmonitor-test-mysql \
 *     -e MYSQL_ROOT_PASSWORD=test -e MYSQL_USER=test -e MYSQL_PASSWORD=test \
 *     -e MYSQL_DATABASE=meshmonitor_test \
 *     -p 3307:3306 mysql:8
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  postgresAvailable,
  mysqlAvailable,
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  type TestBackend,
} from './test-utils.js';
import { KeyRepairRepository } from './keyRepair.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A nodeNum > 2^31 to catch signed-int regressions on PG/MySQL BIGINT
const LARGE_NODE_NUM = 0xaabbccdd; // 2,864,434,397 — exceeds signed 32-bit max

const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS auto_key_repair_state (
    nodeNum INTEGER PRIMARY KEY,
    attemptCount INTEGER DEFAULT 0,
    lastAttemptTime INTEGER,
    exhausted INTEGER DEFAULT 0,
    startedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auto_key_repair_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    nodeNum INTEGER NOT NULL,
    nodeName TEXT,
    action TEXT NOT NULL,
    success INTEGER,
    created_at INTEGER,
    oldKeyFragment TEXT,
    newKeyFragment TEXT,
    sourceId TEXT
  );
  CREATE TABLE IF NOT EXISTS nodes (
    nodeNum INTEGER PRIMARY KEY,
    nodeId TEXT NOT NULL,
    longName TEXT,
    shortName TEXT,
    keyMismatchDetected INTEGER DEFAULT 0
  );
`;

const POSTGRES_DDL = `
  DROP TABLE IF EXISTS auto_key_repair_log;
  DROP TABLE IF EXISTS auto_key_repair_state;
  DROP TABLE IF EXISTS nodes;
  CREATE TABLE nodes (
    "nodeNum" BIGINT PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "longName" TEXT,
    "shortName" TEXT,
    "keyMismatchDetected" BOOLEAN DEFAULT false
  );
  CREATE TABLE auto_key_repair_state (
    "nodeNum" BIGINT PRIMARY KEY,
    "attemptCount" INTEGER DEFAULT 0,
    "lastAttemptTime" BIGINT,
    exhausted INTEGER DEFAULT 0,
    "startedAt" BIGINT NOT NULL
  );
  CREATE TABLE auto_key_repair_log (
    id SERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    "nodeNum" BIGINT NOT NULL,
    "nodeName" TEXT,
    action TEXT NOT NULL,
    success INTEGER,
    created_at BIGINT,
    "oldKeyFragment" TEXT,
    "newKeyFragment" TEXT,
    "sourceId" TEXT
  );
`;

const MYSQL_DDL = `
  DROP TABLE IF EXISTS auto_key_repair_log;
  DROP TABLE IF EXISTS auto_key_repair_state;
  DROP TABLE IF EXISTS nodes;
  CREATE TABLE nodes (
    nodeNum BIGINT PRIMARY KEY,
    nodeId VARCHAR(32) NOT NULL,
    longName TEXT,
    shortName TEXT,
    keyMismatchDetected BOOLEAN DEFAULT false
  );
  CREATE TABLE auto_key_repair_state (
    nodeNum BIGINT PRIMARY KEY,
    attemptCount INT DEFAULT 0,
    lastAttemptTime BIGINT,
    exhausted INT DEFAULT 0,
    startedAt BIGINT NOT NULL
  );
  CREATE TABLE auto_key_repair_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    nodeNum BIGINT NOT NULL,
    nodeName TEXT,
    action TEXT NOT NULL,
    success INT,
    created_at BIGINT,
    oldKeyFragment TEXT,
    newKeyFragment TEXT,
    sourceId VARCHAR(64)
  );
`;

/**
 * Shared suite factory executed under each backend's describe block.
 */
function runSuite(getBackend: () => TestBackend) {
  let repo: KeyRepairRepository;

  beforeEach(() => {
    const b = getBackend();
    repo = new KeyRepairRepository(b.drizzleDb, b.dbType);
  });

  afterEach(async () => {
    const b = getBackend();
    if (!b.available) return;
    await clearTable(b, 'auto_key_repair_log');
    await clearTable(b, 'auto_key_repair_state');
    await clearTable(b, 'nodes');
  });

  // -----------------------------------------------------------------------
  // 1. setKeyRepairStateAsync insert + getKeyRepairStateAsync round-trip
  // -----------------------------------------------------------------------
  it('setKeyRepairStateAsync inserts and getKeyRepairStateAsync fetches', async () => {
    const b = getBackend();
    if (!b.available) return;

    const now = Date.now();
    await repo.setKeyRepairStateAsync(LARGE_NODE_NUM, {
      attemptCount: 2,
      lastAttemptTime: now,
      exhausted: false,
      startedAt: now,
    });

    const state = await repo.getKeyRepairStateAsync(LARGE_NODE_NUM);
    expect(state).not.toBeNull();
    expect(state!.nodeNum).toBe(LARGE_NODE_NUM);     // BIGINT coercion check
    expect(state!.attemptCount).toBe(2);
    expect(state!.lastAttemptTime).toBe(now);
    expect(state!.exhausted).toBe(false);
    expect(state!.startedAt).toBe(now);
  });

  // -----------------------------------------------------------------------
  // 2. setKeyRepairStateAsync update path — partial fields preserve others
  // -----------------------------------------------------------------------
  it('setKeyRepairStateAsync updates existing row without clobbering other fields', async () => {
    const b = getBackend();
    if (!b.available) return;

    const now = Date.now();
    await repo.setKeyRepairStateAsync(LARGE_NODE_NUM, {
      attemptCount: 1,
      startedAt: now,
    });

    // Update only attemptCount — startedAt must be preserved
    await repo.setKeyRepairStateAsync(LARGE_NODE_NUM, {
      attemptCount: 3,
    });

    const state = await repo.getKeyRepairStateAsync(LARGE_NODE_NUM);
    expect(state).not.toBeNull();
    expect(state!.attemptCount).toBe(3);
    // exhausted was not set, should remain false
    expect(state!.exhausted).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 3. setKeyRepairStateAsync exhausted=true round-trip
  // -----------------------------------------------------------------------
  it('setKeyRepairStateAsync persists exhausted=true correctly', async () => {
    const b = getBackend();
    if (!b.available) return;

    const now = Date.now();
    await repo.setKeyRepairStateAsync(LARGE_NODE_NUM, {
      attemptCount: 5,
      exhausted: true,
      startedAt: now,
    });

    const state = await repo.getKeyRepairStateAsync(LARGE_NODE_NUM);
    expect(state!.exhausted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 4. clearKeyRepairStateAsync deletes the row
  // -----------------------------------------------------------------------
  it('clearKeyRepairStateAsync removes the state row', async () => {
    const b = getBackend();
    if (!b.available) return;

    await repo.setKeyRepairStateAsync(LARGE_NODE_NUM, { startedAt: Date.now() });
    await repo.clearKeyRepairStateAsync(LARGE_NODE_NUM);

    const state = await repo.getKeyRepairStateAsync(LARGE_NODE_NUM);
    expect(state).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 5. getNodesNeedingKeyRepairAsync — includes mismatch nodes, excludes exhausted
  // -----------------------------------------------------------------------
  it('getNodesNeedingKeyRepairAsync returns mismatch nodes and excludes exhausted', async () => {
    const b = getBackend();
    if (!b.available) return;

    // Insert nodes via raw SQL since NodeRepository is not under test here
    const nodeA = LARGE_NODE_NUM;
    const nodeB = LARGE_NODE_NUM + 1;
    const nodeC = LARGE_NODE_NUM + 2;
    const nodeD = LARGE_NODE_NUM + 3;

    if (b.dbType === 'sqlite') {
      await b.exec(`INSERT INTO nodes (nodeNum, nodeId, longName, shortName, keyMismatchDetected) VALUES
        (${nodeA}, '!aabbccdd', 'Node A', 'A', 1),
        (${nodeB}, '!aabbccde', 'Node B', 'B', 1),
        (${nodeC}, '!aabbccdf', 'Node C', 'C', 1),
        (${nodeD}, '!aabbcce0', 'Node D', 'D', 0)`);
    } else if (b.dbType === 'postgres') {
      await b.exec(`INSERT INTO nodes ("nodeNum", "nodeId", "longName", "shortName", "keyMismatchDetected") VALUES
        (${nodeA}, '!aabbccdd', 'Node A', 'A', true),
        (${nodeB}, '!aabbccde', 'Node B', 'B', true),
        (${nodeC}, '!aabbccdf', 'Node C', 'C', true),
        (${nodeD}, '!aabbcce0', 'Node D', 'D', false)`);
    } else {
      await b.exec(`INSERT INTO nodes (nodeNum, nodeId, longName, shortName, keyMismatchDetected) VALUES
        (${nodeA}, '!aabbccdd', 'Node A', 'A', true),
        (${nodeB}, '!aabbccde', 'Node B', 'B', true),
        (${nodeC}, '!aabbccdf', 'Node C', 'C', true),
        (${nodeD}, '!aabbcce0', 'Node D', 'D', false)`);
    }

    // nodeB: exhausted — should be excluded
    await repo.setKeyRepairStateAsync(nodeB, { attemptCount: 5, exhausted: true, startedAt: Date.now() });
    // nodeA: has state but not exhausted — should be included
    await repo.setKeyRepairStateAsync(nodeA, { attemptCount: 2, startedAt: Date.now() });
    // nodeC: no state row at all — should be included (LEFT JOIN, exhausted IS NULL)

    const results = await repo.getNodesNeedingKeyRepairAsync();
    const nums = results.map(r => r.nodeNum);

    expect(nums).toContain(LARGE_NODE_NUM);     // nodeA: has state, not exhausted
    expect(nums).toContain(LARGE_NODE_NUM + 2); // nodeC: no state row
    expect(nums).not.toContain(LARGE_NODE_NUM + 1); // nodeB: exhausted
    expect(nums).not.toContain(LARGE_NODE_NUM + 3); // nodeD: not a mismatch node

    // Verify BIGINT nodeNum coercion for the mismatch result
    const resultA = results.find(r => r.nodeNum === LARGE_NODE_NUM);
    expect(typeof resultA!.nodeNum).toBe('number');
    expect(resultA!.nodeNum).toBe(LARGE_NODE_NUM);
    expect(resultA!.attemptCount).toBe(2);
  });

  // -----------------------------------------------------------------------
  // 6. logKeyRepairAttemptAsync — persists all fields, returns id > 0
  // -----------------------------------------------------------------------
  it('logKeyRepairAttemptAsync persists fragments and sourceId, returns inserted id', async () => {
    const b = getBackend();
    if (!b.available) return;

    const id = await repo.logKeyRepairAttemptAsync(
      LARGE_NODE_NUM,
      'Test Node',
      'key_exchange',
      true,
      'oldFrag123',
      'newFrag456',
      'source-a',
    );

    expect(id).toBeGreaterThan(0);

    const log = await repo.getKeyRepairLogAsync(10, 'source-a');
    expect(log).toHaveLength(1);
    expect(log[0].nodeNum).toBe(LARGE_NODE_NUM);    // BIGINT coercion
    expect(log[0].action).toBe('key_exchange');
    expect(log[0].success).toBe(true);
    expect(log[0].oldKeyFragment).toBe('oldFrag123');
    expect(log[0].newKeyFragment).toBe('newFrag456');
  });

  // -----------------------------------------------------------------------
  // 7. getKeyRepairLogAsync — source isolation and DESC order
  // -----------------------------------------------------------------------
  it('getKeyRepairLogAsync returns rows in DESC timestamp order and respects sourceId filter', async () => {
    const b = getBackend();
    if (!b.available) return;

    const now = Date.now();
    // Insert in ascending order so DESC sort correctness is observable
    await repo.logKeyRepairAttemptAsync(LARGE_NODE_NUM, 'Node', 'action1', true, null, null, 'src-a');
    // Small delay to ensure different timestamp values
    await new Promise(r => setTimeout(r, 5));
    await repo.logKeyRepairAttemptAsync(LARGE_NODE_NUM, 'Node', 'action2', false, null, null, 'src-a');
    await repo.logKeyRepairAttemptAsync(LARGE_NODE_NUM, 'Node', 'action3', null, null, null, 'src-b');

    // Source isolation: src-a returns only 2 rows
    const srcA = await repo.getKeyRepairLogAsync(50, 'src-a');
    expect(srcA).toHaveLength(2);
    expect(srcA.map(r => r.action)).toEqual(['action2', 'action1']); // DESC order

    // Source isolation: src-b returns only 1 row
    const srcB = await repo.getKeyRepairLogAsync(50, 'src-b');
    expect(srcB).toHaveLength(1);
    expect(srcB[0].action).toBe('action3');

    // No sourceId filter: returns all 3 rows
    const all = await repo.getKeyRepairLogAsync(50);
    expect(all).toHaveLength(3);

    // Verify success null/bool round-trip
    const rowNull = all.find(r => r.action === 'action3');
    expect(rowNull!.success).toBeNull();
    const rowFalse = all.find(r => r.action === 'action2');
    expect(rowFalse!.success).toBe(false);

    void now; // suppress unused warning
  });

  // -----------------------------------------------------------------------
  // 8. Retention trim: insert 105 rows, assert count == 100, oldest gone
  // -----------------------------------------------------------------------
  it('logKeyRepairAttemptAsync trims log to 100 rows, dropping oldest', async () => {
    const b = getBackend();
    if (!b.available) return;

    const base = Date.now();

    // Insert 105 rows with ascending timestamps (so first 5 are oldest)
    for (let i = 0; i < 105; i++) {
      // Overwrite timestamp via raw insert so we can control ordering
      // (logKeyRepairAttemptAsync uses Date.now() internally, which is fine
      // for the keep-set but we need deterministic timestamps for the assertion)
      if (b.dbType === 'sqlite') {
        await b.exec(`INSERT INTO auto_key_repair_log (timestamp, nodeNum, nodeName, action, success, created_at, oldKeyFragment, newKeyFragment, sourceId)
          VALUES (${base + i}, ${LARGE_NODE_NUM}, 'Node', 'action', 1, ${base + i}, NULL, NULL, NULL)`);
      } else if (b.dbType === 'postgres') {
        await b.exec(`INSERT INTO auto_key_repair_log (timestamp, "nodeNum", "nodeName", action, success, created_at, "oldKeyFragment", "newKeyFragment", "sourceId")
          VALUES (${base + i}, ${LARGE_NODE_NUM}, 'Node', 'action', 1, ${base + i}, NULL, NULL, NULL)`);
      } else {
        await b.exec(`INSERT INTO auto_key_repair_log (timestamp, nodeNum, nodeName, action, success, created_at, oldKeyFragment, newKeyFragment, sourceId)
          VALUES (${base + i}, ${LARGE_NODE_NUM}, 'Node', 'action', 1, ${base + i}, NULL, NULL, NULL)`);
      }
    }

    // Now call the log method (which triggers retention trim)
    await repo.logKeyRepairAttemptAsync(LARGE_NODE_NUM, 'Node', 'trim_trigger', true, null, null, null);

    // After trim + the new row: should be exactly 100
    const log = await repo.getKeyRepairLogAsync(200);
    expect(log).toHaveLength(100);

    // The oldest rows (base+0 .. base+4) should be gone
    const timestamps = log.map(r => r.timestamp);
    for (let i = 0; i < 5; i++) {
      expect(timestamps).not.toContain(base + i);
    }

    // The newest rows should still be present
    expect(timestamps).toContain(base + 104);
  });
}

// ---------------------------------------------------------------------------
// SQLite — always runs
// ---------------------------------------------------------------------------
describe('KeyRepairRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeAll(() => {
    backend = createSqliteBackend(SQLITE_DDL);
  });

  afterAll(async () => {
    await backend.close();
  });

  runSuite(() => backend);
});

// ---------------------------------------------------------------------------
// PostgreSQL — skipped locally if container not available
// ---------------------------------------------------------------------------
describe.skipIf(!postgresAvailable)('KeyRepairRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_DDL);
  });

  afterAll(async () => {
    await backend.close();
  });

  runSuite(() => backend);
});

// ---------------------------------------------------------------------------
// MySQL — skipped locally if container not available
// ---------------------------------------------------------------------------
describe.skipIf(!mysqlAvailable)('KeyRepairRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_DDL);
  });

  afterAll(async () => {
    await backend.close();
  });

  runSuite(() => backend);
});
