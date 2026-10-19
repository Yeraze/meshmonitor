/**
 * Migration 214 (#5876) — PostgreSQL / MySQL container behaviour (isolated DBs).
 * The table comes from the real migration-180 runners. A silent skip still
 * reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration180Postgres, runMigration180Mysql } from './180_create_aircraft_flight_matches.js';
import { runMigration214Postgres, runMigration214Mysql } from './214_add_aircraft_flight_match_rechecks.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const SELECT_PG = `SELECT "lastLookupAt", "lastLookupLat", "lastLookupLon", "rechecks", "misses" FROM aircraft_flight_matches WHERE "nodeNum" = 100`;
const SELECT_MY = `SELECT lastLookupAt, lastLookupLat, lastLookupLon, rechecks, misses FROM aircraft_flight_matches WHERE nodeNum = 100`;

describe.skipIf(!postgresAvailable)('migration 214 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig214'));
    await pool.query('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY)');
    await pool.query(`INSERT INTO sources (id) VALUES ('src-a') ON CONFLICT DO NOTHING`);
    const client = await pool.connect();
    try {
      await runMigration180Postgres(client);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the columns, is idempotent, defaults the counters and round-trips a write', async () => {
    await pool.query(`INSERT INTO aircraft_flight_matches ("sourceId", "nodeNum", "episodeStartedAt") VALUES ('src-a', 100, 1)`);
    const client = await pool.connect();
    try {
      await runMigration214Postgres(client);
      await expect(runMigration214Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows: before } = await pool.query(SELECT_PG);
    expect(before[0]).toEqual({ lastLookupAt: null, lastLookupLat: null, lastLookupLon: null, rechecks: 0, misses: 0 });
    const now = Date.now();
    await pool.query(
      `UPDATE aircraft_flight_matches SET "lastLookupAt" = $1, "lastLookupLat" = 25.8, "lastLookupLon" = -80.3, rechecks = 4, misses = 1 WHERE "nodeNum" = 100`,
      [now],
    );
    const { rows } = await pool.query(SELECT_PG);
    expect(Number(rows[0].lastLookupAt)).toBe(now);
    expect(rows[0]).toMatchObject({ lastLookupLat: 25.8, lastLookupLon: -80.3, rechecks: 4, misses: 1 });
  });
});

describe.skipIf(!mysqlAvailable)('migration 214 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig214'));
    await pool.query('CREATE TABLE IF NOT EXISTS sources (id VARCHAR(36) PRIMARY KEY)');
    await pool.query(`INSERT IGNORE INTO sources (id) VALUES ('src-a')`);
    await runMigration180Mysql(pool);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the columns, is idempotent, defaults the counters and round-trips a write', async () => {
    await pool.query(`INSERT INTO aircraft_flight_matches (sourceId, nodeNum, episodeStartedAt) VALUES ('src-a', 100, 1)`);
    await runMigration214Mysql(pool);
    await expect(runMigration214Mysql(pool)).resolves.toBeUndefined();
    const [beforeRows] = await pool.query(SELECT_MY);
    expect((beforeRows as any[])[0]).toMatchObject({ lastLookupAt: null, lastLookupLat: null, lastLookupLon: null, rechecks: 0, misses: 0 });
    const now = Date.now();
    await pool.query(
      `UPDATE aircraft_flight_matches SET lastLookupAt = ?, lastLookupLat = 25.8, lastLookupLon = -80.3, rechecks = 4, misses = 1 WHERE nodeNum = 100`,
      [now],
    );
    const [rows] = await pool.query(SELECT_MY);
    const row = (rows as any[])[0];
    expect(Number(row.lastLookupAt)).toBe(now);
    expect(row).toMatchObject({ lastLookupLat: 25.8, lastLookupLon: -80.3, rechecks: 4, misses: 1 });
  });
});
