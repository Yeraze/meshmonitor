/**
 * Multi-Database Traceroutes Repository Tests
 *
 * Validates TraceroutesRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import * as schema from '../schema/index.js';
import { TraceroutesRepository } from './traceroutes.js';
import {
  TestBackend,
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';
import { DbTraceroute, DbRouteSegment } from '../types.js';

// SQL for creating tables per backend
const SQLITE_CREATE = `
  CREATE TABLE IF NOT EXISTS traceroutes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fromNodeNum INTEGER NOT NULL,
    toNodeNum INTEGER NOT NULL,
    fromNodeId TEXT NOT NULL,
    toNodeId TEXT NOT NULL,
    route TEXT,
    routeBack TEXT,
    snrTowards TEXT,
    snrBack TEXT,
    routePositions TEXT,
    channel INTEGER,
    timestamp INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    sourceId TEXT
  );

  CREATE TABLE IF NOT EXISTS route_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fromNodeNum INTEGER NOT NULL,
    toNodeNum INTEGER NOT NULL,
    fromNodeId TEXT NOT NULL,
    toNodeId TEXT NOT NULL,
    distanceKm REAL NOT NULL,
    isRecordHolder INTEGER DEFAULT 0,
    fromLatitude REAL,
    fromLongitude REAL,
    toLatitude REAL,
    toLongitude REAL,
    timestamp INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    sourceId TEXT
  );
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS route_segments CASCADE;
  DROP TABLE IF EXISTS traceroutes CASCADE;
  CREATE TABLE traceroutes (
    id SERIAL PRIMARY KEY,
    "fromNodeNum" BIGINT NOT NULL,
    "toNodeNum" BIGINT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    route TEXT,
    "routeBack" TEXT,
    "snrTowards" TEXT,
    "snrBack" TEXT,
    "routePositions" TEXT,
    channel INTEGER,
    timestamp BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "sourceId" TEXT
  );

  CREATE TABLE route_segments (
    id SERIAL PRIMARY KEY,
    "fromNodeNum" BIGINT NOT NULL,
    "toNodeNum" BIGINT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    "distanceKm" REAL NOT NULL,
    "isRecordHolder" BOOLEAN DEFAULT FALSE,
    "fromLatitude" DOUBLE PRECISION,
    "fromLongitude" DOUBLE PRECISION,
    "toLatitude" DOUBLE PRECISION,
    "toLongitude" DOUBLE PRECISION,
    timestamp BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "sourceId" TEXT
  );
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS route_segments;
  DROP TABLE IF EXISTS traceroutes;
  CREATE TABLE traceroutes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    fromNodeNum BIGINT NOT NULL,
    toNodeNum BIGINT NOT NULL,
    fromNodeId VARCHAR(32) NOT NULL,
    toNodeId VARCHAR(32) NOT NULL,
    route TEXT,
    routeBack TEXT,
    snrTowards TEXT,
    snrBack TEXT,
    routePositions TEXT,
    channel INT,
    timestamp BIGINT NOT NULL,
    createdAt BIGINT NOT NULL,
    sourceId VARCHAR(36)
  );
  CREATE TABLE route_segments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    fromNodeNum BIGINT NOT NULL,
    toNodeNum BIGINT NOT NULL,
    fromNodeId VARCHAR(32) NOT NULL,
    toNodeId VARCHAR(32) NOT NULL,
    distanceKm DOUBLE NOT NULL,
    isRecordHolder BOOLEAN DEFAULT FALSE,
    fromLatitude DOUBLE,
    fromLongitude DOUBLE,
    toLatitude DOUBLE,
    toLongitude DOUBLE,
    timestamp BIGINT NOT NULL,
    createdAt BIGINT NOT NULL,
    sourceId VARCHAR(36)
  )
`;

// Helper to create a traceroute data object
function makeTraceroute(overrides: Partial<DbTraceroute> = {}): DbTraceroute {
  return {
    fromNodeNum: 1001,
    toNodeNum: 2002,
    fromNodeId: '!aabb1001',
    toNodeId: '!aabb2002',
    route: null,
    routeBack: null,
    snrTowards: null,
    snrBack: null,
    timestamp: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

// Helper to create a route segment data object
function makeSegment(overrides: Partial<DbRouteSegment> = {}): DbRouteSegment {
  return {
    fromNodeNum: 1001,
    toNodeNum: 2002,
    fromNodeId: '!aabb1001',
    toNodeId: '!aabb2002',
    distanceKm: 5.5,
    isRecordHolder: false,
    timestamp: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * Shared test suite that runs against any backend.
 * Call within a describe() block with a function that returns the current backend.
 */
