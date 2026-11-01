/**
 * Migration 221 — PostgreSQL / MySQL container behaviour (#6125).
 *
 * Guards the same quiet failure as the sibling toggles: if the migration's
 * `ALTER TABLE` and the Drizzle column disagree, saving the preference either
 * throws or silently drops it, and the user's "colour my nodes by source"
 * click appears to work until the next page load.
 *
 * Also pins the default. `FALSE` keeps today's behaviour — the per-source ring
 * is opt-in, so an upgraded install looks unchanged on first load.
 *
 * **Isolation.** Own PostgreSQL schema, own MySQL database — `user_map_preferences`
 * is a fixture table elsewhere, and two suites creating/dropping the same name
 * in one test database is an active race (CLAUDE.md Multi-Database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration221Postgres, runMigration221Mysql } from './221_user_map_preferences_color_nodes_by_source.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;
const PG_SCHEMA = 'ump_migration_221';
const MYSQL_DB = 'meshmonitor_test_ump_221';

/** The table as it stood before `color_nodes_by_source`. */
const PRE_PG = `
  CREATE TABLE user_map_preferences (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    show_mqtt_nodes BOOLEAN DEFAULT TRUE
  )`;
const PRE_MYSQL = `
  CREATE TABLE user_map_preferences (
    id SERIAL PRIMARY KEY,
    userId INT NOT NULL,
    show_mqtt_nodes BOOLEAN DEFAULT TRUE
  )`;

describe.skipIf(!postgresAvailable)('migration 221 — PostgreSQL (container)', () => {
  let pool: InstanceType<typeof PgPool>;

  beforeAll(async () => {
    const admin = new PgPool({ host: 'localhost', port: 5433, user: 'test', password: 'test', database: 'meshmonitor_test' });
    await admin.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${PG_SCHEMA}`);
    await admin.end();

    pool = new PgPool({
      host: 'localhost', port: 5433, user: 'test', password: 'test', database: 'meshmonitor_test',
      options: `-c search_path=${PG_SCHEMA}`,
    });
    await pool.query(PRE_PG);
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
      await pool.end();
    }
  });

  it('adds the column, defaults it FALSE, and runs twice safely', async () => {
    const client = await pool.connect();
    try {
      await runMigration221Postgres(client);
      // A crash between the migration and its ledger write re-runs it.
      await expect(runMigration221Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    await pool.query(`INSERT INTO user_map_preferences ("userId") VALUES (1)`);
    const { rows } = await pool.query(
      `SELECT color_nodes_by_source FROM user_map_preferences WHERE "userId" = 1`,
    );
    expect(rows[0].color_nodes_by_source).toBe(false);
  });

  it('round-trips an explicit TRUE — the whole point of the toggle', async () => {
    await pool.query(`INSERT INTO user_map_preferences ("userId", color_nodes_by_source) VALUES (2, TRUE)`);
    const { rows } = await pool.query(
      `SELECT color_nodes_by_source FROM user_map_preferences WHERE "userId" = 2`,
    );
    expect(rows[0].color_nodes_by_source).toBe(true);
  });
});

describe.skipIf(!mysqlAvailable)('migration 221 — MySQL (container)', () => {
  let pool: mysql.Pool;

  beforeAll(async () => {
    const admin = mysql.createPool({ host: 'localhost', port: 3307, user: 'root', password: 'root', connectionLimit: 1 });
    await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
    await admin.query(`CREATE DATABASE \`${MYSQL_DB}\``);
    await admin.query(`GRANT ALL ON \`${MYSQL_DB}\`.* TO 'test'@'%'`);
    await admin.query('FLUSH PRIVILEGES');
    await admin.end();

    pool = mysql.createPool({ host: 'localhost', port: 3307, user: 'test', password: 'test', database: MYSQL_DB, connectionLimit: 5 });
    await pool.query(PRE_MYSQL);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    const admin = mysql.createPool({ host: 'localhost', port: 3307, user: 'root', password: 'root', connectionLimit: 1 });
    await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
    await admin.end();
  });

  it('adds the column, defaults it FALSE, and runs twice safely', async () => {
    await runMigration221Mysql(pool);
    await expect(runMigration221Mysql(pool)).resolves.toBeUndefined();

    await pool.query(`INSERT INTO user_map_preferences (userId) VALUES (1)`);
    const [rows] = await pool.query(
      `SELECT color_nodes_by_source FROM user_map_preferences WHERE userId = 1`,
    );
    // MySQL BOOLEAN is TINYINT(1); 0 is the stored FALSE.
    expect(Number((rows as Array<{ color_nodes_by_source: number }>)[0].color_nodes_by_source)).toBe(0);
  });

  it('round-trips an explicit TRUE — the whole point of the toggle', async () => {
    await pool.query(`INSERT INTO user_map_preferences (userId, color_nodes_by_source) VALUES (2, TRUE)`);
    const [rows] = await pool.query(
      `SELECT color_nodes_by_source FROM user_map_preferences WHERE userId = 2`,
    );
    expect(Number((rows as Array<{ color_nodes_by_source: number }>)[0].color_nodes_by_source)).toBe(1);
  });
});
