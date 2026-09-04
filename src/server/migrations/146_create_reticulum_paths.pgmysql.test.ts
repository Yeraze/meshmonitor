/**
 * Migration 146 — PostgreSQL / MySQL container behaviour.
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
import { runMigration146Postgres, runMigration146Mysql } from './146_create_reticulum_paths.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 146 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig146'));
    await pool.query('DROP TABLE IF EXISTS reticulum_paths CASCADE');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table + indexes, is idempotent, and enforces the unique constraint', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration146Postgres(client1);
      await expect(runMigration146Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO reticulum_paths
        ("sourceId", "destinationHash", "viaHash", hops, "interfaceName", "expiresAt", "updatedAt")
       VALUES ('src-1', 'dest-hash-a', 'via-hash-a', 2, 'TCPClientInterface[a]', $1, $1)`,
      [now],
    );

    await expect(
      pool.query(
        `INSERT INTO reticulum_paths
          ("sourceId", "destinationHash", "viaHash", hops, "interfaceName", "expiresAt", "updatedAt")
         VALUES ('src-1', 'dest-hash-a', 'via-hash-b', 3, 'TCPClientInterface[b]', $1, $1)`,
        [now],
      ),
    ).rejects.toThrow();

    // Same destinationHash under a different source is allowed.
    await expect(
      pool.query(
        `INSERT INTO reticulum_paths
          ("sourceId", "destinationHash", "viaHash", hops, "interfaceName", "expiresAt", "updatedAt")
         VALUES ('src-2', 'dest-hash-a', NULL, NULL, NULL, NULL, $1)`,
        [now],
      ),
    ).resolves.toBeTruthy();

    const { rows } = await pool.query(
      `SELECT "viaHash", hops, "interfaceName" FROM reticulum_paths WHERE "sourceId" = 'src-1' AND "destinationHash" = 'dest-hash-a'`,
    );
    expect(rows[0].viaHash).toBe('via-hash-a');
    expect(rows[0].hops).toBe(2);
    expect(rows[0].interfaceName).toBe('TCPClientInterface[a]');
  });
});

describe.skipIf(!mysqlAvailable)('migration 146 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig146'));
    await pool.query('DROP TABLE IF EXISTS reticulum_paths');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table + unique key, is idempotent, and enforces the unique constraint', async () => {
    await runMigration146Mysql(pool);
    await expect(runMigration146Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    await pool.query(
      `INSERT INTO reticulum_paths
        (sourceId, destinationHash, viaHash, hops, interfaceName, expiresAt, updatedAt)
       VALUES ('src-1', 'dest-hash-a', 'via-hash-a', 2, 'TCPClientInterface[a]', ?, ?)`,
      [now, now],
    );

    await expect(
      pool.query(
        `INSERT INTO reticulum_paths
          (sourceId, destinationHash, viaHash, hops, interfaceName, expiresAt, updatedAt)
         VALUES ('src-1', 'dest-hash-a', 'via-hash-b', 3, 'TCPClientInterface[b]', ?, ?)`,
        [now, now],
      ),
    ).rejects.toThrow();

    // Same destinationHash under a different source is allowed.
    await expect(
      pool.query(
        `INSERT INTO reticulum_paths
          (sourceId, destinationHash, viaHash, hops, interfaceName, expiresAt, updatedAt)
         VALUES ('src-2', 'dest-hash-a', NULL, NULL, NULL, NULL, ?)`,
        [now],
      ),
    ).resolves.toBeTruthy();

    const [rows] = await pool.query(
      `SELECT viaHash, hops, interfaceName FROM reticulum_paths WHERE sourceId = 'src-1' AND destinationHash = 'dest-hash-a'`,
    );
    const row = (rows as any[])[0];
    expect(row.viaHash).toBe('via-hash-a');
    expect(row.hops).toBe(2);
    expect(row.interfaceName).toBe('TCPClientInterface[a]');
  });
});
