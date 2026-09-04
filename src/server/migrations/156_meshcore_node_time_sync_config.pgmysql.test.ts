/**
 * Migration 156 — PostgreSQL / MySQL container behaviour (#4916).
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)` — seeds a minimal
 * `meshcore_nodes` table against the live test containers (localhost:5433 /
 * :3307), runs the ADD-COLUMN migration, asserts the three time-sync columns
 * exist with their defaults, and asserts idempotency (running twice is a
 * no-op). A silent skip here still reports `success: true` at the suite level
 * — confirm via `numPendingTests` in the JSON reporter, not just the pass/fail
 * summary (see CLAUDE.md Multi-Database section).
 *
 * The fixture runs in its OWN throwaway database (`createIsolated*Database`),
 * not the shared `meshmonitor_test`. Migration 153 seeds the same
 * `meshcore_nodes` table; while both used the shared database, whichever
 * finished first dropped the table out from under the other and the pair
 * failed 100% of the time in parallel — a failure that was twice written off
 * as "pre-existing and environmental". Keep the isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration156Postgres, runMigration156Mysql } from './156_meshcore_node_time_sync_config.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 156 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig156'));
    await pool.query('DROP TABLE IF EXISTS meshcore_nodes CASCADE');
    await pool.query(`
      CREATE TABLE meshcore_nodes (
        "publicKey" TEXT NOT NULL,
        name TEXT,
        "sourceId" TEXT NOT NULL,
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL,
        PRIMARY KEY ("sourceId", "publicKey")
      )
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS meshcore_nodes CASCADE');
      await cleanup?.();
    }
  });

  it('adds the time-sync columns with defaults and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration156Postgres(client);
      await expect(runMigration156Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO meshcore_nodes ("publicKey", name, "sourceId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $4)`,
      ['pk-1', 'node-1', 'src-a', now],
    );

    const { rows } = await pool.query(
      `SELECT "timeSyncEnabled", "timeSyncIntervalMinutes", "lastTimeSyncAt"
       FROM meshcore_nodes WHERE "publicKey" = 'pk-1'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].timeSyncEnabled).toBe(false);
    expect(rows[0].timeSyncIntervalMinutes).toBe(720);
    expect(rows[0].lastTimeSyncAt).toBeNull();
  });
});

describe.skipIf(!mysqlAvailable)('migration 156 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig156'));
    await pool.query('DROP TABLE IF EXISTS meshcore_nodes');
    await pool.query(`
      CREATE TABLE meshcore_nodes (
        publicKey VARCHAR(64) NOT NULL,
        name VARCHAR(255),
        sourceId VARCHAR(64) NOT NULL,
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL,
        PRIMARY KEY (sourceId, publicKey)
      )
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS meshcore_nodes');
      await cleanup?.();
    }
  });

  it('adds the time-sync columns with defaults and is idempotent', async () => {
    await runMigration156Mysql(pool);
    await expect(runMigration156Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    await pool.query(
      `INSERT INTO meshcore_nodes (publicKey, name, sourceId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?)`,
      ['pk-1', 'node-1', 'src-a', now, now],
    );

    const [rows] = await pool.query(
      `SELECT timeSyncEnabled, timeSyncIntervalMinutes, lastTimeSyncAt
       FROM meshcore_nodes WHERE publicKey = 'pk-1'`,
    );
    const result = rows as any[];
    expect(result).toHaveLength(1);
    expect(result[0].timeSyncEnabled).toBe(0);
    expect(result[0].timeSyncIntervalMinutes).toBe(720);
    expect(result[0].lastTimeSyncAt).toBeNull();
  });
});
