/**
 * Migration 191 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration191Postgres, runMigration191Mysql } from './191_add_meshcore_repeater_ingest_columns.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

// Past 2^31 on purpose: an epoch-ms value needs BIGINT.
const BIG_MS = 1_790_000_000_000;

describe.skipIf(!postgresAvailable)('migration 191 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig191'));
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
    await pool.query(`
      CREATE TABLE meshcore_nodes (
        "publicKey" TEXT NOT NULL,
        "sourceId" TEXT NOT NULL,
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL,
        PRIMARY KEY ("sourceId", "publicKey")
      )
    `);
    await pool.query(`INSERT INTO meshcore_messages (id, "fromPublicKey", text, timestamp, "sourceId", "createdAt") VALUES ('a', 'channel-0', 't', 1, 'src-a', 1)`);
    await pool.query(`INSERT INTO meshcore_nodes ("publicKey", "sourceId", "createdAt", "updatedAt") VALUES ('k', 'src-a', 1, 1)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds nullable columns, is idempotent, and round-trips', async () => {
    const client = await pool.connect();
    try {
      await runMigration191Postgres(client);
      await expect(runMigration191Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows: before } = await pool.query(`SELECT "keySourceId", "keyChannelIdx", "keyFingerprint" FROM meshcore_messages WHERE id = 'a'`);
    expect(before[0]).toEqual({ keySourceId: null, keyChannelIdx: null, keyFingerprint: null });
    await pool.query(`UPDATE meshcore_messages SET "keySourceId" = 'src-b', "keyChannelIdx" = 3, "keyFingerprint" = '0123456789abcdef' WHERE id = 'a'`);
    const { rows } = await pool.query(`SELECT "keySourceId", "keyChannelIdx", "keyFingerprint" FROM meshcore_messages WHERE id = 'a'`);
    expect(rows[0]).toEqual({ keySourceId: 'src-b', keyChannelIdx: 3, keyFingerprint: '0123456789abcdef' });

    const { rows: n0 } = await pool.query(`SELECT "repeaterNeighborAt" FROM meshcore_nodes`);
    expect(n0[0].repeaterNeighborAt).toBeNull();
    await pool.query(`UPDATE meshcore_nodes SET "repeaterNeighborAt" = ${BIG_MS}`);
    const { rows: n1 } = await pool.query(`SELECT "repeaterNeighborAt" FROM meshcore_nodes`);
    expect(Number(n1[0].repeaterNeighborAt)).toBe(BIG_MS);
  });
});

describe.skipIf(!mysqlAvailable)('migration 191 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig191'));
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
    await pool.query(`
      CREATE TABLE meshcore_nodes (
        publicKey VARCHAR(64) NOT NULL,
        sourceId VARCHAR(64) NOT NULL,
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL,
        PRIMARY KEY (sourceId, publicKey)
      )
    `);
    await pool.query(`INSERT INTO meshcore_messages (id, fromPublicKey, text, timestamp, sourceId, createdAt) VALUES ('a', 'channel-0', 't', 1, 'src-a', 1)`);
    await pool.query(`INSERT INTO meshcore_nodes (publicKey, sourceId, createdAt, updatedAt) VALUES ('k', 'src-a', 1, 1)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds nullable columns, is idempotent, and round-trips', async () => {
    await runMigration191Mysql(pool);
    await expect(runMigration191Mysql(pool)).resolves.toBeUndefined();
    const [before] = await pool.query(`SELECT keySourceId, keyChannelIdx, keyFingerprint FROM meshcore_messages WHERE id = 'a'`);
    expect((before as any[])[0]).toEqual({ keySourceId: null, keyChannelIdx: null, keyFingerprint: null });
    await pool.query(`UPDATE meshcore_messages SET keySourceId = 'src-b', keyChannelIdx = 3, keyFingerprint = '0123456789abcdef' WHERE id = 'a'`);
    const [rows] = await pool.query(`SELECT keySourceId, keyChannelIdx, keyFingerprint FROM meshcore_messages WHERE id = 'a'`);
    expect((rows as any[])[0]).toEqual({ keySourceId: 'src-b', keyChannelIdx: 3, keyFingerprint: '0123456789abcdef' });

    await pool.query(`UPDATE meshcore_nodes SET repeaterNeighborAt = ${BIG_MS}`);
    const [n1] = await pool.query(`SELECT repeaterNeighborAt FROM meshcore_nodes`);
    expect(Number((n1 as any[])[0].repeaterNeighborAt)).toBe(BIG_MS);
  });
});
