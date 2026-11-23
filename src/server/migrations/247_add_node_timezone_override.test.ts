/**
 * Migration 247 (#6523): `timezoneOverride` on nodes and meshcore_nodes, on
 * SQLite, PostgreSQL and MySQL. PG/MySQL blocks use isolated databases.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { migration, runMigration247Postgres, runMigration247Mysql } from './247_add_node_timezone_override.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const TABLES = ['nodes', 'meshcore_nodes'];

describe('Migration 247 — SQLite', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE nodes (nodeNum INTEGER, sourceId TEXT, longName TEXT)`);
    db.exec(`CREATE TABLE meshcore_nodes (sourceId TEXT, publicKey TEXT, name TEXT)`);
    db.exec(`INSERT INTO nodes VALUES (1, 'src-1', 'n')`);
    db.exec(`INSERT INTO meshcore_nodes VALUES ('src-1', 'aa', 'n')`);
  });

  it('adds a null column on both tables and keeps data', () => {
    migration.up(db);
    for (const t of TABLES) {
      const row = db.prepare(`SELECT * FROM ${t}`).get() as Record<string, unknown>;
      expect(row.timezoneOverride).toBeNull();
    }
    expect((db.prepare(`SELECT longName FROM nodes`).get() as { longName: string }).longName).toBe('n');
  });

  it('is idempotent', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    for (const t of TABLES) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).filter(
        (c) => c.name === 'timezoneOverride',
      );
      expect(cols).toHaveLength(1);
    }
  });
});

describe.skipIf(!postgresAvailable)('Migration 247 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig247'));
    await pool.query(`CREATE TABLE nodes ("nodeNum" BIGINT, "sourceId" TEXT)`);
    await pool.query(`CREATE TABLE meshcore_nodes ("sourceId" TEXT, "publicKey" TEXT)`);
    await pool.query(`INSERT INTO nodes VALUES (1, 'src-1')`);
    await pool.query(`INSERT INTO meshcore_nodes VALUES ('src-1', 'aa')`);
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the column and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration247Postgres(client);
      await expect(runMigration247Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    for (const t of TABLES) {
      const { rows } = await pool.query(`SELECT "timezoneOverride" FROM ${t}`);
      expect(rows[0].timezoneOverride).toBeNull();
    }
  });
});

describe.skipIf(!mysqlAvailable)('Migration 247 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig247'));
    await pool.query(`CREATE TABLE nodes (nodeNum BIGINT, sourceId VARCHAR(64))`);
    await pool.query(`CREATE TABLE meshcore_nodes (sourceId VARCHAR(64), publicKey VARCHAR(64))`);
    await pool.query(`INSERT INTO nodes VALUES (1, 'src-1')`);
    await pool.query(`INSERT INTO meshcore_nodes VALUES ('src-1', 'aa')`);
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the column and is idempotent', async () => {
    await runMigration247Mysql(pool);
    await expect(runMigration247Mysql(pool)).resolves.toBeUndefined();
    for (const t of TABLES) {
      const [rows] = await pool.query(`SELECT timezoneOverride FROM ${t}`);
      expect((rows as Array<Record<string, unknown>>)[0].timezoneOverride).toBeNull();
    }
  });
});
