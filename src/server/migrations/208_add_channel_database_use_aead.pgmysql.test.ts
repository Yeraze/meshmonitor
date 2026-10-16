/**
 * Migration 208 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration208Postgres, runMigration208Mysql } from './208_add_channel_database_use_aead.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 208 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig208'));
    await pool.query(`CREATE TABLE channel_database (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`);
    await pool.query(`INSERT INTO channel_database (name) VALUES ('old')`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds a NOT NULL false-default column and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration208Postgres(client);
      await expect(runMigration208Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    await pool.query(`INSERT INTO channel_database (name, "useAead") VALUES ('aead', true)`);
    const { rows } = await pool.query(`SELECT name, "useAead" FROM channel_database ORDER BY id`);
    expect(rows).toEqual([
      { name: 'old', useAead: false },
      { name: 'aead', useAead: true },
    ]);
    const { rows: cols } = await pool.query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'channel_database' AND column_name = 'useAead'`,
    );
    expect(cols[0].is_nullable).toBe('NO');
  });
});

describe.skipIf(!mysqlAvailable)('migration 208 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig208'));
    await pool.query(`CREATE TABLE channel_database (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL)`);
    await pool.query(`INSERT INTO channel_database (name) VALUES ('old')`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds a NOT NULL false-default column and is idempotent', async () => {
    await runMigration208Mysql(pool);
    await expect(runMigration208Mysql(pool)).resolves.toBeUndefined();
    await pool.query(`INSERT INTO channel_database (name, useAead) VALUES ('aead', true)`);
    const [rows] = await pool.query(`SELECT name, useAead FROM channel_database ORDER BY id`);
    expect(rows).toEqual([
      { name: 'old', useAead: 0 },
      { name: 'aead', useAead: 1 },
    ]);
    const [cols] = await pool.query(
      `SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'channel_database' AND COLUMN_NAME = 'useAead'`,
    );
    expect((cols as Array<{ IS_NULLABLE: string }>)[0].IS_NULLABLE).toBe('NO');
  });
});
