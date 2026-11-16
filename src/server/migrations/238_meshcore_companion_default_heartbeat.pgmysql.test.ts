/**
 * Migration 238 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration238Postgres, runMigration238Mysql } from './238_meshcore_companion_default_heartbeat.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const ROWS: Array<[string, string, string]> = [
  ['c-none', 'meshcore', JSON.stringify({ transport: 'usb', deviceType: 'companion', autoConnect: true })],
  ['c-nodt', 'meshcore', JSON.stringify({ transport: 'tcp' })],
  ['c-zero', 'meshcore', JSON.stringify({ deviceType: 'companion', heartbeatIntervalSeconds: 0 })],
  ['c-30', 'meshcore', JSON.stringify({ deviceType: 'companion', heartbeatIntervalSeconds: 30 })],
  ['r-none', 'meshcore', JSON.stringify({ deviceType: 'repeater' })],
  ['t-none', 'meshtastic_tcp', JSON.stringify({ host: 'h' })],
  ['bad', 'meshcore', 'not json'],
];

async function check(read: (id: string) => Promise<string>): Promise<void> {
  const hb = async (id: string) => JSON.parse(await read(id)).heartbeatIntervalSeconds;
  expect(await hb('c-none')).toBe(60);
  expect(JSON.parse(await read('c-none')).autoConnect).toBe(true);
  expect(await hb('c-nodt')).toBe(60);
  expect(await hb('c-zero')).toBe(0);
  expect(await hb('c-30')).toBe(30);
  expect(await hb('r-none')).toBeUndefined();
  expect(await hb('t-none')).toBeUndefined();
  expect(await read('bad')).toBe('not json');
}

describe.skipIf(!postgresAvailable)('migration 238 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  const read = async (id: string) =>
    (await pool.query('SELECT config FROM sources WHERE id = $1', [id])).rows[0].config as string;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig238'));
    await pool.query('DROP TABLE IF EXISTS sources CASCADE');
    await pool.query(`CREATE TABLE sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true, "displayOrder" INTEGER NOT NULL DEFAULT 0,
      "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL, "createdBy" INTEGER)`);
    for (const [id, type, config] of ROWS) {
      await pool.query(
        `INSERT INTO sources (id, name, type, config, "createdAt", "updatedAt") VALUES ($1, $1, $2, $3, 1, 1)`,
        [id, type, config],
      );
    }
  });
  afterAll(async () => { await cleanup?.(); });

  it('adds 60 only where absent on a Companion, and re-runs as a no-op', async () => {
    const client = await pool.connect();
    try {
      await runMigration238Postgres(client);
      await check(read);
      const once = (await pool.query('SELECT id, config FROM sources ORDER BY id')).rows;
      await runMigration238Postgres(client);
      expect((await pool.query('SELECT id, config FROM sources ORDER BY id')).rows).toEqual(once);
    } finally {
      client.release();
    }
  });
});

describe.skipIf(!mysqlAvailable)('migration 238 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  const read = async (id: string) => {
    const [rows] = await pool.query('SELECT config FROM sources WHERE id = ?', [id]);
    return (rows as any[])[0].config as string;
  };

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig238'));
    await pool.query('DROP TABLE IF EXISTS sources');
    await pool.query(`CREATE TABLE sources (
      id VARCHAR(36) PRIMARY KEY, name VARCHAR(255) NOT NULL, type VARCHAR(32) NOT NULL,
      config VARCHAR(4096) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
      displayOrder INT NOT NULL DEFAULT 0, createdAt BIGINT NOT NULL, updatedAt BIGINT NOT NULL, createdBy INT)`);
    for (const [id, type, config] of ROWS) {
      await pool.query(`INSERT INTO sources (id, name, type, config, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, 1)`, [id, id, type, config]);
    }
  });
  afterAll(async () => { await cleanup?.(); });

  it('adds 60 only where absent on a Companion, and re-runs as a no-op', async () => {
    await runMigration238Mysql(pool);
    await check(read);
    const [a] = await pool.query('SELECT id, config FROM sources ORDER BY id');
    await runMigration238Mysql(pool);
    const [b] = await pool.query('SELECT id, config FROM sources ORDER BY id');
    expect(b).toEqual(a);
  });
});
