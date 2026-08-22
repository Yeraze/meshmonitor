/**
 * Migration 153 — PostgreSQL / MySQL container behaviour (#4618).
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)` — seeds a minimal
 * `meshcore_nodes` table against the live test containers (localhost:5433 /
 * :3307), runs the ADD-COLUMN migration, asserts the three neighbours columns
 * exist with their defaults, and asserts idempotency (running twice is a
 * no-op). A silent skip here still reports `success: true` at the suite level
 * — confirm via `numPendingTests` in the JSON reporter, not just the pass/fail
 * summary (see CLAUDE.md Multi-Database section).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration153Postgres, runMigration153Mysql } from './153_meshcore_node_neighbors_config.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;

describe.skipIf(!postgresAvailable)('migration 153 — PostgreSQL (container)', () => {
  let pool: InstanceType<typeof PgPool>;

  beforeAll(async () => {
    pool = new PgPool({
      host: 'localhost',
      port: 5433,
      user: 'test',
      password: 'test',
      database: 'meshmonitor_test',
    });
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
      await pool.end();
    }
  });

  it('adds the neighbours columns with defaults and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration153Postgres(client);
      await expect(runMigration153Postgres(client)).resolves.toBeUndefined();
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
      `SELECT "neighborsEnabled", "neighborsIntervalMinutes", "lastNeighborsRequestAt"
       FROM meshcore_nodes WHERE "publicKey" = 'pk-1'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].neighborsEnabled).toBe(false);
    expect(rows[0].neighborsIntervalMinutes).toBe(60);
    expect(rows[0].lastNeighborsRequestAt).toBeNull();
  });
});

describe.skipIf(!mysqlAvailable)('migration 153 — MySQL (container)', () => {
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
      await pool.end();
    }
  });

  it('adds the neighbours columns with defaults and is idempotent', async () => {
    await runMigration153Mysql(pool);
    await expect(runMigration153Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    await pool.query(
      `INSERT INTO meshcore_nodes (publicKey, name, sourceId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?)`,
      ['pk-1', 'node-1', 'src-a', now, now],
    );

    const [rows] = await pool.query(
      `SELECT neighborsEnabled, neighborsIntervalMinutes, lastNeighborsRequestAt
       FROM meshcore_nodes WHERE publicKey = 'pk-1'`,
    );
    const result = rows as any[];
    expect(result).toHaveLength(1);
    expect(result[0].neighborsEnabled).toBe(0);
    expect(result[0].neighborsIntervalMinutes).toBe(60);
    expect(result[0].lastNeighborsRequestAt).toBeNull();
  });
});
