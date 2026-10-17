/**
 * Migration 210 (#5870): messages(sourceId, channel, timestamp) index on all
 * backends, PostgreSQL autovacuum thresholds. The PG/MySQL suites skip
 * silently without the test containers; confirm via numPendingTests.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import {
  migration,
  runMigration210Postgres,
  runMigration210Mysql,
  AUTOVACUUM_TABLES,
} from './210_messages_channel_index_and_pg_autovacuum.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const INDEX = 'idx_messages_source_channel_ts';

describe('Migration 210 — SQLite', () => {
  it('adds the index, is idempotent, and the channel-list query uses it', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, sourceId TEXT, channel INTEGER NOT NULL DEFAULT 0, timestamp INTEGER NOT NULL)');
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = (db.prepare(`PRAGMA index_info(${INDEX})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['sourceId', 'channel', 'timestamp']);
    const plan = (db.prepare(
      `EXPLAIN QUERY PLAN SELECT channel, COUNT(*), MAX(timestamp) FROM messages WHERE sourceId = ? GROUP BY channel`,
    ).all('s') as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
    expect(plan).toContain(INDEX);
    db.close();
  });
});

describe.skipIf(!postgresAvailable)('Migration 210 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig210'));
    await pool.query('CREATE TABLE messages (id TEXT PRIMARY KEY, "sourceId" TEXT, channel INTEGER NOT NULL DEFAULT 0, timestamp BIGINT NOT NULL)');
    // Only some of the tuned tables exist: the migration must skip the rest.
    await pool.query('CREATE TABLE telemetry (id SERIAL PRIMARY KEY)');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the index, sets the thresholds on the tables that exist, and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration210Postgres(client);
      await runMigration210Postgres(client);
    } finally {
      client.release();
    }
    const idx = await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [INDEX]);
    expect(idx.rows[0].indexdef).toContain('("sourceId", channel, "timestamp")');
    const opts = await pool.query(
      `SELECT relname, reloptions FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [[...AUTOVACUUM_TABLES]],
    );
    expect(opts.rows).toEqual([
      { relname: 'messages', reloptions: ['autovacuum_vacuum_scale_factor=0.05', 'autovacuum_analyze_scale_factor=0.02'] },
      { relname: 'telemetry', reloptions: ['autovacuum_vacuum_scale_factor=0.05', 'autovacuum_analyze_scale_factor=0.02'] },
    ]);
  });
});

describe.skipIf(!mysqlAvailable)('Migration 210 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig210'));
    await pool.query('CREATE TABLE messages (id VARCHAR(191) PRIMARY KEY, sourceId VARCHAR(36), channel INT NOT NULL DEFAULT 0, timestamp BIGINT NOT NULL)');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the index and is idempotent', async () => {
    await runMigration210Mysql(pool);
    await runMigration210Mysql(pool);
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX`,
      [INDEX],
    );
    expect((rows as Array<{ COLUMN_NAME: string }>).map((r) => r.COLUMN_NAME)).toEqual(['sourceId', 'channel', 'timestamp']);
  });
});
