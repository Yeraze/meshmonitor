/**
 * migration 219 — creates automation_fire_state on all three backends and is
 * idempotent. A silent PG/MySQL skip still reports success; confirm via
 * `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { migration, runMigration219Postgres, runMigration219Mysql } from './219_automation_fire_state.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe('migration 219 — SQLite', () => {
  it('creates the table + unique index and is idempotent', () => {
    const db = new Database(':memory:');
    migration.up(db);
    migration.up(db);
    const cols = (db.prepare(`PRAGMA table_info(automation_fire_state)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['id', 'automationId', 'kind', 'scopeKey', 'firedAt', 'events']);
    db.prepare(`INSERT INTO automation_fire_state (automationId, kind, scopeKey, firedAt) VALUES ('a', 'cooldown', '', 1)`).run();
    expect(() =>
      db.prepare(`INSERT INTO automation_fire_state (automationId, kind, scopeKey, firedAt) VALUES ('a', 'cooldown', '', 2)`).run(),
    ).toThrow(/UNIQUE/);
    db.close();
  });
});

describe.skipIf(!postgresAvailable)('migration 219 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig219'));
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table + unique index and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration219Postgres(client);
      await runMigration219Postgres(client);
    } finally {
      client.release();
    }
    await pool.query(`INSERT INTO automation_fire_state ("automationId", kind, "scopeKey", "firedAt") VALUES ('a', 'cooldown', '', 1790000000000)`);
    await expect(
      pool.query(`INSERT INTO automation_fire_state ("automationId", kind, "scopeKey", "firedAt") VALUES ('a', 'cooldown', '', 2)`),
    ).rejects.toThrow(/duplicate key/);
    const { rows } = await pool.query(`SELECT "firedAt" FROM automation_fire_state`);
    expect(Number(rows[0].firedAt)).toBe(1790000000000);
  });
});

describe.skipIf(!mysqlAvailable)('migration 219 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig219'));
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table + unique index and is idempotent', async () => {
    await runMigration219Mysql(pool);
    await runMigration219Mysql(pool);
    await pool.query(`INSERT INTO automation_fire_state (automationId, kind, scopeKey, firedAt) VALUES ('a', 'cooldown', '', 1790000000000)`);
    await expect(
      pool.query(`INSERT INTO automation_fire_state (automationId, kind, scopeKey, firedAt) VALUES ('a', 'cooldown', '', 2)`),
    ).rejects.toThrow(/Duplicate entry/);
    const [rows] = await pool.query(`SELECT firedAt FROM automation_fire_state`);
    expect(Number((rows as Array<{ firedAt: unknown }>)[0].firedAt)).toBe(1790000000000);
  });
});
