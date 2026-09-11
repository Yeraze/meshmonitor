/**
 * Migration 164 — PostgreSQL / MySQL container behaviour (#5177).
 *
 * The failure this guards is quiet rather than loud: if the migration's
 * `ALTER TABLE` and the Drizzle column disagree, saving the preference either
 * throws or silently drops it, and the user's "stop moving my nodes" click
 * appears to work until the next page load spreads them again.
 *
 * Also pins the default. `TRUE` preserves the existing within-cell offset
 * (#4016/#4155) for every user who has not asked for anything different — this
 * migration adds a choice, it does not change what an upgraded install looks
 * like on first load.
 *
 * **Isolation.** Own PostgreSQL schema, own MySQL database — `user_map_preferences`
 * is a fixture table elsewhere, and two suites creating/dropping the same name
 * in one test database is an active race (CLAUDE.md Multi-Database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration164Postgres, runMigration164Mysql } from './164_user_map_preferences_spread_nodes.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;
const PG_SCHEMA = 'ump_migration_164';
const MYSQL_DB = 'meshmonitor_test_ump_164';

/** The table as it stood at migration 163 — no `spread_nodes`. */
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

describe.skipIf(!postgresAvailable)('migration 164 — PostgreSQL (container)', () => {
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

  it('adds the column, defaults it TRUE, and runs twice safely', async () => {
    const client = await pool.connect();
    try {
      await runMigration164Postgres(client);
      // A crash between the migration and its ledger write re-runs it.
      await expect(runMigration164Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    await pool.query(`INSERT INTO user_map_preferences ("userId") VALUES (1)`);
    const { rows } = await pool.query(
      `SELECT spread_nodes FROM user_map_preferences WHERE "userId" = 1`,
    );
    expect(rows[0].spread_nodes).toBe(true);
  });

  it('round-trips an explicit FALSE — the whole point of the toggle', async () => {
    await pool.query(`INSERT INTO user_map_preferences ("userId", spread_nodes) VALUES (2, FALSE)`);
    const { rows } = await pool.query(
      `SELECT spread_nodes FROM user_map_preferences WHERE "userId" = 2`,
    );
    expect(rows[0].spread_nodes).toBe(false);
  });
});

describe.skipIf(!mysqlAvailable)('migration 164 — MySQL (container)', () => {
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

  it('adds the column, defaults it TRUE, and runs twice safely', async () => {
    await runMigration164Mysql(pool);
    await expect(runMigration164Mysql(pool)).resolves.toBeUndefined();

    await pool.query(`INSERT INTO user_map_preferences (userId) VALUES (1)`);
    const [rows] = await pool.query(
      `SELECT spread_nodes FROM user_map_preferences WHERE userId = 1`,
    );
    // MySQL BOOLEAN is TINYINT(1); 1 is the stored TRUE.
    expect(Number((rows as Array<{ spread_nodes: number }>)[0].spread_nodes)).toBe(1);
  });

  it('round-trips an explicit FALSE — the whole point of the toggle', async () => {
    await pool.query(`INSERT INTO user_map_preferences (userId, spread_nodes) VALUES (2, FALSE)`);
    const [rows] = await pool.query(
      `SELECT spread_nodes FROM user_map_preferences WHERE userId = 2`,
    );
    expect(Number((rows as Array<{ spread_nodes: number }>)[0].spread_nodes)).toBe(0);
  });
});
