/**
 * Migration 222 — PostgreSQL / MySQL container behaviour.
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)` — runs migration 142
 * (to create the base `reticulum_interfaces` table) followed by the real
 * migration 222 functions against the live test containers (localhost:5433 /
 * :3307), and asserts column presence + idempotency + a round-tripped
 * live-gauge snapshot on each backend. A silent skip here still reports
 * `success: true` at the suite level — confirm via `numPendingTests` in the
 * JSON reporter, not just the pass/fail summary (see CLAUDE.md Multi-Database
 * section).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration142Postgres, runMigration142Mysql } from './142_create_reticulum_interfaces.js';
import { runMigration222Postgres, runMigration222Mysql } from './222_add_reticulum_interface_live_stats.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 222 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig222'));
    await pool.query('DROP TABLE IF EXISTS reticulum_interfaces CASCADE');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the live-gauge columns to an existing table, is idempotent, and round-trips a snapshot', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration142Postgres(client1);
      await runMigration222Postgres(client1);
      await expect(runMigration222Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO reticulum_interfaces
        ("sourceId", "interfaceName", status, online, "txBytes", "rxBytes", "lastSeenAt", "createdAt", "updatedAt")
       VALUES ('src-1', 'RNode LoRa Interface', 'up', true, 0, 0, $1, $1, $1)`,
      [now],
    );

    await pool.query(
      `UPDATE reticulum_interfaces
       SET "airtimeShort" = $1, "airtimeLong" = $2, "channelLoadShort" = $3, "channelLoadLong" = $4,
           "noiseFloor" = $5, interference = $6, "interferenceLastTs" = $7, "interferenceLastDbm" = $8,
           "cpuLoad" = $9, "batteryState" = $10, "batteryPercent" = $11
       WHERE "interfaceName" = 'RNode LoRa Interface'`,
      [0, 0.12, 2.44, 1.15, -109, -86, 1700000000, -86, 4.2, 'discharging', 100],
    );

    const { rows } = await pool.query(
      `SELECT "airtimeLong", "channelLoadShort", "noiseFloor", interference, "interferenceLastTs",
              "interferenceLastDbm", "cpuLoad", "batteryState", "batteryPercent"
       FROM reticulum_interfaces WHERE "interfaceName" = 'RNode LoRa Interface'`,
    );
    expect(Number(rows[0].airtimeLong)).toBeCloseTo(0.12);
    expect(Number(rows[0].channelLoadShort)).toBeCloseTo(2.44);
    expect(Number(rows[0].noiseFloor)).toBe(-109);
    expect(Number(rows[0].interference)).toBe(-86);
    expect(Number(rows[0].interferenceLastTs)).toBe(1700000000);
    expect(Number(rows[0].interferenceLastDbm)).toBe(-86);
    expect(Number(rows[0].cpuLoad)).toBeCloseTo(4.2);
    expect(rows[0].batteryState).toBe('discharging');
    expect(Number(rows[0].batteryPercent)).toBe(100);
  });
});

describe.skipIf(!mysqlAvailable)('migration 222 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig222'));
    await pool.query('DROP TABLE IF EXISTS reticulum_interfaces');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the live-gauge columns to an existing table, is idempotent, and round-trips a snapshot', async () => {
    await runMigration142Mysql(pool);
    await runMigration222Mysql(pool);
    await expect(runMigration222Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    await pool.query(
      `INSERT INTO reticulum_interfaces
        (sourceId, interfaceName, status, online, txBytes, rxBytes, lastSeenAt, createdAt, updatedAt)
       VALUES ('src-1', 'RNode LoRa Interface', 'up', 1, 0, 0, ?, ?, ?)`,
      [now, now, now],
    );

    await pool.query(
      `UPDATE reticulum_interfaces
       SET airtimeShort = ?, airtimeLong = ?, channelLoadShort = ?, channelLoadLong = ?,
           noiseFloor = ?, interference = ?, interferenceLastTs = ?, interferenceLastDbm = ?,
           cpuLoad = ?, batteryState = ?, batteryPercent = ?
       WHERE interfaceName = 'RNode LoRa Interface'`,
      [0, 0.12, 2.44, 1.15, -109, -86, 1700000000, -86, 4.2, 'discharging', 100],
    );

    const [rows] = await pool.query(
      `SELECT airtimeLong, channelLoadShort, noiseFloor, interference, interferenceLastTs,
              interferenceLastDbm, cpuLoad, batteryState, batteryPercent
       FROM reticulum_interfaces WHERE interfaceName = 'RNode LoRa Interface'`,
    );
    const row = (rows as any[])[0];
    expect(Number(row.airtimeLong)).toBeCloseTo(0.12);
    expect(Number(row.channelLoadShort)).toBeCloseTo(2.44);
    expect(Number(row.noiseFloor)).toBe(-109);
    expect(Number(row.interference)).toBe(-86);
    expect(Number(row.interferenceLastTs)).toBe(1700000000);
    expect(Number(row.interferenceLastDbm)).toBe(-86);
    expect(Number(row.cpuLoad)).toBeCloseTo(4.2);
    expect(row.batteryState).toBe('discharging');
    expect(Number(row.batteryPercent)).toBe(100);
  });
});
