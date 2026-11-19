/**
 * Migration 241 — PostgreSQL / MySQL container behaviour (#5254).
 *
 * Guards the column the Drizzle schema reads, and pins its default: FALSE, so
 * an upgraded install keeps a DM-only badge until the user opts in.
 *
 * **Isolation.** Own PostgreSQL schema, own MySQL database — `user_map_preferences`
 * is a fixture table elsewhere (CLAUDE.md Multi-Database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration241Postgres, runMigration241Mysql } from './241_user_map_preferences_unread_include_replies.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;
const PG_SCHEMA = 'ump_migration_241';
const MYSQL_DB = 'meshmonitor_test_ump_241';

/** The table as it stood at migration 240 — no `unread_include_replies`. */
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

describe.skipIf(!postgresAvailable)('migration 241 — PostgreSQL (container)', () => {
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
      await runMigration241Postgres(client);
      // A crash between the migration and its ledger write re-runs it.
      await expect(runMigration241Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    await pool.query(`INSERT INTO user_map_preferences ("userId") VALUES (1)`);
    const { rows } = await pool.query(
      `SELECT unread_include_replies FROM user_map_preferences WHERE "userId" = 1`,
    );
    expect(rows[0].unread_include_replies).toBe(false);
  });
});

describe.skipIf(!mysqlAvailable)('migration 241 — MySQL (container)', () => {
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
    await runMigration241Mysql(pool);
    await expect(runMigration241Mysql(pool)).resolves.toBeUndefined();

    await pool.query(`INSERT INTO user_map_preferences (userId) VALUES (1)`);
    const [rows] = await pool.query(
      `SELECT unread_include_replies FROM user_map_preferences WHERE userId = 1`,
    );
    // MySQL BOOLEAN is TINYINT(1); 0 is the stored FALSE.
    expect(Number((rows as Array<{ unread_include_replies: number }>)[0].unread_include_replies)).toBe(0);
  });
});
