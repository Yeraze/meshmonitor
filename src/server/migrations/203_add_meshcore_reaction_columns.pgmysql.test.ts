/**
 * Migration 203 - PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration203Postgres, runMigration203Mysql } from './203_add_meshcore_reaction_columns.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const COLS = ['mc1Hash','reactionEmoji','reactionFormat','reactionTargetHash','reactionTargetSender','reactionTargetId','reactionRawText'];
const MYSQL_TYPES: Record<string, string> = {
  mc1Hash: 'varchar', reactionEmoji: 'varchar', reactionFormat: 'varchar', reactionTargetHash: 'varchar',
  reactionTargetSender: 'text', reactionTargetId: 'varchar', reactionRawText: 'text',
};
const EMOJI = '\u{1F44D}\u{1F3FD}';

describe.skipIf(!postgresAvailable)('migration 203 - PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig203'));
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

  it('adds nullable TEXT columns and the index, is idempotent, and round-trips', async () => {
    const client = await pool.connect();
    try {
      await runMigration203Postgres(client);
      await expect(runMigration203Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows: cols } = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'meshcore_messages' AND column_name = ANY($1)`,
      [COLS],
    );
    expect(cols).toHaveLength(COLS.length);
    for (const c of cols) {
      expect(c.data_type).toBe('text');
      expect(c.is_nullable).toBe('YES');
    }
    const { rows: idx } = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'meshcore_messages' AND indexname = 'idx_meshcore_messages_mc1hash'`);
    expect(idx).toHaveLength(1);
    const { rows: before } = await pool.query(`SELECT "mc1Hash", "reactionEmoji" FROM meshcore_messages WHERE id = 'a'`);
    expect(before[0]).toEqual({ mc1Hash: null, reactionEmoji: null });
    await pool.query(`UPDATE meshcore_messages SET "mc1Hash" = 'b45pc4ek', "reactionEmoji" = $1 WHERE id = 'a'`, [EMOJI]);
    const { rows } = await pool.query(`SELECT "mc1Hash", "reactionEmoji" FROM meshcore_messages WHERE id = 'a'`);
    expect(rows[0]).toEqual({ mc1Hash: 'b45pc4ek', reactionEmoji: EMOJI });
  });
});

describe.skipIf(!mysqlAvailable)('migration 203 - MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig203'));
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

  it('adds nullable columns of the spec types and the index, is idempotent, and round-trips', async () => {
    await runMigration203Mysql(pool);
    await expect(runMigration203Mysql(pool)).resolves.toBeUndefined();
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_messages' AND COLUMN_NAME IN (?)`,
      [COLS],
    );
    const byName = new Map((cols as any[]).map((c) => [c.COLUMN_NAME, c]));
    expect(byName.size).toBe(COLS.length);
    for (const name of COLS) {
      expect(byName.get(name).DATA_TYPE).toBe(MYSQL_TYPES[name]);
      expect(byName.get(name).IS_NULLABLE).toBe('YES');
    }
    expect(Number(byName.get('mc1Hash').CHARACTER_MAXIMUM_LENGTH)).toBe(8);
    expect(Number(byName.get('reactionEmoji').CHARACTER_MAXIMUM_LENGTH)).toBe(64);
    expect(Number(byName.get('reactionFormat').CHARACTER_MAXIMUM_LENGTH)).toBe(24);
    const [idx] = await pool.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_messages' AND INDEX_NAME = 'idx_meshcore_messages_mc1hash'`,
    );
    expect((idx as any[]).length).toBe(2);
    await pool.query(`UPDATE meshcore_messages SET mc1Hash = 'b45pc4ek', reactionEmoji = ? WHERE id = 'a'`, [EMOJI]);
    const [rows] = await pool.query(`SELECT mc1Hash, reactionEmoji FROM meshcore_messages WHERE id = 'a'`);
    expect((rows as any[])[0]).toEqual({ mc1Hash: 'b45pc4ek', reactionEmoji: EMOJI });
  });
});
