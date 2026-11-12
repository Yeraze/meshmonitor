/**
 * Migration 232 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration232Postgres, runMigration232Mysql } from './232_add_notify_on_auto_trace.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 232 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig232'));
    await pool.query('DROP TABLE IF EXISTS user_notification_preferences CASCADE');
    await pool.query(`
      CREATE TABLE user_notification_preferences (
        id SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL,
        "sourceId" TEXT NOT NULL DEFAULT ''
      )
    `);
    await pool.query(`INSERT INTO user_notification_preferences ("userId", "sourceId") VALUES (1, 'src-a')`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds a BOOLEAN DEFAULT FALSE column, is idempotent, and an existing row reads off', async () => {
    const client = await pool.connect();
    try {
      await runMigration232Postgres(client);
      await expect(runMigration232Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows } = await pool.query(`SELECT "notifyOnAutoTrace" FROM user_notification_preferences WHERE "userId" = 1`);
    expect(rows[0].notifyOnAutoTrace).toBe(false);
    const { rows: cols } = await pool.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'user_notification_preferences' AND column_name = 'notifyOnAutoTrace'`,
    );
    expect(cols[0].data_type).toBe('boolean');
  });
});

describe.skipIf(!mysqlAvailable)('migration 232 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig232'));
    await pool.query('DROP TABLE IF EXISTS user_notification_preferences');
    await pool.query(`
      CREATE TABLE user_notification_preferences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        userId INT NOT NULL,
        sourceId VARCHAR(64) NOT NULL DEFAULT ''
      )
    `);
    await pool.query(`INSERT INTO user_notification_preferences (userId, sourceId) VALUES (1, 'src-a')`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds a BOOLEAN DEFAULT FALSE column, is idempotent, and an existing row reads off', async () => {
    await runMigration232Mysql(pool);
    await expect(runMigration232Mysql(pool)).resolves.toBeUndefined();
    const [rows] = await pool.query(`SELECT notifyOnAutoTrace FROM user_notification_preferences WHERE userId = 1`);
    expect(Number((rows as any[])[0].notifyOnAutoTrace)).toBe(0);
  });
});
