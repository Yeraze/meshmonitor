/**
 * Migration 175 — PostgreSQL / MySQL container behaviour.
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)` — creates a minimal
 * `nodes` table (as of migration 174, before this migration) in an isolated
 * per-suite database (`createIsolatedPostgresDatabase`/`createIsolatedMysqlDatabase`
 * — the shared `meshmonitor_test` database is NOT used here, since several
 * other suites also own a `nodes` table and a shared DB would race, see
 * CLAUDE.md "PG/MySQL suites need DB isolation"), then runs the real
 * migration 175 functions and asserts column presence + idempotency + a
 * round-tripped classification write on each backend. A silent skip here
 * still reports `success: true` at the suite level — confirm via
 * `numPendingTests` in the JSON reporter, not just the pass/fail summary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration175Postgres, runMigration175Mysql } from './175_add_node_aircraft_classification.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 175 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig175'));
    await pool.query('DROP TABLE IF EXISTS nodes CASCADE');
    await pool.query(`
      CREATE TABLE nodes (
        "nodeNum" BIGINT NOT NULL,
        "nodeId" TEXT NOT NULL,
        "longName" TEXT,
        "shortName" TEXT,
        "altitude" DOUBLE PRECISION,
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL,
        "sourceId" TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY ("nodeNum", "sourceId")
      )
    `);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the aircraft-classification columns, is idempotent, and round-trips a write', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration175Postgres(client1);
      await expect(runMigration175Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO nodes ("nodeNum", "nodeId", "longName", "shortName", "altitude", "createdAt", "updatedAt")
       VALUES (100, '!00000064', 'Node 100', 'N100', 3200, $1, $1)`,
      [now],
    );

    const { rows: before } = await pool.query(
      `SELECT "likelyAircraft", "aircraftBasis", "groundElevation", "heightAboveGround", "aircraftClassifiedAt"
       FROM nodes WHERE "nodeNum" = 100`,
    );
    expect(before[0].likelyAircraft).toBeNull();
    expect(before[0].aircraftBasis).toBeNull();

    await pool.query(
      `UPDATE nodes SET "likelyAircraft" = true, "aircraftBasis" = 'agl', "groundElevation" = 200, "heightAboveGround" = 3000, "aircraftClassifiedAt" = $1
       WHERE "nodeNum" = 100`,
      [now],
    );

    const { rows } = await pool.query(
      `SELECT "likelyAircraft", "aircraftBasis", "groundElevation", "heightAboveGround", "aircraftClassifiedAt"
       FROM nodes WHERE "nodeNum" = 100`,
    );
    expect(rows[0].likelyAircraft).toBe(true);
    expect(rows[0].aircraftBasis).toBe('agl');
    expect(Number(rows[0].groundElevation)).toBeCloseTo(200);
    expect(Number(rows[0].heightAboveGround)).toBeCloseTo(3000);
    expect(Number(rows[0].aircraftClassifiedAt)).toBe(now);
  });
});

describe.skipIf(!mysqlAvailable)('migration 175 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig175'));
    await pool.query('DROP TABLE IF EXISTS nodes');
    await pool.query(`
      CREATE TABLE nodes (
        nodeNum BIGINT NOT NULL,
        nodeId VARCHAR(255) NOT NULL,
        longName VARCHAR(255),
        shortName VARCHAR(255),
        altitude DOUBLE,
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL,
        sourceId VARCHAR(36) NOT NULL DEFAULT 'default',
        PRIMARY KEY (nodeNum, sourceId)
      )
    `);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the aircraft-classification columns, is idempotent, and round-trips a write', async () => {
    await runMigration175Mysql(pool);
    await expect(runMigration175Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    await pool.query(
      `INSERT INTO nodes (nodeNum, nodeId, longName, shortName, altitude, createdAt, updatedAt)
       VALUES (100, '!00000064', 'Node 100', 'N100', 3200, ?, ?)`,
      [now, now],
    );

    const [before] = await pool.query(
      `SELECT likelyAircraft, aircraftBasis, groundElevation, heightAboveGround, aircraftClassifiedAt
       FROM nodes WHERE nodeNum = 100`,
    );
    expect((before as any[])[0].likelyAircraft).toBeNull();
    expect((before as any[])[0].aircraftBasis).toBeNull();

    await pool.query(
      `UPDATE nodes SET likelyAircraft = 1, aircraftBasis = 'agl', groundElevation = 200, heightAboveGround = 3000, aircraftClassifiedAt = ?
       WHERE nodeNum = 100`,
      [now],
    );

    const [rows] = await pool.query(
      `SELECT likelyAircraft, aircraftBasis, groundElevation, heightAboveGround, aircraftClassifiedAt
       FROM nodes WHERE nodeNum = 100`,
    );
    const row = (rows as any[])[0];
    expect(row.likelyAircraft).toBe(1);
    expect(row.aircraftBasis).toBe('agl');
    expect(Number(row.groundElevation)).toBeCloseTo(200);
    expect(Number(row.heightAboveGround)).toBeCloseTo(3000);
    expect(Number(row.aircraftClassifiedAt)).toBe(now);
  });
});
