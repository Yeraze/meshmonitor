/**
 * Migration 251 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration251Postgres, runMigration251Mysql } from './251_add_meshcore_room_clear_at.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

// Past 2^31, so a 32-bit column would overflow.
const TS = 1_763_000_000_000;

describe.skipIf(!postgresAvailable)('migration 251 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig251'));
    await pool.query('DROP TABLE IF EXISTS meshcore_nodes CASCADE');
    await pool.query(`
      CREATE TABLE meshcore_nodes (
        "publicKey" TEXT NOT NULL,
        "sourceId" TEXT NOT NULL,
        "createdAt" BIGINT NOT NULL,
        PRIMARY KEY ("sourceId", "publicKey")
      )
    `);
    await pool.query(`INSERT INTO meshcore_nodes ("publicKey", "sourceId", "createdAt") VALUES ('room', 'src-a', 1)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds a nullable BIGINT column, is idempotent, and round-trips', async () => {
    const client = await pool.connect();
    try {
      await runMigration251Postgres(client);
      await expect(runMigration251Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows: before } = await pool.query(`SELECT "lastRoomClearAt" FROM meshcore_nodes`);
    expect(before[0].lastRoomClearAt).toBeNull();
    await pool.query(`UPDATE meshcore_nodes SET "lastRoomClearAt" = ${TS}`);
    const { rows } = await pool.query(`SELECT "lastRoomClearAt" FROM meshcore_nodes`);
    expect(Number(rows[0].lastRoomClearAt)).toBe(TS);
    const { rows: cols } = await pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'meshcore_nodes' AND column_name = 'lastRoomClearAt'`,
    );
    expect(cols[0]).toEqual({ data_type: 'bigint', is_nullable: 'YES' });
  });
});

describe.skipIf(!mysqlAvailable)('migration 251 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig251'));
    await pool.query('DROP TABLE IF EXISTS meshcore_nodes');
    await pool.query(`
      CREATE TABLE meshcore_nodes (
        publicKey VARCHAR(64) NOT NULL,
        sourceId VARCHAR(64) NOT NULL,
        createdAt BIGINT NOT NULL,
        PRIMARY KEY (sourceId, publicKey)
      )
    `);
    await pool.query(`INSERT INTO meshcore_nodes (publicKey, sourceId, createdAt) VALUES ('room', 'src-a', 1)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds a nullable BIGINT column, is idempotent, and round-trips', async () => {
    await runMigration251Mysql(pool);
    await expect(runMigration251Mysql(pool)).resolves.toBeUndefined();
    const [before] = await pool.query(`SELECT lastRoomClearAt FROM meshcore_nodes`);
    expect((before as any[])[0].lastRoomClearAt).toBeNull();
    await pool.query(`UPDATE meshcore_nodes SET lastRoomClearAt = ${TS}`);
    const [rows] = await pool.query(`SELECT lastRoomClearAt FROM meshcore_nodes`);
    expect(Number((rows as any[])[0].lastRoomClearAt)).toBe(TS);
    const [cols] = await pool.query(
      `SELECT DATA_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_nodes' AND COLUMN_NAME = 'lastRoomClearAt'`,
    );
    expect((cols as any[])[0].DATA_TYPE).toBe('bigint');
    expect((cols as any[])[0].IS_NULLABLE).toBe('YES');
  });
});
