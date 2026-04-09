/**
 * Multi-Database Neighbors Repository Tests
 *
 * Validates NeighborsRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import * as schema from '../schema/index.js';
import { NeighborsRepository } from './neighbors.js';
import { DbNeighborInfo } from '../types.js';
import {
  TestBackend,
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';

// SQL for creating the neighbor_info table per backend
const SQLITE_CREATE = `
  CREATE TABLE IF NOT EXISTS neighbor_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nodeNum INTEGER NOT NULL,
    neighborNodeNum INTEGER NOT NULL,
    snr REAL,
    lastRxTime INTEGER,
    timestamp INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    sourceId TEXT
  )
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS neighbor_info CASCADE;
  CREATE TABLE neighbor_info (
    id SERIAL PRIMARY KEY,
    "nodeNum" BIGINT NOT NULL,
    "neighborNodeNum" BIGINT NOT NULL,
    snr DOUBLE PRECISION,
    "lastRxTime" BIGINT,
    timestamp BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "sourceId" TEXT
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS neighbor_info;
  CREATE TABLE neighbor_info (
    id INT AUTO_INCREMENT PRIMARY KEY,
    \`nodeNum\` BIGINT NOT NULL,
    \`neighborNodeNum\` BIGINT NOT NULL,
    snr DOUBLE,
    \`lastRxTime\` BIGINT,
    \`timestamp\` BIGINT NOT NULL,
    \`createdAt\` BIGINT NOT NULL,
    \`sourceId\` VARCHAR(36)
  )
`;

/** Helper to create a neighbor info record */
function makeNeighbor(overrides: Partial<DbNeighborInfo> = {}): DbNeighborInfo {
  return {
    nodeNum: 100,
    neighborNodeNum: 200,
    snr: 5.5,
    lastRxTime: Date.now() - 10000,
    timestamp: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * Shared test suite that runs against any backend.
 * Call within a describe() block with a function that returns the current backend.
 */
function runNeighborsTests(getBackend: () => TestBackend) {
  let repo: NeighborsRepository;

  beforeEach(() => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new NeighborsRepository(backend.drizzleDb, backend.dbType);
  });

  it('insertNeighborInfo - single insert', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const neighbor = makeNeighbor();
    await repo.insertNeighborInfo(neighbor);

    const all = await repo.getAllNeighborInfo();
    expect(all).toHaveLength(1);
    expect(all[0].nodeNum).toBe(100);
    expect(all[0].neighborNodeNum).toBe(200);
    expect(all[0].snr).toBeCloseTo(5.5);
  });

  it('insertNeighborInfoBatch - batch insert multiple records', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const records = [
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 200 }),
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 300 }),
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 400 }),
    ];
    await repo.insertNeighborInfoBatch(records);

    const all = await repo.getAllNeighborInfo();
    expect(all).toHaveLength(3);
  });

  it('insertNeighborInfoBatch - empty array is a no-op', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.insertNeighborInfoBatch([]);
    const all = await repo.getAllNeighborInfo();
    expect(all).toHaveLength(0);
  });

  it('getNeighborsForNode - returns neighbors for specific node', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.insertNeighborInfoBatch([
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 200 }),
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 300 }),
      makeNeighbor({ nodeNum: 999, neighborNodeNum: 400 }),
    ]);

    const neighbors = await repo.getNeighborsForNode(100);
    expect(neighbors).toHaveLength(2);
    neighbors.forEach(n => expect(n.nodeNum).toBe(100));

    const others = await repo.getNeighborsForNode(999);
    expect(others).toHaveLength(1);
    expect(others[0].neighborNodeNum).toBe(400);
  });

  it('getNeighborsForNode - returns empty for unknown node', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const neighbors = await repo.getNeighborsForNode(12345);
    expect(neighbors).toHaveLength(0);
  });

  it('getAllNeighborInfo - returns all records', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.insertNeighborInfoBatch([
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 200 }),
      makeNeighbor({ nodeNum: 300, neighborNodeNum: 400 }),
    ]);

    const all = await repo.getAllNeighborInfo();
    expect(all).toHaveLength(2);
  });

  it('deleteNeighborInfoForNode - deletes for one node, preserves others', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.insertNeighborInfoBatch([
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 200 }),
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 300 }),
      makeNeighbor({ nodeNum: 999, neighborNodeNum: 400 }),
    ]);

    await repo.deleteNeighborInfoForNode(100);

    const all = await repo.getAllNeighborInfo();
    expect(all).toHaveLength(1);
    expect(all[0].nodeNum).toBe(999);
  });

  it('getNeighborCount - returns total count', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    expect(await repo.getNeighborCount()).toBe(0);

    await repo.insertNeighborInfoBatch([
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 200 }),
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 300 }),
      makeNeighbor({ nodeNum: 999, neighborNodeNum: 400 }),
    ]);

    expect(await repo.getNeighborCount()).toBe(3);
  });

  it('getNeighborCountForNode - returns count for specific node', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.insertNeighborInfoBatch([
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 200 }),
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 300 }),
      makeNeighbor({ nodeNum: 999, neighborNodeNum: 400 }),
    ]);

    expect(await repo.getNeighborCountForNode(100)).toBe(2);
    expect(await repo.getNeighborCountForNode(999)).toBe(1);
    expect(await repo.getNeighborCountForNode(12345)).toBe(0);
  });

  it('deleteAllNeighborInfo - removes all records', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.insertNeighborInfoBatch([
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 200 }),
      makeNeighbor({ nodeNum: 300, neighborNodeNum: 400 }),
    ]);

    await repo.deleteAllNeighborInfo();

    expect(await repo.getNeighborCount()).toBe(0);
    const all = await repo.getAllNeighborInfo();
    expect(all).toHaveLength(0);
  });

  it('cleanupOldNeighborInfo - deletes records older than N days', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const now = Date.now();
    const thirtyOneDaysAgo = now - (31 * 24 * 60 * 60 * 1000);
    const tenDaysAgo = now - (10 * 24 * 60 * 60 * 1000);

    await repo.insertNeighborInfoBatch([
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 200, timestamp: thirtyOneDaysAgo, createdAt: thirtyOneDaysAgo }),
      makeNeighbor({ nodeNum: 100, neighborNodeNum: 300, timestamp: thirtyOneDaysAgo, createdAt: thirtyOneDaysAgo }),
      makeNeighbor({ nodeNum: 999, neighborNodeNum: 400, timestamp: tenDaysAgo, createdAt: tenDaysAgo }),
      makeNeighbor({ nodeNum: 999, neighborNodeNum: 500, timestamp: now, createdAt: now }),
    ]);

    // Cleanup records older than 30 days - should remove the two 31-day-old records
    const deleted = await repo.cleanupOldNeighborInfo(30);
    expect(deleted).toBe(2);

    const remaining = await repo.getAllNeighborInfo();
    expect(remaining).toHaveLength(2);
    remaining.forEach(r => expect(r.timestamp).toBeGreaterThanOrEqual(tenDaysAgo));
  });

  it('cleanupOldNeighborInfo - returns 0 when nothing to delete', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const now = Date.now();
    await repo.insertNeighborInfo(makeNeighbor({ timestamp: now, createdAt: now }));

    const deleted = await repo.cleanupOldNeighborInfo(30);
    expect(deleted).toBe(0);
    expect(await repo.getNeighborCount()).toBe(1);
  });

  it('insertNeighborInfo - handles null snr and lastRxTime', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const neighbor = makeNeighbor({ snr: null, lastRxTime: null });
    await repo.insertNeighborInfo(neighbor);

    const all = await repo.getAllNeighborInfo();
    expect(all).toHaveLength(1);
    expect(all[0].snr).toBeNull();
    expect(all[0].lastRxTime).toBeNull();
  });
}

// --- SQLite Backend ---
describe('NeighborsRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });

  afterEach(async () => {
    await backend.close();
  });

  runNeighborsTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('NeighborsRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for neighbors tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'neighbor_info');
  });

  runNeighborsTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('NeighborsRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for neighbors tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'neighbor_info');
  });

  runNeighborsTests(() => backend);
});
