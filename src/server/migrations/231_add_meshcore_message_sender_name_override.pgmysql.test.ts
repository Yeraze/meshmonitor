/**
 * Migration 231 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration231Postgres, runMigration231Mysql } from './231_add_meshcore_message_sender_name_override.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const NAME = 'Zo\u00eb Bot';

describe.skipIf(!postgresAvailable)('migration 231 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig231'));
    await pool.query('DROP TABLE IF EXISTS meshcore_messages CASCADE');
    await pool.query(`
      CREATE TABLE meshcore_messages (
        id TEXT PRIMARY KEY,
        "fromPublicKey" TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        "sourceId" TEXT,
        "createdAt" BIGINT NOT NULL
      )
    `);
    await pool.query(`INSERT INTO meshcore_messages (id, "fromPublicKey", text, timestamp, "sourceId", "createdAt") VALUES ('a', 'k', 't', 1, 'src-a', 1)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds a nullable TEXT column, is idempotent, and round-trips', async () => {
    const client = await pool.connect();
    try {
      await runMigration231Postgres(client);
      await expect(runMigration231Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows: before } = await pool.query(`SELECT "senderNameOverride" FROM meshcore_messages WHERE id = 'a'`);
    expect(before[0].senderNameOverride).toBeNull();
    await pool.query(`UPDATE meshcore_messages SET "senderNameOverride" = '${NAME}' WHERE id = 'a'`);
    const { rows } = await pool.query(`SELECT "senderNameOverride" FROM meshcore_messages WHERE id = 'a'`);
    expect(rows[0].senderNameOverride).toBe(NAME);
    const { rows: cols } = await pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'meshcore_messages' AND column_name = 'senderNameOverride'`,
    );
    expect(cols[0]).toEqual({ data_type: 'text', is_nullable: 'YES' });
  });
});

describe.skipIf(!mysqlAvailable)('migration 231 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig231'));
    await pool.query('DROP TABLE IF EXISTS meshcore_messages');
    await pool.query(`
      CREATE TABLE meshcore_messages (
        id VARCHAR(64) PRIMARY KEY,
        fromPublicKey VARCHAR(64) NOT NULL,
        text TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        sourceId VARCHAR(64),
        createdAt BIGINT NOT NULL
      )
    `);
    await pool.query(`INSERT INTO meshcore_messages (id, fromPublicKey, text, timestamp, sourceId, createdAt) VALUES ('a', 'k', 't', 1, 'src-a', 1)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds a nullable TEXT column, is idempotent, and round-trips', async () => {
    await runMigration231Mysql(pool);
    await expect(runMigration231Mysql(pool)).resolves.toBeUndefined();
    const [before] = await pool.query(`SELECT senderNameOverride FROM meshcore_messages WHERE id = 'a'`);
    expect((before as any[])[0].senderNameOverride).toBeNull();
    await pool.query(`UPDATE meshcore_messages SET senderNameOverride = '${NAME}' WHERE id = 'a'`);
    const [rows] = await pool.query(`SELECT senderNameOverride FROM meshcore_messages WHERE id = 'a'`);
    expect((rows as any[])[0].senderNameOverride).toBe(NAME);
    const [cols] = await pool.query(
      `SELECT DATA_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_messages' AND COLUMN_NAME = 'senderNameOverride'`,
    );
    expect((cols as any[])[0].DATA_TYPE).toBe('text');
    expect((cols as any[])[0].IS_NULLABLE).toBe('YES');
  });
});
