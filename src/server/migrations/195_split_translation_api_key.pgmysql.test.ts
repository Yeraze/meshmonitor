/**
 * Migration 195 — PostgreSQL / MySQL against the live test containers (#5518).
 * Skips silently when the containers are not up; confirm via numPendingTests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration195Postgres, runMigration195Mysql } from './195_split_translation_api_key.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const PG_CREATE = `
  DROP TABLE IF EXISTS settings CASCADE;
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );
`;

const MYSQL_CREATE = [
  'DROP TABLE IF EXISTS settings',
  'CREATE TABLE settings (`key` VARCHAR(255) PRIMARY KEY, value TEXT NOT NULL, createdAt BIGINT NOT NULL, updatedAt BIGINT NOT NULL)',
];

interface Case { name: string; seed: Record<string, string>; expected: Record<string, string> }

/** Each case is run twice: the second run must change nothing. */
const CASES: Case[] = [
  {
    name: 'gives the key to the active provider only and removes the old row',
    seed: {
      translationProvider: 'deepl', translationApiKey: 'deepl-key:fx',
      translationUrl: 'http://libre:5000', 'source:a:translationApiKey': 'stale', maxNodeAgeHours: '24',
    },
    expected: {
      translationProvider: 'deepl', translationDeeplApiKey: 'deepl-key:fx',
      translationUrl: 'http://libre:5000', maxNodeAgeHours: '24',
    },
  },
  {
    name: 'defaults to libretranslate when no provider is stored',
    seed: { translationApiKey: 'libre-key' },
    expected: { translationLibreTranslateApiKey: 'libre-key' },
  },
  {
    name: 'does not overwrite an existing new key',
    seed: { translationProvider: 'openai', translationApiKey: 'old', translationOpenAiApiKey: 'sk-new' },
    expected: { translationProvider: 'openai', translationOpenAiApiKey: 'sk-new' },
  },
  {
    name: 'does nothing when no key was ever stored',
    seed: { translationProvider: 'google', translationEnabled: 'true' },
    expected: { translationProvider: 'google', translationEnabled: 'true' },
  },
  { name: 'runs on an empty settings table', seed: {}, expected: {} },
];

describe.skipIf(!postgresAvailable)('migration 195 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig195'));
  });
  afterAll(async () => { await cleanup?.(); });
  beforeEach(async () => { await pool.query(PG_CREATE); });

  const run = async () => {
    const client = await pool.connect();
    try { await runMigration195Postgres(client); } finally { client.release(); }
  };
  const all = async () => {
    const { rows } = await pool.query(`SELECT key, value FROM settings`);
    return Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
  };

  it.each(CASES)('$name (re-run is a no-op)', async ({ seed, expected }) => {
    for (const [k, v] of Object.entries(seed)) {
      await pool.query(`INSERT INTO settings (key, value, "createdAt", "updatedAt") VALUES ($1, $2, 1, 1)`, [k, v]);
    }
    await run();
    expect(await all()).toEqual(expected);
    await run();
    expect(await all()).toEqual(expected);
  });
});

describe.skipIf(!mysqlAvailable)('migration 195 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig195'));
  });
  afterAll(async () => { await cleanup?.(); });
  beforeEach(async () => { for (const s of MYSQL_CREATE) await pool.query(s); });

  const all = async () => {
    const [rows] = await pool.query('SELECT `key`, value FROM settings');
    return Object.fromEntries((rows as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
  };

  it.each(CASES)('$name (re-run is a no-op)', async ({ seed, expected }) => {
    for (const [k, v] of Object.entries(seed)) {
      await pool.query('INSERT INTO settings (`key`, value, createdAt, updatedAt) VALUES (?, ?, 1, 1)', [k, v]);
    }
    await runMigration195Mysql(pool);
    expect(await all()).toEqual(expected);
    await runMigration195Mysql(pool);
    expect(await all()).toEqual(expected);
  });
});
