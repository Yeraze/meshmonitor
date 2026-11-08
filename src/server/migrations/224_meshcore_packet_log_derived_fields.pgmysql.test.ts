/**
 * Migration 224 on the PostgreSQL / MySQL containers (#6262): columns, indexes,
 * idempotent rerun. Each fixture owns an isolated database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration224Postgres, runMigration224Mysql } from './224_meshcore_packet_log_derived_fields.js';
import { postgresAvailable, mysqlAvailable, createIsolatedPostgresDatabase, createIsolatedMysqlDatabase } from '../../db/repositories/test-utils.js';

const IDX = ['idx_mcpl_source_src', 'idx_mcpl_source_sender'];

describe.skipIf(!postgresAvailable)('migration 224 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig224'));
    await pool.query(`CREATE TABLE meshcore_packet_log (id SERIAL PRIMARY KEY, "sourceId" TEXT NOT NULL, timestamp BIGINT NOT NULL, "payloadType" INTEGER NOT NULL, "createdAt" BIGINT NOT NULL)`);
    await pool.query(`CREATE TABLE meshcore_messages (id TEXT PRIMARY KEY, "sourceId" TEXT, "fromPublicKey" TEXT NOT NULL, timestamp BIGINT NOT NULL)`);
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('adds columns and indexes, idempotently', async () => {
    const client = await pool.connect();
    try {
      await runMigration224Postgres(client);
      await expect(runMigration224Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='meshcore_packet_log' AND column_name IN ('srcHash','senderPubKey','advertName')`,
    );
    expect(cols.rowCount).toBe(3);
    const idx = await pool.query(`SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)`, [
      [...IDX, 'idx_meshcore_messages_source_from_ts'],
    ]);
    expect(idx.rowCount).toBe(3);
  });
});

describe.skipIf(!mysqlAvailable)('migration 224 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig224'));
    await pool.query(`CREATE TABLE meshcore_packet_log (id SERIAL PRIMARY KEY, sourceId VARCHAR(255) NOT NULL, timestamp BIGINT NOT NULL, payloadType INT NOT NULL, createdAt BIGINT NOT NULL)`);
    await pool.query(`CREATE TABLE meshcore_messages (id VARCHAR(64) PRIMARY KEY, sourceId VARCHAR(64), fromPublicKey VARCHAR(64) NOT NULL, timestamp BIGINT NOT NULL)`);
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('adds columns and indexes, idempotently', async () => {
    await runMigration224Mysql(pool);
    await expect(runMigration224Mysql(pool)).resolves.toBeUndefined();
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='meshcore_packet_log' AND COLUMN_NAME IN ('srcHash','senderPubKey','advertName')`,
    );
    expect((cols as unknown[]).length).toBe(3);
    const [idx] = await pool.query(
      `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN ('idx_mcpl_source_src','idx_mcpl_source_sender','idx_meshcore_messages_source_from_ts')`,
    );
    expect((idx as unknown[]).length).toBe(3);
  });
});
