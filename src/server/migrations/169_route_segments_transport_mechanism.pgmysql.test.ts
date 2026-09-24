/**
 * Migration 169 — PostgreSQL / MySQL container behaviour (#5101).
 *
 * Builds `route_segments` as it stood BEFORE this migration, runs the real
 * migration functions against the live test containers (localhost:5433 /
 * :3307), then round-trips a value through the real Drizzle table (which now
 * includes the column) to confirm the ALTER TABLE and the schema agree.
 *
 * Own isolated database per dialect (CLAUDE.md Multi-Database) — a fixture
 * race with another suite that also creates/drops `route_segments` would
 * otherwise reproduce 100% of the time when the two run together.
 *
 * A silent skip still reports `success: true`; confirm coverage via
 * `numPendingTests` in the JSON reporter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema/index.js';
import { routeSegmentsPostgres, routeSegmentsMysql } from '../../db/schema/traceroutes.js';
import { runMigration169Postgres, runMigration169Mysql } from './169_route_segments_transport_mechanism.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const BASE_ROW = {
  fromNodeNum: 0xfedcba98, // unsigned 32-bit, above signed INTEGER's ceiling
  toNodeNum: 0x11223344,
  fromNodeId: '!fedcba98',
  toNodeId: '!11223344',
  distanceKm: 12.5,
  isRecordHolder: false,
  timestamp: 1_800_000_000_000,
  createdAt: 1_800_000_000_000,
  sourceId: 'src-a',
};

/** MULTICAST_UDP — the value that could not be stored before this migration. */
const UDP = 6;

describe.skipIf(!postgresAvailable)('migration 169 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzlePostgres>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig169'));
    await pool.query('DROP TABLE IF EXISTS route_segments CASCADE');
    await pool.query(`
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
      )
    `);
    db = drizzlePostgres(pool, { schema });
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds a column the Drizzle schema can round-trip, and the index, and runs twice safely', async () => {
    const client = await pool.connect();
    try {
      await runMigration169Postgres(client);
      await expect(runMigration169Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    const indexes = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'route_segments' AND indexname = 'idx_route_segments_source_transport_distance'`,
    );
    expect(indexes.rows.length).toBe(1);

    await db.insert(routeSegmentsPostgres).values({ ...BASE_ROW, transportMechanism: UDP });
    const [row] = await db
      .select()
      .from(routeSegmentsPostgres)
      .where(eq(routeSegmentsPostgres.fromNodeNum, BASE_ROW.fromNodeNum));

    expect(row.transportMechanism).toBe(UDP);
    expect(Number(row.fromNodeNum)).toBe(BASE_ROW.fromNodeNum);
  });

  it('leaves the column NULL for a row that supplies none', async () => {
    await db.insert(routeSegmentsPostgres).values({ ...BASE_ROW, fromNodeNum: 555 });
    const [row] = await db
      .select()
      .from(routeSegmentsPostgres)
      .where(eq(routeSegmentsPostgres.fromNodeNum, 555));

    expect(row.transportMechanism).toBeNull();
  });
});

describe.skipIf(!mysqlAvailable)('migration 169 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzleMysql>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig169'));
    await pool.query('DROP TABLE IF EXISTS route_segments');
    await pool.query(`
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
    `);
    db = drizzleMysql(pool, { schema, mode: 'default' });
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds a column the Drizzle schema can round-trip, and the index, and runs twice safely', async () => {
    await runMigration169Mysql(pool);
    await expect(runMigration169Mysql(pool)).resolves.toBeUndefined();

    const [indexes] = await pool.query(
      `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'route_segments' AND INDEX_NAME = 'idx_route_segments_source_transport_distance'`,
    );
    expect((indexes as unknown[]).length).toBe(1);

    await db.insert(routeSegmentsMysql).values({ ...BASE_ROW, transportMechanism: UDP });
    const [row] = await db
      .select()
      .from(routeSegmentsMysql)
      .where(eq(routeSegmentsMysql.fromNodeNum, BASE_ROW.fromNodeNum));

    expect(row.transportMechanism).toBe(UDP);
    expect(Number(row.fromNodeNum)).toBe(BASE_ROW.fromNodeNum);
  });

  it('leaves the column NULL for a row that supplies none', async () => {
    await db.insert(routeSegmentsMysql).values({ ...BASE_ROW, fromNodeNum: 555 });
    const [row] = await db
      .select()
      .from(routeSegmentsMysql)
      .where(eq(routeSegmentsMysql.fromNodeNum, 555));

    expect(row.transportMechanism).toBeNull();
  });
});
