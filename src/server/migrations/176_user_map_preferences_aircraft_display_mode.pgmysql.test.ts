/**
 * Migration 176 — PostgreSQL / MySQL container behaviour (#5364/#5365).
 *
 * Own isolated per-suite database via `createIsolatedPostgresDatabase` /
 * `createIsolatedMysqlDatabase` — `user_map_preferences` is a fixture table
 * elsewhere, and two suites creating/dropping the same name in one shared
 * test database is an active race (CLAUDE.md Multi-Database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration176Postgres, runMigration176Mysql } from './176_user_map_preferences_aircraft_display_mode.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 176 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig176'));
    await pool.query('DROP TABLE IF EXISTS user_map_preferences CASCADE');
    await pool.query(`
      CREATE TABLE user_map_preferences (
        id SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL,
        spread_nodes BOOLEAN DEFAULT TRUE
      )
    `);
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the column, is idempotent, and round-trips a value', async () => {
    const client = await pool.connect();
    try {
      await runMigration176Postgres(client);
      await expect(runMigration176Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    await pool.query(`INSERT INTO user_map_preferences ("userId") VALUES (1)`);
    const { rows: before } = await pool.query(
      `SELECT aircraft_display_mode FROM user_map_preferences WHERE "userId" = 1`,
    );
    expect(before[0].aircraft_display_mode).toBeNull();

    await pool.query(`UPDATE user_map_preferences SET aircraft_display_mode = 'hide' WHERE "userId" = 1`);
    const { rows } = await pool.query(
      `SELECT aircraft_display_mode FROM user_map_preferences WHERE "userId" = 1`,
    );
    expect(rows[0].aircraft_display_mode).toBe('hide');
  });
});

describe.skipIf(!mysqlAvailable)('migration 176 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig176'));
    await pool.query('DROP TABLE IF EXISTS user_map_preferences');
    await pool.query(`
      CREATE TABLE user_map_preferences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        userId INT NOT NULL,
        spread_nodes BOOLEAN DEFAULT TRUE
      )
    `);
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the column, is idempotent, and round-trips a value', async () => {
    await runMigration176Mysql(pool);
    await expect(runMigration176Mysql(pool)).resolves.toBeUndefined();

    await pool.query(`INSERT INTO user_map_preferences (userId) VALUES (1)`);
    const [before] = await pool.query(`SELECT aircraft_display_mode FROM user_map_preferences WHERE userId = 1`);
    expect((before as any[])[0].aircraft_display_mode).toBeNull();

    await pool.query(`UPDATE user_map_preferences SET aircraft_display_mode = 'hide' WHERE userId = 1`);
    const [rows] = await pool.query(`SELECT aircraft_display_mode FROM user_map_preferences WHERE userId = 1`);
    expect((rows as any[])[0].aircraft_display_mode).toBe('hide');
  });
});
