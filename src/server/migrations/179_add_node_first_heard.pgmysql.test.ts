/**
 * Migration 179 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration179Postgres, runMigration179Mysql } from './179_add_node_first_heard.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const NOW_MS = Date.now();
const NOW_S = Math.floor(NOW_MS / 1000);
const DAY_S = 86_400;

describe.skipIf(!postgresAvailable)('migration 179 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig179'));
    await pool.query('DROP TABLE IF EXISTS nodes CASCADE');
    await pool.query('DROP TABLE IF EXISTS meshcore_nodes CASCADE');
    await pool.query(`
      CREATE TABLE nodes (
        "nodeNum" BIGINT NOT NULL,
        "nodeId" TEXT NOT NULL,
        "lastHeard" BIGINT,
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL,
        "sourceId" TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY ("nodeNum", "sourceId")
      )
    `);
    await pool.query(`
      CREATE TABLE meshcore_nodes (
        "publicKey" TEXT NOT NULL,
        "lastHeard" BIGINT,
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL,
        "sourceId" TEXT NOT NULL,
        PRIMARY KEY ("publicKey", "sourceId")
      )
    `);
    await pool.query(
      `INSERT INTO nodes ("nodeNum", "nodeId", "lastHeard", "createdAt", "updatedAt") VALUES
        (1, '!1', $1, $2, $3), (2, '!2', NULL, $3, $3)`,
      [NOW_S - DAY_S, (NOW_S - 10 * DAY_S) * 1000, NOW_MS],
    );
    await pool.query(
      `INSERT INTO meshcore_nodes ("publicKey", "lastHeard", "createdAt", "updatedAt", "sourceId") VALUES
        ('k1', $1, $2, $3, 'a')`,
      [NOW_MS - 30 * DAY_S * 1000, NOW_MS - DAY_S * 1000, NOW_MS],
    );
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the columns, backfills, and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration179Postgres(client);
      await expect(runMigration179Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows } = await pool.query(`SELECT "nodeNum", "firstHeard" FROM nodes ORDER BY "nodeNum"`);
    expect(Number(rows[0].firstHeard)).toBe(NOW_S - 10 * DAY_S);
    expect(rows[1].firstHeard).toBeNull();
    const { rows: mc } = await pool.query(`SELECT "firstHeard" FROM meshcore_nodes`);
    expect(Number(mc[0].firstHeard)).toBe(NOW_MS - 30 * DAY_S * 1000);
  });
});

describe.skipIf(!mysqlAvailable)('migration 179 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig179'));
    await pool.query('DROP TABLE IF EXISTS nodes');
    await pool.query('DROP TABLE IF EXISTS meshcore_nodes');
    await pool.query(`
      CREATE TABLE nodes (
        nodeNum BIGINT NOT NULL,
        nodeId VARCHAR(32) NOT NULL,
        lastHeard BIGINT,
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL,
        sourceId VARCHAR(36) NOT NULL DEFAULT 'default',
        PRIMARY KEY (nodeNum, sourceId)
      )
    `);
    await pool.query(`
      CREATE TABLE meshcore_nodes (
        publicKey VARCHAR(64) NOT NULL,
        lastHeard BIGINT,
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL,
        sourceId VARCHAR(36) NOT NULL,
        PRIMARY KEY (publicKey, sourceId)
      )
    `);
    await pool.query(
      `INSERT INTO nodes (nodeNum, nodeId, lastHeard, createdAt, updatedAt) VALUES
        (1, '!1', ?, ?, ?), (2, '!2', NULL, ?, ?)`,
      [NOW_S - DAY_S, (NOW_S - 10 * DAY_S) * 1000 + 999, NOW_MS, NOW_MS, NOW_MS],
    );
    await pool.query(
      `INSERT INTO meshcore_nodes (publicKey, lastHeard, createdAt, updatedAt, sourceId) VALUES ('k1', ?, ?, ?, 'a')`,
      [NOW_MS - 30 * DAY_S * 1000, NOW_MS - DAY_S * 1000, NOW_MS],
    );
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the columns, backfills with integer seconds, and is idempotent', async () => {
    await runMigration179Mysql(pool);
    await expect(runMigration179Mysql(pool)).resolves.toBeUndefined();
    const [rows] = await pool.query('SELECT nodeNum, firstHeard FROM nodes ORDER BY nodeNum');
    const r = rows as Array<{ firstHeard: number | string | null }>;
    // createdAt ended in 999 ms: DIV must truncate, not round.
    expect(Number(r[0].firstHeard)).toBe(NOW_S - 10 * DAY_S);
    expect(r[1].firstHeard).toBeNull();
    const [mc] = await pool.query('SELECT firstHeard FROM meshcore_nodes');
    expect(Number((mc as Array<{ firstHeard: number }>)[0].firstHeard)).toBe(NOW_MS - 30 * DAY_S * 1000);
  });
});
