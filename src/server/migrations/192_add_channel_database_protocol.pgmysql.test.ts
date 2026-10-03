/**
 * Migration 192 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration192Postgres, runMigration192Mysql } from './192_add_channel_database_protocol.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 192 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig192'));
    await pool.query(`
      CREATE TABLE channel_database (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        psk TEXT NOT NULL,
        "pskLength" INTEGER NOT NULL
      )
    `);
    await pool.query(`INSERT INTO channel_database (name, psk, "pskLength") VALUES ('old', 'AQ==', 1)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the column with a meshtastic default, is idempotent, and stores meshcore', async () => {
    const client = await pool.connect();
    try {
      await runMigration192Postgres(client);
      await expect(runMigration192Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    await pool.query(`INSERT INTO channel_database (name, psk, "pskLength", protocol) VALUES ('mc', 'x', 16, 'meshcore')`);
    await pool.query(`INSERT INTO channel_database (name, psk, "pskLength") VALUES ('new', 'AQ==', 1)`);
    const { rows } = await pool.query(`SELECT name, protocol FROM channel_database ORDER BY id`);
    expect(rows).toEqual([
      { name: 'old', protocol: 'meshtastic' },
      { name: 'mc', protocol: 'meshcore' },
      { name: 'new', protocol: 'meshtastic' },
    ]);
    const { rows: cols } = await pool.query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'channel_database' AND column_name = 'protocol'`,
    );
    expect(cols[0].is_nullable).toBe('NO');
  });
});

describe.skipIf(!mysqlAvailable)('migration 192 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig192'));
    await pool.query(`
      CREATE TABLE channel_database (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        psk VARCHAR(255) NOT NULL,
        pskLength INT NOT NULL
      )
    `);
    await pool.query(`INSERT INTO channel_database (name, psk, pskLength) VALUES ('old', 'AQ==', 1)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the column with a meshtastic default, is idempotent, and stores meshcore', async () => {
    await runMigration192Mysql(pool);
    await expect(runMigration192Mysql(pool)).resolves.toBeUndefined();
    await pool.query(`INSERT INTO channel_database (name, psk, pskLength, protocol) VALUES ('mc', 'x', 16, 'meshcore')`);
    await pool.query(`INSERT INTO channel_database (name, psk, pskLength) VALUES ('new', 'AQ==', 1)`);
    const [rows] = await pool.query(`SELECT name, protocol FROM channel_database ORDER BY id`);
    expect(rows).toEqual([
      { name: 'old', protocol: 'meshtastic' },
      { name: 'mc', protocol: 'meshcore' },
      { name: 'new', protocol: 'meshtastic' },
    ]);
    const [cols] = await pool.query(
      `SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'channel_database' AND COLUMN_NAME = 'protocol'`,
    );
    expect((cols as Array<{ IS_NULLABLE: string }>)[0].IS_NULLABLE).toBe('NO');
  });
});
