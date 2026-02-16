/**
 * Multi-Database Telemetry Repository Tests
 *
 * Tests getLatestTelemetryForType against both SQLite and PostgreSQL backends.
 * Requires PostgreSQL container running on port 5433:
 *   docker run -d --name meshmonitor-test-postgres -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=meshmonitor_test -p 5433:5432 postgres:16
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { telemetrySqlite, telemetryPostgres } from '../schema/telemetry.js';
import { TelemetryRepository } from './telemetry.js';
import * as schema from '../schema/index.js';

const { Pool } = pg;

// Test constants
const NODE1 = '!aabbccdd';
const NODE1_NUM = 0xaabbccdd;
const NODE2 = '!11223344';
const NODE2_NUM = 0x11223344;
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

describe('TelemetryRepository - SQLite Backend', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: TelemetryRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeId TEXT NOT NULL,
        nodeNum INTEGER NOT NULL,
        telemetryType TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        value REAL NOT NULL,
        unit TEXT,
        createdAt INTEGER NOT NULL,
        packetTimestamp INTEGER,
        packetId INTEGER,
        channel INTEGER,
        precisionBits INTEGER,
        gpsAccuracy INTEGER
      )
    `);
    drizzleDb = drizzleSqlite(db, { schema });
    repo = new TelemetryRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  const insertTelemetry = async (
    nodeId: string,
    nodeNum: number,
    telemetryType: string,
    timestamp: number,
    value: number
  ) => {
    await repo.insertTelemetry({
      nodeId,
      nodeNum,
      telemetryType,
      timestamp,
      value,
      unit: '%',
      createdAt: Date.now(),
    });
  };

  it('should return the most recent telemetry entry (SQLite)', async () => {
    await insertTelemetry(NODE1, NODE1_NUM, 'numOnlineNodes', NOW - 3 * HOUR, 10);
    await insertTelemetry(NODE1, NODE1_NUM, 'numOnlineNodes', NOW - 2 * HOUR, 15);
    await insertTelemetry(NODE1, NODE1_NUM, 'numOnlineNodes', NOW - 1 * HOUR, 20);

    const result = await repo.getLatestTelemetryForType(NODE1, 'numOnlineNodes');

    expect(result).not.toBeNull();
    expect(result!.value).toBe(20);
    console.log('✓ SQLite: getLatestTelemetryForType returns most recent entry');
  });

  it('should return null when no matching telemetry exists (SQLite)', async () => {
    await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 1 * HOUR, 80);

    const result = await repo.getLatestTelemetryForType(NODE1, 'numOnlineNodes');

    expect(result).toBeNull();
    console.log('✓ SQLite: getLatestTelemetryForType returns null for non-existent type');
  });

  it('should work with systemNodeCount telemetry type (SQLite)', async () => {
    await insertTelemetry(NODE1, NODE1_NUM, 'systemNodeCount', NOW - 1 * HOUR, 42);

    const result = await repo.getLatestTelemetryForType(NODE1, 'systemNodeCount');

    expect(result).not.toBeNull();
    expect(result!.value).toBe(42);
    console.log('✓ SQLite: getLatestTelemetryForType works with systemNodeCount');
  });
});

describe('TelemetryRepository - PostgreSQL Backend', () => {
  let pool: pg.Pool;
  let drizzleDb: ReturnType<typeof drizzlePostgres>;
  let repo: TelemetryRepository;
  let pgAvailable = true;

  beforeAll(async () => {
    try {
      pool = new Pool({
        host: 'localhost',
        port: 5433,
        user: 'test',
        password: 'test',
        database: 'meshmonitor_test',
        connectionTimeoutMillis: 5000,
      });

      // Test connection
      const client = await pool.connect();
      client.release();

      drizzleDb = drizzlePostgres(pool, { schema });
      repo = new TelemetryRepository(drizzleDb, 'postgres');

      // Create table
      await pool.query(`
        DROP TABLE IF EXISTS telemetry;
        CREATE TABLE telemetry (
          id SERIAL PRIMARY KEY,
          "nodeId" TEXT NOT NULL,
          "nodeNum" BIGINT NOT NULL,
          "telemetryType" TEXT NOT NULL,
          timestamp BIGINT NOT NULL,
          value DOUBLE PRECISION NOT NULL,
          unit TEXT,
          "createdAt" BIGINT NOT NULL,
          "packetTimestamp" BIGINT,
          "packetId" INTEGER,
          channel INTEGER,
          "precisionBits" INTEGER,
          "gpsAccuracy" INTEGER
        )
      `);
      console.log('✓ PostgreSQL connection established');
    } catch (error) {
      console.log('⚠ PostgreSQL not available, skipping PostgreSQL tests');
      console.log('  Run: docker run -d --name meshmonitor-test-postgres -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=meshmonitor_test -p 5433:5432 postgres:16');
      pgAvailable = false;
    }
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  beforeEach(async () => {
    if (!pgAvailable) return;
    // Clear table before each test
    await pool.query('TRUNCATE TABLE telemetry RESTART IDENTITY');
  });

  const insertTelemetry = async (
    nodeId: string,
    nodeNum: number,
    telemetryType: string,
    timestamp: number,
    value: number
  ) => {
    if (!pgAvailable) return;
    await repo.insertTelemetry({
      nodeId,
      nodeNum,
      telemetryType,
      timestamp,
      value,
      unit: '%',
      createdAt: Date.now(),
    });
  };

  it('should return the most recent telemetry entry (PostgreSQL)', async () => {
    if (!pgAvailable) {
      console.log('⚠ Skipped: PostgreSQL not available');
      return;
    }

    await insertTelemetry(NODE1, NODE1_NUM, 'numOnlineNodes', NOW - 3 * HOUR, 10);
    await insertTelemetry(NODE1, NODE1_NUM, 'numOnlineNodes', NOW - 2 * HOUR, 15);
    await insertTelemetry(NODE1, NODE1_NUM, 'numOnlineNodes', NOW - 1 * HOUR, 20);

    const result = await repo.getLatestTelemetryForType(NODE1, 'numOnlineNodes');

    expect(result).not.toBeNull();
    expect(result!.value).toBe(20);
    console.log('✓ PostgreSQL: getLatestTelemetryForType returns most recent entry');
  });

  it('should return null when no matching telemetry exists (PostgreSQL)', async () => {
    if (!pgAvailable) {
      console.log('⚠ Skipped: PostgreSQL not available');
      return;
    }

    await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 1 * HOUR, 80);

    const result = await repo.getLatestTelemetryForType(NODE1, 'numOnlineNodes');

    expect(result).toBeNull();
    console.log('✓ PostgreSQL: getLatestTelemetryForType returns null for non-existent type');
  });

  it('should work with systemNodeCount telemetry type (PostgreSQL)', async () => {
    if (!pgAvailable) {
      console.log('⚠ Skipped: PostgreSQL not available');
      return;
    }

    await insertTelemetry(NODE1, NODE1_NUM, 'systemNodeCount', NOW - 1 * HOUR, 42);

    const result = await repo.getLatestTelemetryForType(NODE1, 'systemNodeCount');

    expect(result).not.toBeNull();
    expect(result!.value).toBe(42);
    console.log('✓ PostgreSQL: getLatestTelemetryForType works with systemNodeCount');
  });

  it('should work with systemDirectNodeCount telemetry type (PostgreSQL)', async () => {
    if (!pgAvailable) {
      console.log('⚠ Skipped: PostgreSQL not available');
      return;
    }

    await insertTelemetry(NODE1, NODE1_NUM, 'systemDirectNodeCount', NOW - 1 * HOUR, 15);

    const result = await repo.getLatestTelemetryForType(NODE1, 'systemDirectNodeCount');

    expect(result).not.toBeNull();
    expect(result!.value).toBe(15);
    console.log('✓ PostgreSQL: getLatestTelemetryForType works with systemDirectNodeCount');
  });

  it('should only return telemetry for the specified node (PostgreSQL)', async () => {
    if (!pgAvailable) {
      console.log('⚠ Skipped: PostgreSQL not available');
      return;
    }

    await insertTelemetry(NODE1, NODE1_NUM, 'numOnlineNodes', NOW - 1 * HOUR, 10);
    await insertTelemetry(NODE2, NODE2_NUM, 'numOnlineNodes', NOW - 30 * 60 * 1000, 25);

    const result = await repo.getLatestTelemetryForType(NODE1, 'numOnlineNodes');

    expect(result).not.toBeNull();
    expect(result!.value).toBe(10);
    expect(result!.nodeId).toBe(NODE1);
    console.log('✓ PostgreSQL: getLatestTelemetryForType isolates by node');
  });
});
