/**
 * Migration 196 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration196Postgres, runMigration196Mysql } from './196_add_notification_message_templates.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 196 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig196'));
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

  it('adds two nullable text columns, is idempotent, and round-trips a template per source', async () => {
    const client = await pool.connect();
    try {
      await runMigration196Postgres(client);
      await expect(runMigration196Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    const { rows: cols } = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'user_notification_preferences'
         AND column_name IN ('messageTitleTemplate', 'messageBodyTemplate') ORDER BY column_name`,
    );
    expect(cols).toEqual([
      { column_name: 'messageBodyTemplate', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'messageTitleTemplate', data_type: 'text', is_nullable: 'YES' },
    ]);

    const { rows: before } = await pool.query(
      `SELECT "prefixWithNodeName", "messageTitleTemplate", "messageBodyTemplate" FROM user_notification_preferences`,
    );
    expect(before[0]).toEqual({ prefixWithNodeName: true, messageTitleTemplate: null, messageBodyTemplate: null });

    await pool.query(
      `UPDATE user_notification_preferences SET "messageTitleTemplate" = $1, "messageBodyTemplate" = $2 WHERE "sourceId" = 'src-a'`,
      ['{{ channelName }}', '{{ text }}'],
    );
    await pool.query(`INSERT INTO user_notification_preferences ("userId", "sourceId", "createdAt", "updatedAt") VALUES (1, 'src-b', 1, 1)`);
    const { rows: after } = await pool.query(
      `SELECT "sourceId", "messageTitleTemplate", "messageBodyTemplate" FROM user_notification_preferences ORDER BY "sourceId"`,
    );
    expect(after).toEqual([
      { sourceId: 'src-a', messageTitleTemplate: '{{ channelName }}', messageBodyTemplate: '{{ text }}' },
      { sourceId: 'src-b', messageTitleTemplate: null, messageBodyTemplate: null },
    ]);
  });
});

describe.skipIf(!mysqlAvailable)('migration 196 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig196'));
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

  it('adds two nullable text columns, is idempotent, and round-trips a template per source', async () => {
    await runMigration196Mysql(pool);
    await expect(runMigration196Mysql(pool)).resolves.toBeUndefined();

    const [cols] = await pool.query(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_notification_preferences'
         AND COLUMN_NAME IN ('messageTitleTemplate', 'messageBodyTemplate') ORDER BY COLUMN_NAME`,
    );
    expect(cols).toEqual([
      { name: 'messageBodyTemplate', type: 'text', nullable: 'YES' },
      { name: 'messageTitleTemplate', type: 'text', nullable: 'YES' },
    ]);

    const [before] = await pool.query(
      `SELECT prefixWithNodeName, messageTitleTemplate, messageBodyTemplate FROM user_notification_preferences`,
    );
    expect((before as any[])[0]).toEqual({ prefixWithNodeName: 1, messageTitleTemplate: null, messageBodyTemplate: null });

    await pool.query(
      `UPDATE user_notification_preferences SET messageTitleTemplate = ?, messageBodyTemplate = ? WHERE sourceId = 'src-a'`,
      ['{{ channelName }}', '{{ text }}'],
    );
    await pool.query(`INSERT INTO user_notification_preferences (userId, sourceId, createdAt, updatedAt) VALUES (1, 'src-b', 1, 1)`);
    const [after] = await pool.query(
      `SELECT sourceId, messageTitleTemplate, messageBodyTemplate FROM user_notification_preferences ORDER BY sourceId`,
    );
    expect(after).toEqual([
      { sourceId: 'src-a', messageTitleTemplate: '{{ channelName }}', messageBodyTemplate: '{{ text }}' },
      { sourceId: 'src-b', messageTitleTemplate: null, messageBodyTemplate: null },
    ]);
  });
});
