/**
 * Migration 229 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration229Postgres, runMigration229Mysql } from './229_add_notification_text_max.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 229 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig229'));
    await pool.query(`
      CREATE TABLE user_notification_preferences (
        id SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL,
        "sourceId" TEXT NOT NULL,
        "prefixWithNodeName" BOOLEAN DEFAULT FALSE,
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL,
        UNIQUE ("userId", "sourceId")
      )
    `);
    await pool.query(`INSERT INTO user_notification_preferences ("userId", "sourceId", "prefixWithNodeName", "createdAt", "updatedAt") VALUES (1, 'src-a', TRUE, 1, 1)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds two nullable integer columns, is idempotent, and round-trips a length per source', async () => {
    const client = await pool.connect();
    try {
      await runMigration229Postgres(client);
      await expect(runMigration229Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    const { rows: cols } = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'user_notification_preferences'
         AND column_name IN ('messageTextMaxPush', 'messageTextMaxApprise') ORDER BY column_name`,
    );
    expect(cols).toEqual([
      { column_name: 'messageTextMaxApprise', data_type: 'integer', is_nullable: 'YES' },
      { column_name: 'messageTextMaxPush', data_type: 'integer', is_nullable: 'YES' },
    ]);

    const { rows: before } = await pool.query(
      `SELECT "prefixWithNodeName", "messageTextMaxPush", "messageTextMaxApprise" FROM user_notification_preferences`,
    );
    expect(before[0]).toEqual({ prefixWithNodeName: true, messageTextMaxPush: null, messageTextMaxApprise: null });

    await pool.query(
      `UPDATE user_notification_preferences SET "messageTextMaxPush" = $1, "messageTextMaxApprise" = $2 WHERE "sourceId" = 'src-a'`,
      [250, 500],
    );
    await pool.query(`INSERT INTO user_notification_preferences ("userId", "sourceId", "createdAt", "updatedAt") VALUES (1, 'src-b', 1, 1)`);
    const { rows: after } = await pool.query(
      `SELECT "sourceId", "messageTextMaxPush", "messageTextMaxApprise" FROM user_notification_preferences ORDER BY "sourceId"`,
    );
    expect(after).toEqual([
      { sourceId: 'src-a', messageTextMaxPush: 250, messageTextMaxApprise: 500 },
      { sourceId: 'src-b', messageTextMaxPush: null, messageTextMaxApprise: null },
    ]);
  });
});

describe.skipIf(!mysqlAvailable)('migration 229 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig229'));
    await pool.query(`
      CREATE TABLE user_notification_preferences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        userId INT NOT NULL,
        sourceId VARCHAR(64) NOT NULL,
        prefixWithNodeName BOOLEAN DEFAULT FALSE,
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL,
        UNIQUE KEY uniq_user_source (userId, sourceId)
      )
    `);
    await pool.query(`INSERT INTO user_notification_preferences (userId, sourceId, prefixWithNodeName, createdAt, updatedAt) VALUES (1, 'src-a', TRUE, 1, 1)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds two nullable integer columns, is idempotent, and round-trips a length per source', async () => {
    await runMigration229Mysql(pool);
    await expect(runMigration229Mysql(pool)).resolves.toBeUndefined();

    const [cols] = await pool.query(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_notification_preferences'
         AND COLUMN_NAME IN ('messageTextMaxPush', 'messageTextMaxApprise') ORDER BY COLUMN_NAME`,
    );
    expect(cols).toEqual([
      { name: 'messageTextMaxApprise', type: 'int', nullable: 'YES' },
      { name: 'messageTextMaxPush', type: 'int', nullable: 'YES' },
    ]);

    const [before] = await pool.query(
      `SELECT prefixWithNodeName, messageTextMaxPush, messageTextMaxApprise FROM user_notification_preferences`,
    );
    expect((before as any[])[0]).toEqual({ prefixWithNodeName: 1, messageTextMaxPush: null, messageTextMaxApprise: null });

    await pool.query(
      `UPDATE user_notification_preferences SET messageTextMaxPush = ?, messageTextMaxApprise = ? WHERE sourceId = 'src-a'`,
      [250, 500],
    );
    await pool.query(`INSERT INTO user_notification_preferences (userId, sourceId, createdAt, updatedAt) VALUES (1, 'src-b', 1, 1)`);
    const [after] = await pool.query(
      `SELECT sourceId, messageTextMaxPush, messageTextMaxApprise FROM user_notification_preferences ORDER BY sourceId`,
    );
    expect(after).toEqual([
      { sourceId: 'src-a', messageTextMaxPush: 250, messageTextMaxApprise: 500 },
      { sourceId: 'src-b', messageTextMaxPush: null, messageTextMaxApprise: null },
    ]);
  });
});
