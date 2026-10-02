/**
 * Migration 187 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration187Postgres, runMigration187Mysql } from './187_add_meshcore_message_sender_timestamp.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

// Past 2^31 on purpose: BIGINT, not a signed 32-bit INTEGER.
const BIG_TS = 4_300_000_000;

describe.skipIf(!postgresAvailable)('migration 187 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig187'));
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

  it('adds a nullable BIGINT column, is idempotent, and round-trips', async () => {
    const client = await pool.connect();
    try {
      await runMigration187Postgres(client);
      await expect(runMigration187Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows: before } = await pool.query(`SELECT "senderTimestamp" FROM meshcore_messages WHERE id = 'a'`);
    expect(before[0].senderTimestamp).toBeNull();
    await pool.query(`UPDATE meshcore_messages SET "senderTimestamp" = ${BIG_TS} WHERE id = 'a'`);
    const { rows } = await pool.query(`SELECT "senderTimestamp" FROM meshcore_messages WHERE id = 'a'`);
    expect(Number(rows[0].senderTimestamp)).toBe(BIG_TS);
    const { rows: cols } = await pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'meshcore_messages' AND column_name = 'senderTimestamp'`,
    );
    expect(cols[0]).toEqual({ data_type: 'bigint', is_nullable: 'YES' });
  });
});

describe.skipIf(!mysqlAvailable)('migration 187 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig187'));
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

  it('adds a nullable BIGINT column, is idempotent, and round-trips', async () => {
    await runMigration187Mysql(pool);
    await expect(runMigration187Mysql(pool)).resolves.toBeUndefined();
    const [before] = await pool.query(`SELECT senderTimestamp FROM meshcore_messages WHERE id = 'a'`);
    expect((before as any[])[0].senderTimestamp).toBeNull();
    await pool.query(`UPDATE meshcore_messages SET senderTimestamp = ${BIG_TS} WHERE id = 'a'`);
    const [rows] = await pool.query(`SELECT senderTimestamp FROM meshcore_messages WHERE id = 'a'`);
    expect(Number((rows as any[])[0].senderTimestamp)).toBe(BIG_TS);
    const [cols] = await pool.query(
      `SELECT DATA_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_messages' AND COLUMN_NAME = 'senderTimestamp'`,
    );
    expect((cols as any[])[0].DATA_TYPE).toBe('bigint');
    expect((cols as any[])[0].IS_NULLABLE).toBe('YES');
  });
});
