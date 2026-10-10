/**
 * Migration 200 (#5715) — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration200Postgres, runMigration200Mysql } from './200_add_node_aircraft_manual_mark.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 200 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig200'));
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
      await runMigration200Postgres(client);
      await expect(runMigration200Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const now = Date.now();
    await pool.query(`INSERT INTO nodes ("nodeNum", "nodeId", "createdAt", "updatedAt") VALUES (100, '!00000064', $1, $1)`, [now]);
    const { rows: before } = await pool.query(`SELECT "aircraftManualMark", "aircraftManualMarkAt", "aircraftManualMarkBy" FROM nodes WHERE "nodeNum" = 100`);
    expect(before[0]).toEqual({ aircraftManualMark: null, aircraftManualMarkAt: null, aircraftManualMarkBy: null });
    await pool.query(
      `UPDATE nodes SET "aircraftManualMark" = 'aircraft', "aircraftManualMarkAt" = $1, "aircraftManualMarkBy" = 3 WHERE "nodeNum" = 100`,
      [now],
    );
    const { rows } = await pool.query(`SELECT "aircraftManualMark", "aircraftManualMarkAt", "aircraftManualMarkBy" FROM nodes WHERE "nodeNum" = 100`);
    expect(rows[0].aircraftManualMark).toBe('aircraft');
    expect(Number(rows[0].aircraftManualMarkAt)).toBe(now);
    expect(Number(rows[0].aircraftManualMarkBy)).toBe(3);
  });
});

describe.skipIf(!mysqlAvailable)('migration 200 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig200'));
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
    await runMigration200Mysql(pool);
    await expect(runMigration200Mysql(pool)).resolves.toBeUndefined();
    const now = Date.now();
    await pool.query(`INSERT INTO nodes (nodeNum, nodeId, createdAt, updatedAt) VALUES (100, '!00000064', ?, ?)`, [now, now]);
    await pool.query(
      `UPDATE nodes SET aircraftManualMark = 'not_aircraft', aircraftManualMarkAt = ?, aircraftManualMarkBy = 3 WHERE nodeNum = 100`,
      [now],
    );
    const [rows] = await pool.query(`SELECT aircraftManualMark, aircraftManualMarkAt, aircraftManualMarkBy FROM nodes WHERE nodeNum = 100`);
    const row = (rows as any[])[0];
    expect(row.aircraftManualMark).toBe('not_aircraft');
    expect(Number(row.aircraftManualMarkAt)).toBe(now);
    expect(Number(row.aircraftManualMarkBy)).toBe(3);
  });
});
