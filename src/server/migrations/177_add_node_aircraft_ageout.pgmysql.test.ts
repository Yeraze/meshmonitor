/**
 * Migration 177 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration177Postgres, runMigration177Mysql } from './177_add_node_aircraft_ageout.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 177 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig177'));
    await pool.query('DROP TABLE IF EXISTS nodes CASCADE');
    await pool.query(`
      CREATE TABLE nodes (
        "nodeNum" BIGINT NOT NULL,
        "nodeId" TEXT NOT NULL,
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

  it('adds the columns, is idempotent, and round-trips a write', async () => {
    const client = await pool.connect();
    try {
      await runMigration177Postgres(client);
      await expect(runMigration177Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const now = Date.now();
    await pool.query(`INSERT INTO nodes ("nodeNum", "nodeId", "createdAt", "updatedAt") VALUES (100, '!00000064', $1, $1)`, [now]);
    const { rows: before } = await pool.query(`SELECT "aircraftAgedOutAt", "aircraftFixedAt" FROM nodes WHERE "nodeNum" = 100`);
    expect(before[0].aircraftAgedOutAt).toBeNull();
    expect(before[0].aircraftFixedAt).toBeNull();
    await pool.query(
      `UPDATE nodes SET "aircraftAgedOutAt" = $1, "aircraftFixedAt" = $1, "aircraftFixedLatitude" = 40.5, "aircraftFixedLongitude" = -105.25 WHERE "nodeNum" = 100`,
      [now],
    );
    const { rows } = await pool.query(
      `SELECT "aircraftAgedOutAt", "aircraftFixedAt", "aircraftFixedLatitude", "aircraftFixedLongitude" FROM nodes WHERE "nodeNum" = 100`,
    );
    expect(Number(rows[0].aircraftAgedOutAt)).toBe(now);
    expect(Number(rows[0].aircraftFixedAt)).toBe(now);
    expect(Number(rows[0].aircraftFixedLatitude)).toBeCloseTo(40.5);
    expect(Number(rows[0].aircraftFixedLongitude)).toBeCloseTo(-105.25);
  });
});

describe.skipIf(!mysqlAvailable)('migration 177 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig177'));
    await pool.query('DROP TABLE IF EXISTS nodes');
    await pool.query(`
      CREATE TABLE nodes (
        nodeNum BIGINT NOT NULL,
        nodeId VARCHAR(255) NOT NULL,
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

  it('adds the columns, is idempotent, and round-trips a write', async () => {
    await runMigration177Mysql(pool);
    await expect(runMigration177Mysql(pool)).resolves.toBeUndefined();
    const now = Date.now();
    await pool.query(`INSERT INTO nodes (nodeNum, nodeId, createdAt, updatedAt) VALUES (100, '!00000064', ?, ?)`, [now, now]);
    const [before] = await pool.query(`SELECT aircraftAgedOutAt, aircraftFixedAt FROM nodes WHERE nodeNum = 100`);
    expect((before as any[])[0].aircraftAgedOutAt).toBeNull();
    await pool.query(
      `UPDATE nodes SET aircraftAgedOutAt = ?, aircraftFixedAt = ?, aircraftFixedLatitude = 40.5, aircraftFixedLongitude = -105.25 WHERE nodeNum = 100`,
      [now, now],
    );
    const [rows] = await pool.query(
      `SELECT aircraftAgedOutAt, aircraftFixedAt, aircraftFixedLatitude, aircraftFixedLongitude FROM nodes WHERE nodeNum = 100`,
    );
    const row = (rows as any[])[0];
    expect(Number(row.aircraftAgedOutAt)).toBe(now);
    expect(Number(row.aircraftFixedAt)).toBe(now);
    expect(Number(row.aircraftFixedLatitude)).toBeCloseTo(40.5);
    expect(Number(row.aircraftFixedLongitude)).toBeCloseTo(-105.25);
  });
});