function runTraceroutesTests(getBackend: () => TestBackend) {
  let repo: TraceroutesRepository;

  beforeEach(() => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new TraceroutesRepository(backend.drizzleDb, backend.dbType);
  });

  // ============ TRACEROUTES ============

  it('insertTraceroute / getAllTraceroutes - insert and retrieve traceroutes', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const now = Date.now();
    await repo.insertTraceroute(makeTraceroute({ timestamp: now, createdAt: now }));
    await repo.insertTraceroute(makeTraceroute({
      fromNodeNum: 3003,
      toNodeNum: 4004,
      fromNodeId: '!aabb3003',
      toNodeId: '!aabb4004',
      timestamp: now + 1000,
      createdAt: now + 1000,
    }));

    const all = await repo.getAllTraceroutes();
    expect(all.length).toBe(2);
    // Most recent first
    expect(all[0].fromNodeNum).toBe(3003);
    expect(all[1].fromNodeNum).toBe(1001);
  });

  it('findPendingTraceroute - finds pending within time window', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const now = Date.now();
    // Insert a pending traceroute (route is null)
    await repo.insertTraceroute(makeTraceroute({
      timestamp: now,
      createdAt: now,
      route: null,
    }));

    // Should find it within window
    const found = await repo.findPendingTraceroute(1001, 2002, now - 60000);
    expect(found).not.toBeNull();
    expect(found!.id).toBeDefined();

    // Should NOT find it if sinceTimestamp is in the future
    const notFound = await repo.findPendingTraceroute(1001, 2002, now + 60000);
    expect(notFound).toBeNull();

    // Should NOT find it for different nodes
    const wrongNodes = await repo.findPendingTraceroute(9999, 8888, now - 60000);
    expect(wrongNodes).toBeNull();
  });

  it('findPendingTraceroute - does not find completed traceroutes', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const now = Date.now();
    // Insert a completed traceroute (route is not null)
    await repo.insertTraceroute(makeTraceroute({
      timestamp: now,
      createdAt: now,
      route: '1001,3003,2002',
    }));

    const found = await repo.findPendingTraceroute(1001, 2002, now - 60000);
    expect(found).toBeNull();
  });

  it('updateTracerouteResponse - updates route data and status', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const now = Date.now();
    await repo.insertTraceroute(makeTraceroute({ timestamp: now, createdAt: now }));

    // Find the pending traceroute
    const pending = await repo.findPendingTraceroute(1001, 2002, now - 60000);
    expect(pending).not.toBeNull();

    // Update it
    const updatedTs = now + 5000;
    await repo.updateTracerouteResponse(
      pending!.id,
      '1001,3003,2002',
      '2002,3003,1001',
      '10.5,8.2',
      '9.1,7.3',
      updatedTs
    );

    // Verify: it should no longer be pending
    const stillPending = await repo.findPendingTraceroute(1001, 2002, now - 60000);
    expect(stillPending).toBeNull();

    // Verify the updated data
    const all = await repo.getAllTraceroutes();
    expect(all.length).toBe(1);
    expect(all[0].route).toBe('1001,3003,2002');
    expect(all[0].routeBack).toBe('2002,3003,1001');
    expect(all[0].snrTowards).toBe('10.5,8.2');
    expect(all[0].snrBack).toBe('9.1,7.3');
    expect(Number(all[0].timestamp)).toBe(updatedTs);
  });

  it('getTraceroutesByNodes - filter by from/to (bidirectional)', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const now = Date.now();
    // Insert traceroutes for different node pairs
    await repo.insertTraceroute(makeTraceroute({
      fromNodeNum: 1001, toNodeNum: 2002,
      timestamp: now, createdAt: now,
    }));
    await repo.insertTraceroute(makeTraceroute({
      fromNodeNum: 2002, toNodeNum: 1001,
      timestamp: now + 1000, createdAt: now + 1000,
    }));
    await repo.insertTraceroute(makeTraceroute({
      fromNodeNum: 5005, toNodeNum: 6006,
      timestamp: now + 2000, createdAt: now + 2000,
    }));

    // Should find both directions
    const results = await repo.getTraceroutesByNodes(1001, 2002);
    expect(results.length).toBe(2);

    // Should not include unrelated pair
    const unrelated = await repo.getTraceroutesByNodes(5005, 6006);
    expect(unrelated.length).toBe(1);
    expect(unrelated[0].fromNodeNum).toBe(5005);
  });

  it('getTracerouteCount - returns correct count', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    expect(await repo.getTracerouteCount()).toBe(0);

    const now = Date.now();
    await repo.insertTraceroute(makeTraceroute({ timestamp: now, createdAt: now }));
    await repo.insertTraceroute(makeTraceroute({ timestamp: now + 1, createdAt: now + 1 }));
    await repo.insertTraceroute(makeTraceroute({ timestamp: now + 2, createdAt: now + 2 }));

    expect(await repo.getTracerouteCount()).toBe(3);
  });

  it('deleteTraceroutesForNode - deletes traceroutes involving a node', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const now = Date.now();
    // Node 1001 is fromNodeNum
    await repo.insertTraceroute(makeTraceroute({
      fromNodeNum: 1001, toNodeNum: 2002,
      timestamp: now, createdAt: now,
    }));
    // Node 1001 is toNodeNum
    await repo.insertTraceroute(makeTraceroute({
      fromNodeNum: 3003, toNodeNum: 1001,
      timestamp: now + 1, createdAt: now + 1,
    }));
    // Unrelated
    await repo.insertTraceroute(makeTraceroute({
      fromNodeNum: 4004, toNodeNum: 5005,
      timestamp: now + 2, createdAt: now + 2,
    }));

    const deleted = await repo.deleteTraceroutesForNode(1001);
    expect(deleted).toBe(2);
    expect(await repo.getTracerouteCount()).toBe(1);
  });

  it('cleanupOldTraceroutes - time-based cleanup', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const now = Date.now();
    const oldTimestamp = now - (48 * 60 * 60 * 1000); // 48 hours ago
    const recentTimestamp = now - (1 * 60 * 60 * 1000); // 1 hour ago

    await repo.insertTraceroute(makeTraceroute({
      timestamp: oldTimestamp, createdAt: oldTimestamp,
    }));
    await repo.insertTraceroute(makeTraceroute({
      timestamp: recentTimestamp, createdAt: recentTimestamp,
    }));

    // Cleanup older than 24 hours
    const deleted = await repo.cleanupOldTraceroutes(24);
    expect(deleted).toBe(1);
    expect(await repo.getTracerouteCount()).toBe(1);
  });

  // ============ ROUTE SEGMENTS ============

  it('insertRouteSegment / getLongestActiveRouteSegment', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const now = Date.now();
    await repo.insertRouteSegment(makeSegment({
      distanceKm: 5.5,
      timestamp: now, createdAt: now,
    }));
    await repo.insertRouteSegment(makeSegment({
      fromNodeNum: 3003, toNodeNum: 4004,
      distanceKm: 12.3,
      timestamp: now + 1, createdAt: now + 1,
    }));

    const longest = await repo.getLongestActiveRouteSegment();
    expect(longest).not.toBeNull();
    expect(longest!.distanceKm).toBeCloseTo(12.3);
    expect(longest!.fromNodeNum).toBe(3003);
  });

  it('getLongestActiveRouteSegment - returns null when empty', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const result = await repo.getLongestActiveRouteSegment();
    expect(result).toBeNull();
  });

  it('getRecordHolderRouteSegment / setRecordHolder', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const now = Date.now();
    await repo.insertRouteSegment(makeSegment({
      distanceKm: 5.5, isRecordHolder: false,
      timestamp: now, createdAt: now,
    }));
    await repo.insertRouteSegment(makeSegment({
      fromNodeNum: 3003, toNodeNum: 4004,
      distanceKm: 20.0, isRecordHolder: false,
      timestamp: now + 1, createdAt: now + 1,
    }));

    // No record holder yet
    let recordHolder = await repo.getRecordHolderRouteSegment();
    expect(recordHolder).toBeNull();

    // Find the longest and set it as record holder
    const longest = await repo.getLongestActiveRouteSegment();
    expect(longest).not.toBeNull();
    await repo.setRecordHolder(longest!.id!, true);

    // Now should find the record holder
    recordHolder = await repo.getRecordHolderRouteSegment();
    expect(recordHolder).not.toBeNull();
    expect(recordHolder!.distanceKm).toBeCloseTo(20.0);
    expect(recordHolder!.fromNodeNum).toBe(3003);

    // Unset record holder
    await repo.setRecordHolder(longest!.id!, false);
    recordHolder = await repo.getRecordHolderRouteSegment();
    expect(recordHolder).toBeNull();
  });

  it('cleanupOldRouteSegments - removes old non-record-holder segments', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const now = Date.now();
    const oldTimestamp = now - (60 * 24 * 60 * 60 * 1000); // 60 days ago
    const recentTimestamp = now - (1 * 24 * 60 * 60 * 1000); // 1 day ago

    // Old non-record-holder (should be cleaned up)
    await repo.insertRouteSegment(makeSegment({
      distanceKm: 5.5, isRecordHolder: false,
      timestamp: oldTimestamp, createdAt: oldTimestamp,
    }));
    // Old record-holder (should be kept)
    await repo.insertRouteSegment(makeSegment({
      fromNodeNum: 3003, toNodeNum: 4004,
      distanceKm: 50.0, isRecordHolder: true,
      timestamp: oldTimestamp, createdAt: oldTimestamp,
    }));
    // Recent non-record-holder (should be kept)
    await repo.insertRouteSegment(makeSegment({
      fromNodeNum: 5005, toNodeNum: 6006,
      distanceKm: 3.0, isRecordHolder: false,
      timestamp: recentTimestamp, createdAt: recentTimestamp,
    }));

    // Cleanup older than 30 days
    const deleted = await repo.cleanupOldRouteSegments(30);
    expect(deleted).toBe(1); // Only the old non-record-holder

    // Verify: record holder and recent segment remain
    const longest = await repo.getLongestActiveRouteSegment();
    expect(longest).not.toBeNull();
    expect(longest!.distanceKm).toBeCloseTo(50.0);

    const recordHolder = await repo.getRecordHolderRouteSegment();
    expect(recordHolder).not.toBeNull();
    expect(recordHolder!.distanceKm).toBeCloseTo(50.0);
  });
}

// --- SQLite Backend ---
describe('TraceroutesRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(async () => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });

  afterEach(async () => {
    await backend.close();
  });

  runTraceroutesTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('TraceroutesRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for traceroutes tests');
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
    await clearTable(backend, 'traceroutes');
    await clearTable(backend, 'route_segments');
  });

  runTraceroutesTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('TraceroutesRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for traceroutes tests');
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
    await clearTable(backend, 'traceroutes');
    await clearTable(backend, 'route_segments');
  });

  runTraceroutesTests(() => backend);
});
