/**
 * Migration 144 — PostgreSQL / MySQL container behaviour.
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)` — runs migration 141
 * (to create the base `reticulum_destinations` table) followed by the real
 * migration 144 functions against the live test containers (localhost:5433 /
 * :3307), and asserts column presence + idempotency + a round-tripped
 * position sample on each backend. A silent skip here still reports
 * `success: true` at the suite level — confirm via `numPendingTests` in the
 * JSON reporter, not just the pass/fail summary (see CLAUDE.md Multi-Database
 * section).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration141Postgres, runMigration141Mysql } from './141_create_reticulum_destinations.js';
import { runMigration144Postgres, runMigration144Mysql } from './144_add_reticulum_destination_position.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 144 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig144'));
    await pool.query('DROP TABLE IF EXISTS reticulum_destinations CASCADE');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the position columns to an existing table, is idempotent, and round-trips a sample', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration141Postgres(client1);
      await runMigration144Postgres(client1);
      await expect(runMigration144Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO reticulum_destinations
        ("sourceId", "destinationHash", "announceCount", "firstSeen", "lastSeen", "isFavorite", "createdAt", "updatedAt")
       VALUES ('src-1', $1, 1, $2, $2, false, $2, $2)`,
      ['e'.repeat(32), now],
    );

    await pool.query(
      `UPDATE reticulum_destinations
       SET latitude = $1, longitude = $2, altitude = $3, speed = $4, bearing = $5, accuracy = $6, "positionUpdatedAt" = $7
       WHERE "destinationHash" = $8`,
      [10.5, -20.25, 100.0, 1.5, 270.0, 5.0, now, 'e'.repeat(32)],
    );

    const { rows } = await pool.query(
      `SELECT latitude, longitude, altitude, speed, bearing, accuracy, "positionUpdatedAt"
       FROM reticulum_destinations WHERE "destinationHash" = $1`,
      ['e'.repeat(32)],
    );
    expect(Number(rows[0].latitude)).toBeCloseTo(10.5);
    expect(Number(rows[0].longitude)).toBeCloseTo(-20.25);
    expect(Number(rows[0].altitude)).toBeCloseTo(100.0);
    expect(Number(rows[0].speed)).toBeCloseTo(1.5);
    expect(Number(rows[0].bearing)).toBeCloseTo(270.0);
    expect(Number(rows[0].accuracy)).toBeCloseTo(5.0);
    expect(Number(rows[0].positionUpdatedAt)).toBe(now);
  });
});

describe.skipIf(!mysqlAvailable)('migration 144 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig144'));
    await pool.query('DROP TABLE IF EXISTS reticulum_destinations');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the position columns to an existing table, is idempotent, and round-trips a sample', async () => {
    await runMigration141Mysql(pool);
    await runMigration144Mysql(pool);
    await expect(runMigration144Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    await pool.query(
      `INSERT INTO reticulum_destinations
        (sourceId, destinationHash, announceCount, firstSeen, lastSeen, isFavorite, createdAt, updatedAt)
       VALUES ('src-1', ?, 1, ?, ?, 0, ?, ?)`,
      ['f'.repeat(32), now, now, now, now],
    );

    await pool.query(
      `UPDATE reticulum_destinations
       SET latitude = ?, longitude = ?, altitude = ?, speed = ?, bearing = ?, accuracy = ?, positionUpdatedAt = ?
       WHERE destinationHash = ?`,
      [10.5, -20.25, 100.0, 1.5, 270.0, 5.0, now, 'f'.repeat(32)],
    );

    const [rows] = await pool.query(
      `SELECT latitude, longitude, altitude, speed, bearing, accuracy, positionUpdatedAt
       FROM reticulum_destinations WHERE destinationHash = ?`,
      ['f'.repeat(32)],
    );
    const row = (rows as any[])[0];
    expect(Number(row.latitude)).toBeCloseTo(10.5);
    expect(Number(row.longitude)).toBeCloseTo(-20.25);
    expect(Number(row.altitude)).toBeCloseTo(100.0);
    expect(Number(row.speed)).toBeCloseTo(1.5);
    expect(Number(row.bearing)).toBeCloseTo(270.0);
    expect(Number(row.accuracy)).toBeCloseTo(5.0);
    expect(Number(row.positionUpdatedAt)).toBe(now);
  });
});
