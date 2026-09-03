/**
 * Migration 158 — PostgreSQL / MySQL container behaviour (#5040 Phase 2).
 *
 * Seeds a minimal `meshcore_packet_log` against the live test containers
 * (localhost:5433 / :3307), runs the ADD-COLUMN + CREATE-INDEX migration,
 * asserts the column and index exist and that a second run is a no-op.
 *
 * MySQL detail worth pinning: `rawHex` is TEXT there, so the index needs a
 * prefix length (`rawHex(64)`) — without it MySQL errors with "BLOB/TEXT
 * column used in key specification without a key length", which would only
 * surface on a MySQL deployment.
 *
 * A silent skip still reports `success: true`; confirm via `numPendingTests`
 * in the JSON reporter (CLAUDE.md, Multi-Database section).
 *
 * Registered in `SHARED_DB_TESTS` because it DROP/CREATEs a table shared with
 * every other suite touching `meshcore_packet_log` — see the 153/156 race.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration158Postgres, runMigration158Mysql } from './158_meshcore_packet_log_observer.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;
const INDEX = 'idx_meshcore_packet_log_source_raw';

describe.skipIf(!postgresAvailable)('migration 158 — PostgreSQL (container)', () => {
  let pool: InstanceType<typeof PgPool>;

  beforeAll(async () => {
    pool = new PgPool({
      host: 'localhost',
      port: 5433,
      user: 'test',
      password: 'test',
      database: 'meshmonitor_test',
    });
    await pool.query('DROP TABLE IF EXISTS meshcore_packet_log CASCADE');
    await pool.query(`
      CREATE TABLE meshcore_packet_log (
        id SERIAL PRIMARY KEY,
        "sourceId" TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        "payloadType" INTEGER NOT NULL,
        "rawHex" TEXT,
        "createdAt" BIGINT NOT NULL
      )
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS meshcore_packet_log CASCADE');
      await pool.end();
    }
  });

  it('adds observerId and the dedup index, and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration158Postgres(client);
      await expect(runMigration158Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'meshcore_packet_log' AND column_name = 'observerId'`,
    );
    expect(cols.rowCount).toBe(1);

    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'meshcore_packet_log' AND indexname = $1`,
      [INDEX],
    );
    expect(idx.rowCount).toBe(1);
  });

  it('accepts a NULL observerId for a locally-heard row', async () => {
    const now = Date.now();
    await pool.query(
      `INSERT INTO meshcore_packet_log ("sourceId", timestamp, "payloadType", "rawHex", "createdAt")
       VALUES ($1, $2, $3, $4, $5)`,
      ['src-device', now, 2, '0500dead', now],
    );
    const res = await pool.query(
      `SELECT "observerId" FROM meshcore_packet_log WHERE "sourceId" = 'src-device'`,
    );
    expect(res.rows[0].observerId).toBeNull();
  });
});

describe.skipIf(!mysqlAvailable)('migration 158 — MySQL (container)', () => {
  let pool: mysql.Pool;

  beforeAll(async () => {
    pool = mysql.createPool({
      host: 'localhost',
      port: 3307,
      user: 'test',
      password: 'test',
      database: 'meshmonitor_test',
    });
    await pool.query('DROP TABLE IF EXISTS meshcore_packet_log');
    await pool.query(`
      CREATE TABLE meshcore_packet_log (
        id SERIAL PRIMARY KEY,
        sourceId VARCHAR(255) NOT NULL,
        timestamp BIGINT NOT NULL,
        payloadType INT NOT NULL,
        rawHex TEXT,
        createdAt BIGINT NOT NULL
      )
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS meshcore_packet_log');
      await pool.end();
    }
  });

  it('adds observerId and a PREFIXED index (TEXT needs a key length), idempotently', async () => {
    await runMigration158Mysql(pool);
    await expect(runMigration158Mysql(pool)).resolves.toBeUndefined();

    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_packet_log'
         AND COLUMN_NAME = 'observerId'`,
    );
    expect((cols as unknown[]).length).toBe(1);

    const [idx] = await pool.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_packet_log'
         AND INDEX_NAME = ?`,
      [INDEX],
    );
    expect((idx as unknown[]).length).toBeGreaterThan(0);
  });
});
