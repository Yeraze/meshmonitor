/**
 * Migration 142 — PostgreSQL / MySQL container behaviour.
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
import { runMigration142Postgres, runMigration142Mysql } from './142_create_reticulum_interfaces.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;

describe.skipIf(!postgresAvailable)('migration 141 — PostgreSQL (container)', () => {
  let pool: InstanceType<typeof PgPool>;

  beforeAll(async () => {
    pool = new PgPool({
      host: 'localhost',
      port: 5433,
      user: 'test',
      password: 'test',
      database: 'meshmonitor_test',
    });
    await pool.query('DROP TABLE IF EXISTS reticulum_interfaces CASCADE');
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('creates the table + unique index, is idempotent, and enforces the unique constraint', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration142Postgres(client1);
      await expect(runMigration142Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO reticulum_interfaces
        ("sourceId", "interfaceName", status, online, "txBytes", "rxBytes", "lastSeenAt", "createdAt", "updatedAt")
       VALUES ('src-1', 'TCPClientInterface[a]', 'up', true, 100, 200, $1, $1, $1)`,
      [now],
    );

    await expect(
      pool.query(
        `INSERT INTO reticulum_interfaces
          ("sourceId", "interfaceName", status, online, "txBytes", "rxBytes", "lastSeenAt", "createdAt", "updatedAt")
         VALUES ('src-1', 'TCPClientInterface[a]', 'up', true, 0, 0, $1, $1, $1)`,
        [now],
      ),
    ).rejects.toThrow();
  });
});

describe.skipIf(!mysqlAvailable)('migration 141 — MySQL (container)', () => {
  let pool: mysql.Pool;

  beforeAll(async () => {
    pool = mysql.createPool({
      host: 'localhost',
      port: 3307,
      user: 'test',
      password: 'test',
      database: 'meshmonitor_test',
      connectionLimit: 5,
    });
    await pool.query('DROP TABLE IF EXISTS reticulum_interfaces');
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('creates the table + unique key, is idempotent, and enforces the unique constraint', async () => {
    await runMigration142Mysql(pool);
    await expect(runMigration142Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    await pool.query(
      `INSERT INTO reticulum_interfaces
        (sourceId, interfaceName, status, online, txBytes, rxBytes, lastSeenAt, createdAt, updatedAt)
       VALUES ('src-1', 'TCPClientInterface[a]', 'up', 1, 100, 200, ?, ?, ?)`,
      [now, now, now],
    );

    await expect(
      pool.query(
        `INSERT INTO reticulum_interfaces
          (sourceId, interfaceName, status, online, txBytes, rxBytes, lastSeenAt, createdAt, updatedAt)
         VALUES ('src-1', 'TCPClientInterface[a]', 'up', 1, 0, 0, ?, ?, ?)`,
        [now, now, now],
      ),
    ).rejects.toThrow();
  });
});
