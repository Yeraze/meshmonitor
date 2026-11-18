/**
 * migration 240 — PostgreSQL + MySQL coverage for `script_secrets`. Skips
 * silently when no container is listening, so confirm coverage via
 * `numPendingTests`; CI runs both as service containers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration240Postgres, runMigration240Mysql } from './240_add_script_secrets.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 240 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig240'));
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table and is idempotent; name is the primary key', async () => {
    const client = await pool.connect();
    try {
      await runMigration240Postgres(client);
      await runMigration240Postgres(client);
    } finally {
      client.release();
    }
    await pool.query(
      `INSERT INTO script_secrets ("name", "encryptedValue", "createdAt", "updatedAt") VALUES ('A', '{}', 1790000000000, 1790000000000)`,
    );
    const { rows } = await pool.query(`SELECT "createdAt" FROM script_secrets WHERE "name" = 'A'`);
    expect(Number(rows[0].createdAt)).toBe(1790000000000);
    await expect(
      pool.query(`INSERT INTO script_secrets ("name", "encryptedValue", "createdAt", "updatedAt") VALUES ('A', '{}', 2, 2)`),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe.skipIf(!mysqlAvailable)('migration 240 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig240'));
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table and is idempotent; name is the primary key', async () => {
    await runMigration240Mysql(pool);
    await runMigration240Mysql(pool);
    await pool.query(
      `INSERT INTO script_secrets (name, encryptedValue, createdAt, updatedAt) VALUES ('A', '{}', 1790000000000, 1790000000000)`,
    );
    const [rows] = await pool.query(`SELECT createdAt FROM script_secrets WHERE name = 'A'`);
    expect(Number((rows as Array<{ createdAt: unknown }>)[0].createdAt)).toBe(1790000000000);
    await expect(
      pool.query(`INSERT INTO script_secrets (name, encryptedValue, createdAt, updatedAt) VALUES ('A', '{}', 2, 2)`),
    ).rejects.toThrow(/Duplicate entry/);
  });
});
