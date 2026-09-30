/**
 * Migration 185 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration185Postgres, runMigration185Mysql } from './185_add_channel_use_aead.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 185 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig185'));
    await pool.query('DROP TABLE IF EXISTS channels CASCADE');
    await pool.query(`
      CREATE TABLE channels (
        pk SERIAL PRIMARY KEY,
        id INTEGER NOT NULL,
        name TEXT NOT NULL,
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL,
        "sourceId" TEXT
      )
    `);
    await pool.query(`INSERT INTO channels (id, name, "createdAt", "updatedAt", "sourceId") VALUES (0, 'a', 1, 1, 'src-a')`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds a NOT NULL DEFAULT false column, is idempotent, and round-trips', async () => {
    const client = await pool.connect();
    try {
      await runMigration185Postgres(client);
      await expect(runMigration185Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows: before } = await pool.query(`SELECT "useAead" FROM channels WHERE "sourceId" = 'src-a'`);
    expect(before[0].useAead).toBe(false);
    await pool.query(`INSERT INTO channels (id, name, "createdAt", "updatedAt", "sourceId") VALUES (1, 'b', 1, 1, 'src-a')`);
    const { rows: fresh } = await pool.query(`SELECT "useAead" FROM channels WHERE id = 1`);
    expect(fresh[0].useAead).toBe(false);
    await pool.query(`UPDATE channels SET "useAead" = true WHERE id = 0`);
    const { rows } = await pool.query(`SELECT "useAead" FROM channels WHERE id = 0`);
    expect(rows[0].useAead).toBe(true);
    await expect(pool.query(`UPDATE channels SET "useAead" = NULL WHERE id = 0`)).rejects.toThrow();
  });
});

describe.skipIf(!mysqlAvailable)('migration 185 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig185'));
    await pool.query('DROP TABLE IF EXISTS channels');
    await pool.query(`
      CREATE TABLE channels (
        pk INT AUTO_INCREMENT PRIMARY KEY,
        id INT NOT NULL,
        name VARCHAR(64) NOT NULL,
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL,
        sourceId VARCHAR(36)
      )
    `);
    await pool.query(`INSERT INTO channels (id, name, createdAt, updatedAt, sourceId) VALUES (0, 'a', 1, 1, 'src-a')`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds a NOT NULL DEFAULT false column, is idempotent, and round-trips', async () => {
    await runMigration185Mysql(pool);
    await expect(runMigration185Mysql(pool)).resolves.toBeUndefined();
    const [before] = await pool.query(`SELECT useAead FROM channels WHERE id = 0`);
    expect(Number((before as any[])[0].useAead)).toBe(0);
    await pool.query(`UPDATE channels SET useAead = true WHERE id = 0`);
    const [rows] = await pool.query(`SELECT useAead FROM channels WHERE id = 0`);
    expect(Number((rows as any[])[0].useAead)).toBe(1);
    const [cols] = await pool.query(
      `SELECT IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'channels' AND COLUMN_NAME = 'useAead'`,
    );
    expect((cols as any[])[0].IS_NULLABLE).toBe('NO');
    expect(String((cols as any[])[0].COLUMN_DEFAULT)).toBe('0');
  });
});
