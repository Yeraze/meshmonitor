/**
 * migration 223 (#6195) — PostgreSQL + MySQL coverage for
 * `meshcore_source_pki_keys`. Skips silently when no container is listening, so
 * confirm coverage via `numPendingTests`; CI runs both as service containers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration223Postgres, runMigration223Mysql } from './223_add_meshcore_source_pki_keys.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 223 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig223'));
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table and is idempotent, keyMismatch defaults to 0', async () => {
    const client = await pool.connect();
    try {
      await runMigration223Postgres(client);
      await runMigration223Postgres(client);
    } finally {
      client.release();
    }
    await pool.query(
      `INSERT INTO meshcore_source_pki_keys ("sourceId", "encryptedPrivateKey", "createdAt", "updatedAt") VALUES ('s1', '{}', 1790000000000, 1790000000000)`,
    );
    const { rows } = await pool.query(`SELECT "keyMismatch", "createdAt" FROM meshcore_source_pki_keys WHERE "sourceId" = 's1'`);
    expect(rows[0].keyMismatch).toBe(0);
    expect(Number(rows[0].createdAt)).toBe(1790000000000);
    await expect(
      pool.query(`INSERT INTO meshcore_source_pki_keys ("sourceId", "encryptedPrivateKey", "createdAt", "updatedAt") VALUES ('s1', '{}', 2, 2)`),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe.skipIf(!mysqlAvailable)('migration 223 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig223'));
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table and is idempotent, keyMismatch defaults to 0', async () => {
    await runMigration223Mysql(pool);
    await runMigration223Mysql(pool);
    await pool.query(
      `INSERT INTO meshcore_source_pki_keys (sourceId, encryptedPrivateKey, createdAt, updatedAt) VALUES ('s1', '{}', 1790000000000, 1790000000000)`,
    );
    const [rows] = await pool.query(`SELECT keyMismatch, createdAt FROM meshcore_source_pki_keys WHERE sourceId = 's1'`);
    const row = (rows as Array<{ keyMismatch: number; createdAt: unknown }>)[0];
    expect(row.keyMismatch).toBe(0);
    expect(Number(row.createdAt)).toBe(1790000000000);
    await expect(
      pool.query(`INSERT INTO meshcore_source_pki_keys (sourceId, encryptedPrivateKey, createdAt, updatedAt) VALUES ('s1', '{}', 2, 2)`),
    ).rejects.toThrow(/Duplicate entry/);
  });
});
