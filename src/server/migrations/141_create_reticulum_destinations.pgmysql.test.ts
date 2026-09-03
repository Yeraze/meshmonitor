/**
 * Migration 141 — PostgreSQL / MySQL container behaviour.
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)` — runs the real
 * migration functions against the live test containers (localhost:5433 /
 * :3307) and asserts table/index creation + idempotency on each backend.
 * A silent skip here still reports `success: true` at the suite level —
 * confirm via `numPendingTests` in the JSON reporter, not just the
 * pass/fail summary (see CLAUDE.md Multi-Database section).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration141Postgres, runMigration141Mysql } from './141_create_reticulum_destinations.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 140 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig141'));
    await pool.query('DROP TABLE IF EXISTS reticulum_destinations CASCADE');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table + indexes, is idempotent, and enforces the unique constraint', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration141Postgres(client1);
      await expect(runMigration141Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO reticulum_destinations
        ("sourceId", "destinationHash", rssi, snr, quality, "announceCount", "firstSeen", "lastSeen", "isFavorite", "createdAt", "updatedAt")
       VALUES ('src-1', $1, -70, 3.25, 80, 1, $2, $2, false, $2, $2)`,
      ['c'.repeat(32), now],
    );

    await expect(
      pool.query(
        `INSERT INTO reticulum_destinations
          ("sourceId", "destinationHash", "announceCount", "firstSeen", "lastSeen", "isFavorite", "createdAt", "updatedAt")
         VALUES ('src-1', $1, 1, $2, $2, false, $2, $2)`,
        ['c'.repeat(32), now],
      ),
    ).rejects.toThrow();

    const { rows } = await pool.query(
      `SELECT rssi, snr, quality FROM reticulum_destinations WHERE "destinationHash" = $1`,
      ['c'.repeat(32)],
    );
    expect(rows[0].rssi).toBe(-70);
    expect(Number(rows[0].snr)).toBeCloseTo(3.25);
    expect(rows[0].quality).toBe(80);
  });
});

describe.skipIf(!mysqlAvailable)('migration 140 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig141'));
    await pool.query('DROP TABLE IF EXISTS reticulum_destinations');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table + unique key, is idempotent, and enforces the unique constraint', async () => {
    await runMigration141Mysql(pool);
    await expect(runMigration141Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    await pool.query(
      `INSERT INTO reticulum_destinations
        (sourceId, destinationHash, rssi, snr, quality, announceCount, firstSeen, lastSeen, isFavorite, createdAt, updatedAt)
       VALUES ('src-1', ?, -70, 3.25, 80, 1, ?, ?, 0, ?, ?)`,
      ['d'.repeat(32), now, now, now, now],
    );

    await expect(
      pool.query(
        `INSERT INTO reticulum_destinations
          (sourceId, destinationHash, announceCount, firstSeen, lastSeen, isFavorite, createdAt, updatedAt)
         VALUES ('src-1', ?, 1, ?, ?, 0, ?, ?)`,
        ['d'.repeat(32), now, now, now, now],
      ),
    ).rejects.toThrow();

    const [rows] = await pool.query(
      `SELECT rssi, snr, quality FROM reticulum_destinations WHERE destinationHash = ?`,
      ['d'.repeat(32)],
    );
    const row = (rows as any[])[0];
    expect(row.rssi).toBe(-70);
    expect(Number(row.snr)).toBeCloseTo(3.25);
    expect(row.quality).toBe(80);
  });
});
