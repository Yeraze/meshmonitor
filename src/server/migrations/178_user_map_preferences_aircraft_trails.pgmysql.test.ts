/**
 * Migration 178 — PostgreSQL / MySQL container behaviour (#5364/#5365 Phase 3).
 *
 * Own isolated per-suite database via `createIsolatedPostgresDatabase` /
 * `createIsolatedMysqlDatabase` — `user_map_preferences` is a fixture table
 * elsewhere, and two suites creating/dropping the same name in one shared
 * test database race (CLAUDE.md Multi-Database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration178Postgres, runMigration178Mysql } from './178_user_map_preferences_aircraft_trails.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 178 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig178'));
    await pool.query('DROP TABLE IF EXISTS user_map_preferences CASCADE');
    await pool.query(`
      CREATE TABLE user_map_preferences (
        id SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL,
        spread_nodes BOOLEAN DEFAULT TRUE
      )
    `);
    await pool.query(`INSERT INTO user_map_preferences ("userId") VALUES (1)`);
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds both columns with defaults, is idempotent, and round-trips values', async () => {
    const client = await pool.connect();
    try {
      await runMigration178Postgres(client);
      await expect(runMigration178Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    const { rows: before } = await pool.query(
      `SELECT show_aircraft_trails, aircraft_trail_hours FROM user_map_preferences WHERE "userId" = 1`,
    );
    expect(before[0].show_aircraft_trails).toBe(false);
    expect(before[0].aircraft_trail_hours).toBe(6);

    await pool.query(`UPDATE user_map_preferences SET show_aircraft_trails = TRUE, aircraft_trail_hours = 72 WHERE "userId" = 1`);
    const { rows } = await pool.query(
      `SELECT show_aircraft_trails, aircraft_trail_hours FROM user_map_preferences WHERE "userId" = 1`,
    );
    expect(rows[0].show_aircraft_trails).toBe(true);
    expect(rows[0].aircraft_trail_hours).toBe(72);
  });
});

describe.skipIf(!mysqlAvailable)('migration 178 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig178'));
    await pool.query('DROP TABLE IF EXISTS user_map_preferences');
    await pool.query(`
      CREATE TABLE user_map_preferences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        userId INT NOT NULL,
        spread_nodes BOOLEAN DEFAULT TRUE
      )
    `);
    await pool.query(`INSERT INTO user_map_preferences (userId) VALUES (1)`);
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds both columns with defaults, is idempotent, and round-trips values', async () => {
    await runMigration178Mysql(pool);
    await expect(runMigration178Mysql(pool)).resolves.toBeUndefined();

    const [before] = await pool.query(
      `SELECT show_aircraft_trails, aircraft_trail_hours FROM user_map_preferences WHERE userId = 1`,
    );
    expect(Number((before as any[])[0].show_aircraft_trails)).toBe(0);
    expect(Number((before as any[])[0].aircraft_trail_hours)).toBe(6);

    await pool.query(`UPDATE user_map_preferences SET show_aircraft_trails = TRUE, aircraft_trail_hours = 72 WHERE userId = 1`);
    const [rows] = await pool.query(
      `SELECT show_aircraft_trails, aircraft_trail_hours FROM user_map_preferences WHERE userId = 1`,
    );
    expect(Number((rows as any[])[0].show_aircraft_trails)).toBe(1);
    expect(Number((rows as any[])[0].aircraft_trail_hours)).toBe(72);
  });
});
