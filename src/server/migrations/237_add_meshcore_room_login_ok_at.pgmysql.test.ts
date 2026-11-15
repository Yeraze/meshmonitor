/**
 * Migration 237 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration237Postgres, runMigration237Mysql } from './237_add_meshcore_room_login_ok_at.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

// Past 2^31, so a 32-bit column would overflow.
const TS = 1_763_000_000_000;

describe.skipIf(!postgresAvailable)('migration 237 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig237'));
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
      await runMigration237Postgres(client);
      await expect(runMigration237Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows: before } = await pool.query(`SELECT "lastRoomLoginOkAt" FROM meshcore_nodes`);
    expect(before[0].lastRoomLoginOkAt).toBeNull();
    await pool.query(`UPDATE meshcore_nodes SET "lastRoomLoginOkAt" = ${TS}`);
    const { rows } = await pool.query(`SELECT "lastRoomLoginOkAt" FROM meshcore_nodes`);
    expect(Number(rows[0].lastRoomLoginOkAt)).toBe(TS);
    const { rows: cols } = await pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'meshcore_nodes' AND column_name = 'lastRoomLoginOkAt'`,
    );
    expect(cols[0]).toEqual({ data_type: 'bigint', is_nullable: 'YES' });
  });
});

describe.skipIf(!mysqlAvailable)('migration 237 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig237'));
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
    await runMigration237Mysql(pool);
    await expect(runMigration237Mysql(pool)).resolves.toBeUndefined();
    const [before] = await pool.query(`SELECT lastRoomLoginOkAt FROM meshcore_nodes`);
    expect((before as any[])[0].lastRoomLoginOkAt).toBeNull();
    await pool.query(`UPDATE meshcore_nodes SET lastRoomLoginOkAt = ${TS}`);
    const [rows] = await pool.query(`SELECT lastRoomLoginOkAt FROM meshcore_nodes`);
    expect(Number((rows as any[])[0].lastRoomLoginOkAt)).toBe(TS);
    const [cols] = await pool.query(
      `SELECT DATA_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_nodes' AND COLUMN_NAME = 'lastRoomLoginOkAt'`,
    );
    expect((cols as any[])[0].DATA_TYPE).toBe('bigint');
    expect((cols as any[])[0].IS_NULLABLE).toBe('YES');
  });
});
