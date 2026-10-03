/**
 * Migration 189 — PostgreSQL / MySQL against the live test containers (#5558).
 * Skips silently when the containers are not up; confirm via numPendingTests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration189Postgres, runMigration189Mysql } from './189_global_ui_prefs_drop_source_copies.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const PG_CREATE = `
  DROP TABLE IF EXISTS settings CASCADE;
  DROP TABLE IF EXISTS sources CASCADE;
  CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );
`;

const MYSQL_CREATE = [
  'DROP TABLE IF EXISTS settings',
  'DROP TABLE IF EXISTS sources',
  'CREATE TABLE sources (id VARCHAR(64) PRIMARY KEY, name VARCHAR(255) NOT NULL)',
  'CREATE TABLE settings (`key` VARCHAR(255) PRIMARY KEY, value TEXT NOT NULL, createdAt BIGINT NOT NULL, updatedAt BIGINT NOT NULL)',
];

/** Two live sources agreeing on dark/mocha; one deleted source voting light. */
const SOURCES = ['a', 'b'];
const SEED: Record<string, string> = {
  'source:a:appearanceMode': 'dark', 'source:a:darkTheme': 'mocha', 'source:a:lightTheme': 'mocha',
  'source:b:appearanceMode': 'dark', 'source:b:darkTheme': 'mocha', 'source:b:lightTheme': 'mocha',
  'source:gone:appearanceMode': 'light',
  'source:a:temperatureUnit': 'F', // global set below → global wins
  'source:a:maxNodeAgeHours': '48', // per-source key, untouched
  appearanceMode: 'system',        // default → promotion allowed
  temperatureUnit: 'C',
};
const EXPECTED: Record<string, string> = {
  appearanceMode: 'dark', darkTheme: 'mocha', lightTheme: 'mocha',
  temperatureUnit: 'C',
  'source:a:maxNodeAgeHours': '48',
};

describe.skipIf(!postgresAvailable)('migration 189 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig189'));
  });
  afterAll(async () => { await cleanup?.(); });
  beforeEach(async () => { await pool.query(PG_CREATE); });

  const run = async () => {
    const client = await pool.connect();
    try { await runMigration189Postgres(client); } finally { client.release(); }
  };
  const all = async () => {
    const { rows } = await pool.query(`SELECT key, value FROM settings`);
    return Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
  };

  it('promotes the unanimous set, deletes every copy, and is idempotent', async () => {
    for (const id of SOURCES) await pool.query(`INSERT INTO sources (id, name) VALUES ($1, $1)`, [id]);
    for (const [k, v] of Object.entries(SEED)) {
      await pool.query(`INSERT INTO settings (key, value, "createdAt", "updatedAt") VALUES ($1, $2, 1, 1)`, [k, v]);
    }
    await run();
    expect(await all()).toEqual(EXPECTED);
    await run();
    expect(await all()).toEqual(EXPECTED);
  });

  it('keeps a chosen global theme when sources disagree with it', async () => {
    await pool.query(`INSERT INTO sources (id, name) VALUES ('a', 'a')`);
    await pool.query(`INSERT INTO settings (key, value, "createdAt", "updatedAt") VALUES
      ('appearanceMode', 'light', 1, 1), ('source:a:appearanceMode', 'dark', 1, 1)`);
    await run();
    expect(await all()).toEqual({ appearanceMode: 'light' });
  });

  it('runs without a sources table', async () => {
    await pool.query('DROP TABLE sources');
    await pool.query(`INSERT INTO settings (key, value, "createdAt", "updatedAt") VALUES ('source:x:timeFormat', '12', 1, 1)`);
    await run();
    expect(await all()).toEqual({ timeFormat: '12' });
  });
});

describe.skipIf(!mysqlAvailable)('migration 189 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig189'));
  });
  afterAll(async () => { await cleanup?.(); });
  beforeEach(async () => { for (const s of MYSQL_CREATE) await pool.query(s); });

  const all = async () => {
    const [rows] = await pool.query('SELECT `key`, value FROM settings');
    return Object.fromEntries((rows as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
  };

  it('promotes the unanimous set, deletes every copy, and is idempotent', async () => {
    for (const id of SOURCES) await pool.query('INSERT INTO sources (id, name) VALUES (?, ?)', [id, id]);
    for (const [k, v] of Object.entries(SEED)) {
      await pool.query('INSERT INTO settings (`key`, value, createdAt, updatedAt) VALUES (?, ?, 1, 1)', [k, v]);
    }
    await runMigration189Mysql(pool);
    expect(await all()).toEqual(EXPECTED);
    await runMigration189Mysql(pool);
    expect(await all()).toEqual(EXPECTED);
  });

  it('keeps a chosen global theme when sources disagree with it', async () => {
    await pool.query("INSERT INTO sources (id, name) VALUES ('a', 'a')");
    await pool.query("INSERT INTO settings (`key`, value, createdAt, updatedAt) VALUES ('appearanceMode', 'light', 1, 1), ('source:a:appearanceMode', 'dark', 1, 1)");
    await runMigration189Mysql(pool);
    expect(await all()).toEqual({ appearanceMode: 'light' });
  });

  it('runs without a sources table', async () => {
    await pool.query('DROP TABLE sources');
    await pool.query("INSERT INTO settings (`key`, value, createdAt, updatedAt) VALUES ('source:x:timeFormat', '12', 1, 1)");
    await runMigration189Mysql(pool);
    expect(await all()).toEqual({ timeFormat: '12' });
  });
});
