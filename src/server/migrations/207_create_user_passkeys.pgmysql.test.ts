/**
 * Migration 207 — PostgreSQL / MySQL container behaviour (#5841).
 *
 * Each backend gets its own isolated database (`createIsolated*Database`):
 * `users` is a fixture table in other suites, and two suites creating and
 * dropping the same name in one shared database race (CLAUDE.md
 * Multi-Database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import { runMigration207Postgres, runMigration207Mysql } from './207_create_user_passkeys.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 207 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  const insertPasskey = (userId: number, credentialId: string) =>
    pool.query(
      `INSERT INTO user_passkeys ("userId", "credentialId", "publicKey", "rpId", "createdAt")
       VALUES ($1, $2, 'pk', 'mesh.example.com', 1)`,
      [userId, credentialId],
    );

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig207'));
    await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL
      )
    `);
    await pool.query(`INSERT INTO users (username, "createdAt", "updatedAt") VALUES ('alice', 1, 1), ('bob', 1, 1)`);

    const client = await pool.connect();
    try {
      await runMigration207Postgres(client);
      await runMigration207Postgres(client); // idempotent
    } finally {
      client.release();
    }
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the users columns with password login on by default', async () => {
    const { rows } = await pool.query(
      `SELECT "passwordLoginDisabled", "passkeyRecoveryCodes" FROM users WHERE username = 'alice'`,
    );
    expect(rows[0].passwordLoginDisabled).toBe(false);
    expect(rows[0].passkeyRecoveryCodes).toBeNull();
  });

  it('creates the user index', async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'user_passkeys'`,
    );
    expect(rows.map((r) => r.indexname)).toContain('idx_user_passkeys_user');
  });

  it('rejects a duplicate credential id, but ids differing only in case are distinct', async () => {
    await insertPasskey(1, 'CredA');
    await insertPasskey(1, 'creda');
    await expect(insertPasskey(2, 'CredA')).rejects.toThrow(/unique|duplicate/i);
  });

  it('deleting a user cascades to their passkeys only', async () => {
    await insertPasskey(2, 'cred-bob');
    await pool.query(`DELETE FROM users WHERE username = 'alice'`);
    const { rows } = await pool.query(`SELECT "credentialId" FROM user_passkeys`);
    expect(rows.map((r) => r.credentialId)).toEqual(['cred-bob']);
  });
});

describe.skipIf(!mysqlAvailable)('migration 207 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  const insertPasskey = (userId: number, credentialId: string) =>
    pool.query(
      `INSERT INTO user_passkeys (userId, credentialId, publicKey, rpId, createdAt)
       VALUES (?, ?, 'pk', 'mesh.example.com', 1)`,
      [userId, credentialId],
    );

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig207'));
    await pool.query(`
      CREATE TABLE users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query(`INSERT INTO users (username, createdAt, updatedAt) VALUES ('alice', 1, 1), ('bob', 1, 1)`);

    await runMigration207Mysql(pool);
    await runMigration207Mysql(pool); // idempotent
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the users columns with password login on by default', async () => {
    const [rows] = await pool.query(
      `SELECT passwordLoginDisabled, passkeyRecoveryCodes FROM users WHERE username = 'alice'`,
    );
    expect(Number((rows as any[])[0].passwordLoginDisabled)).toBe(0);
    expect((rows as any[])[0].passkeyRecoveryCodes).toBeNull();
  });

  it('creates the user index', async () => {
    const [rows] = await pool.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_passkeys'`,
    );
    expect((rows as any[]).map((r) => r.INDEX_NAME)).toContain('idx_user_passkeys_user');
  });

  it('rejects a duplicate credential id, but ids differing only in case are distinct', async () => {
    await insertPasskey(1, 'CredA');
    // base64url is case-sensitive: the binary collation must not fold case.
    await insertPasskey(1, 'creda');
    await expect(insertPasskey(2, 'CredA')).rejects.toThrow(/Duplicate/);
  });

  it('accepts a maximum-length credential id (1023 bytes as base64url)', async () => {
    await insertPasskey(2, 'x'.repeat(1364));
  });

  it('deleting a user cascades to their passkeys only', async () => {
    await pool.query(`DELETE FROM users WHERE username = 'alice'`);
    const [rows] = await pool.query(`SELECT credentialId FROM user_passkeys`);
    expect((rows as any[]).map((r) => r.credentialId)).toEqual(['x'.repeat(1364)]);
  });
});
