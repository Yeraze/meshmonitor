/**
 * Migration 197 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration197Postgres, runMigration197Mysql } from './197_widen_system_backup_total_size.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

/** Bigger than a 32-bit INTEGER can hold: a 5 GiB backup. */
const FIVE_GIB = 5 * 1024 * 1024 * 1024;

describe.skipIf(!postgresAvailable)('migration 197 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig197'));
    await pool.query(`
      CREATE TABLE system_backup_history (
        id SERIAL PRIMARY KEY,
        "backupPath" TEXT NOT NULL,
        "backupType" TEXT NOT NULL,
        "totalSize" INTEGER,
        timestamp BIGINT NOT NULL,
        "createdAt" BIGINT NOT NULL
      )
    `);
    await pool.query(
      `INSERT INTO system_backup_history ("backupPath", "backupType", "totalSize", timestamp, "createdAt")
       VALUES ('2025-01-01_000000', 'manual', 2457600, 1, 1)`,
    );
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('could not record a backup over 2 GiB before', async () => {
    await expect(
      pool.query(
        `INSERT INTO system_backup_history ("backupPath", "backupType", "totalSize", timestamp, "createdAt")
         VALUES ('too-big', 'manual', $1, 2, 2)`,
        [FIVE_GIB],
      ),
    ).rejects.toThrow(/out of range/);
  });

  it('widens the column, keeps existing rows, is idempotent, and then records a large backup', async () => {
    const client = await pool.connect();
    try {
      await runMigration197Postgres(client);
      await expect(runMigration197Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    const { rows: cols } = await pool.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'system_backup_history' AND column_name = 'totalSize'`,
    );
    expect(cols).toEqual([{ data_type: 'bigint' }]);

    await pool.query(
      `INSERT INTO system_backup_history ("backupPath", "backupType", "totalSize", timestamp, "createdAt")
       VALUES ('2026-01-01_000000', 'manual', $1, 2, 2)`,
      [FIVE_GIB],
    );
    const { rows } = await pool.query(`SELECT "totalSize" FROM system_backup_history ORDER BY id`);
    expect(rows.map((r) => Number(r.totalSize))).toEqual([2457600, FIVE_GIB]);
  });

  it('does nothing when the table has no such column', async () => {
    await pool.query(`ALTER TABLE system_backup_history RENAME TO system_backup_history_away`);
    const client = await pool.connect();
    try {
      await expect(runMigration197Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
      await pool.query(`ALTER TABLE system_backup_history_away RENAME TO system_backup_history`);
    }
  });
});

describe.skipIf(!mysqlAvailable)('migration 197 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig197'));
    await pool.query(`
      CREATE TABLE system_backup_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        backupPath VARCHAR(512) NOT NULL,
        backupType VARCHAR(32) NOT NULL,
        totalSize INT,
        timestamp BIGINT NOT NULL,
        createdAt BIGINT NOT NULL
      )
    `);
    await pool.query(
      `INSERT INTO system_backup_history (backupPath, backupType, totalSize, timestamp, createdAt)
       VALUES ('2025-01-01_000000', 'manual', 2457600, 1, 1)`,
    );
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('could not record a backup over 2 GiB before', async () => {
    await expect(
      pool.query(
        `INSERT INTO system_backup_history (backupPath, backupType, totalSize, timestamp, createdAt)
         VALUES ('too-big', 'manual', ?, 2, 2)`,
        [FIVE_GIB],
      ),
    ).rejects.toThrow(/Out of range/i);
  });

  it('widens the column, keeps existing rows, is idempotent, and then records a large backup', async () => {
    await runMigration197Mysql(pool);
    await expect(runMigration197Mysql(pool)).resolves.toBeUndefined();

    const [cols] = await pool.query(
      `SELECT DATA_TYPE AS dataType FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'system_backup_history' AND COLUMN_NAME = 'totalSize'`,
    );
    expect((cols as Array<{ dataType: string }>)[0].dataType.toLowerCase()).toBe('bigint');

    await pool.query(
      `INSERT INTO system_backup_history (backupPath, backupType, totalSize, timestamp, createdAt)
       VALUES ('2026-01-01_000000', 'manual', ?, 2, 2)`,
      [FIVE_GIB],
    );
    const [rows] = await pool.query(`SELECT totalSize FROM system_backup_history ORDER BY id`);
    expect((rows as Array<{ totalSize: number | string }>).map((r) => Number(r.totalSize))).toEqual([
      2457600,
      FIVE_GIB,
    ]);
  });

  it('does nothing when the table has no such column', async () => {
    await pool.query(`RENAME TABLE system_backup_history TO system_backup_history_away`);
    try {
      await expect(runMigration197Mysql(pool)).resolves.toBeUndefined();
    } finally {
      await pool.query(`RENAME TABLE system_backup_history_away TO system_backup_history`);
    }
  });
});
