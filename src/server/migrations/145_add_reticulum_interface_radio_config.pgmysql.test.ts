/**
 * Migration 145 — PostgreSQL / MySQL container behaviour.
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)` — runs migration 142
 * (to create the base `reticulum_interfaces` table) followed by the real
 * migration 145 functions against the live test containers (localhost:5433 /
 * :3307), and asserts column presence + idempotency + a round-tripped
 * radio-config patch on each backend. A silent skip here still reports
 * `success: true` at the suite level — confirm via `numPendingTests` in the
 * JSON reporter, not just the pass/fail summary (see CLAUDE.md Multi-Database
 * section).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration142Postgres, runMigration142Mysql } from './142_create_reticulum_interfaces.js';
import { runMigration145Postgres, runMigration145Mysql } from './145_add_reticulum_interface_radio_config.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 145 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig145'));
    await pool.query('DROP TABLE IF EXISTS reticulum_interfaces CASCADE');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the radio-config columns to an existing table, is idempotent, and round-trips a patch', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration142Postgres(client1);
      await runMigration145Postgres(client1);
      await expect(runMigration145Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO reticulum_interfaces
        ("sourceId", "interfaceName", status, online, "txBytes", "rxBytes", "lastSeenAt", "createdAt", "updatedAt")
       VALUES ('src-1', 'RNodeInterface[/dev/ttyUSB0]', 'up', true, 0, 0, $1, $1, $1)`,
      [now],
    );

    await pool.query(
      `UPDATE reticulum_interfaces
       SET frequency = $1, bandwidth = $2, "spreadingFactor" = $3, "codingRate" = $4, "txPower" = $5,
           "stAlock" = $6, "ltAlock" = $7, "radioState" = $8, "deviceInfoJson" = $9
       WHERE "interfaceName" = 'RNodeInterface[/dev/ttyUSB0]'`,
      [915000000, 125000, 8, 5, 17, 33.3, 66.6, true, '{"fw":"1.60"}'],
    );

    const { rows } = await pool.query(
      `SELECT frequency, bandwidth, "spreadingFactor", "codingRate", "txPower", "stAlock", "ltAlock", "radioState", "deviceInfoJson"
       FROM reticulum_interfaces WHERE "interfaceName" = 'RNodeInterface[/dev/ttyUSB0]'`,
    );
    expect(Number(rows[0].frequency)).toBeCloseTo(915000000);
    expect(Number(rows[0].bandwidth)).toBeCloseTo(125000);
    expect(rows[0].spreadingFactor).toBe(8);
    expect(rows[0].codingRate).toBe(5);
    expect(rows[0].txPower).toBe(17);
    expect(Number(rows[0].stAlock)).toBeCloseTo(33.3);
    expect(Number(rows[0].ltAlock)).toBeCloseTo(66.6);
    expect(rows[0].radioState).toBe(true);
    expect(rows[0].deviceInfoJson).toBe('{"fw":"1.60"}');
  });
});

describe.skipIf(!mysqlAvailable)('migration 145 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig145'));
    await pool.query('DROP TABLE IF EXISTS reticulum_interfaces');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the radio-config columns to an existing table, is idempotent, and round-trips a patch', async () => {
    await runMigration142Mysql(pool);
    await runMigration145Mysql(pool);
    await expect(runMigration145Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    await pool.query(
      `INSERT INTO reticulum_interfaces
        (sourceId, interfaceName, status, online, txBytes, rxBytes, lastSeenAt, createdAt, updatedAt)
       VALUES ('src-1', 'RNodeInterface[/dev/ttyUSB0]', 'up', 1, 0, 0, ?, ?, ?)`,
      [now, now, now],
    );

    await pool.query(
      `UPDATE reticulum_interfaces
       SET frequency = ?, bandwidth = ?, spreadingFactor = ?, codingRate = ?, txPower = ?,
           stAlock = ?, ltAlock = ?, radioState = ?, deviceInfoJson = ?
       WHERE interfaceName = 'RNodeInterface[/dev/ttyUSB0]'`,
      [915000000, 125000, 8, 5, 17, 33.3, 66.6, 1, '{"fw":"1.60"}'],
    );

    const [rows] = await pool.query(
      `SELECT frequency, bandwidth, spreadingFactor, codingRate, txPower, stAlock, ltAlock, radioState, deviceInfoJson
       FROM reticulum_interfaces WHERE interfaceName = 'RNodeInterface[/dev/ttyUSB0]'`,
    );
    const row = (rows as any[])[0];
    expect(Number(row.frequency)).toBeCloseTo(915000000);
    expect(Number(row.bandwidth)).toBeCloseTo(125000);
    expect(row.spreadingFactor).toBe(8);
    expect(row.codingRate).toBe(5);
    expect(row.txPower).toBe(17);
    expect(Number(row.stAlock)).toBeCloseTo(33.3);
    expect(Number(row.ltAlock)).toBeCloseTo(66.6);
    expect(row.radioState).toBe(1);
    expect(row.deviceInfoJson).toBe('{"fw":"1.60"}');
  });
});
