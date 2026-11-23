/**
 * migration 246 — PostgreSQL + MySQL coverage for dropping `solar_estimates`.
 * Skips silently when no container is listening, so confirm coverage via
 * `numPendingTests`; CI runs both as service containers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration246Postgres, runMigration246Mysql } from './246_drop_solar_estimates.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 246 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig246'));
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('drops the table and is idempotent', async () => {
    await pool.query(`CREATE TABLE solar_estimates (id SERIAL PRIMARY KEY, "timestamp" BIGINT, watt_hours DOUBLE PRECISION, fetched_at BIGINT)`);
    await pool.query(`INSERT INTO solar_estimates ("timestamp", watt_hours, fetched_at) VALUES (1, 2, 3)`);
    const client = await pool.connect();
    try {
      await runMigration246Postgres(client);
      await runMigration246Postgres(client);
    } finally {
      client.release();
    }
    const { rows } = await pool.query(`SELECT to_regclass('solar_estimates') AS t`);
    expect(rows[0].t).toBeNull();
  });
});

describe.skipIf(!mysqlAvailable)('migration 246 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig246'));
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('drops the table and is idempotent', async () => {
    await pool.query(`CREATE TABLE solar_estimates (id INT AUTO_INCREMENT PRIMARY KEY, timestamp BIGINT, watt_hours DOUBLE, fetched_at BIGINT)`);
    await pool.query(`INSERT INTO solar_estimates (timestamp, watt_hours, fetched_at) VALUES (1, 2, 3)`);
    await runMigration246Mysql(pool);
    await runMigration246Mysql(pool);
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'solar_estimates'`,
    );
    expect(Number((rows as Array<{ n: unknown }>)[0].n)).toBe(0);
  });
});
