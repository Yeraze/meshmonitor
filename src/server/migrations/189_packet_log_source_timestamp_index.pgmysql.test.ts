/**
 * Migration 189 — PostgreSQL / MySQL container behaviour (#5557).
 *
 * Builds a minimal `packet_log` (camelCase `sourceId`, snake_case elsewhere,
 * as on a real install), runs the real migration twice, and checks the index
 * exists on (sourceId, timestamp) in that order. Own isolated database per
 * dialect. A silent skip still reports `success: true`; confirm coverage via
 * `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import {
  runMigration189Postgres,
  runMigration189Mysql,
  PACKET_LOG_SOURCE_TIMESTAMP_INDEX,
} from './189_packet_log_source_timestamp_index.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 189 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig189'));
    await pool.query('DROP TABLE IF EXISTS packet_log CASCADE');
    await pool.query(`
      CREATE TABLE packet_log (
        id SERIAL PRIMARY KEY,
        packet_id BIGINT,
        timestamp BIGINT NOT NULL,
        from_node BIGINT NOT NULL,
        portnum INTEGER NOT NULL,
        encrypted BOOLEAN NOT NULL,
        created_at BIGINT,
        "sourceId" TEXT
      )
    `);
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the (sourceId, timestamp) index and runs twice safely', async () => {
    const client = await pool.connect();
    try {
      await runMigration189Postgres(client);
      await expect(runMigration189Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const res = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'packet_log' AND indexname = $1`,
      [PACKET_LOG_SOURCE_TIMESTAMP_INDEX],
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].indexdef).toMatch(/\("sourceId", "?timestamp"?\)/);
  });
});

describe.skipIf(!mysqlAvailable)('migration 189 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig189'));
    await pool.query('DROP TABLE IF EXISTS packet_log');
    await pool.query(`
      CREATE TABLE packet_log (
        id SERIAL PRIMARY KEY,
        packet_id BIGINT,
        timestamp BIGINT NOT NULL,
        from_node BIGINT NOT NULL,
        portnum INT NOT NULL,
        encrypted BOOLEAN NOT NULL,
        created_at BIGINT,
        sourceId VARCHAR(36)
      )
    `);
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the (sourceId, timestamp) index and runs twice safely', async () => {
    await runMigration189Mysql(pool);
    await expect(runMigration189Mysql(pool)).resolves.toBeUndefined();
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME AS col FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'packet_log' AND INDEX_NAME = ?
       ORDER BY SEQ_IN_INDEX`,
      [PACKET_LOG_SOURCE_TIMESTAMP_INDEX],
    );
    expect((rows as Array<{ col: string }>).map((r) => r.col)).toEqual(['sourceId', 'timestamp']);
  });
});
