/**
 * Migration 166 — PostgreSQL / MySQL container behaviour (#5232).
 *
 * `mutedAt` is what makes a permanent dismissal permanent. If the column is
 * missing or mistyped on a backend, muting a beacon reads as success and the
 * invitation comes back on the next advertise interval — the exact nagging the
 * column exists to stop, and the kind of failure that only shows up on
 * PostgreSQL or MySQL because SQLite is the default everywhere else.
 *
 * Also pins idempotency: a crash between the migration and its ledger write
 * re-runs it, so "already there" must be a no-op rather than a duplicate-column
 * error (#4233).
 *
 * **Isolation.** Own PostgreSQL schema, own MySQL database — `mesh_beacon_offers`
 * is a fixture table elsewhere, and two suites creating/dropping the same name
 * in one test database is an active race (CLAUDE.md Multi-Database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration166Postgres, runMigration166Mysql } from './166_mesh_beacon_mute.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;
const PG_SCHEMA = 'beacon_migration_166';
const MYSQL_DB = 'meshmonitor_test_beacon_166';

/** The table as migration 147 created it — no `mutedAt`. */
const PRE_PG = `
  CREATE TABLE mesh_beacon_offers (
    "sourceId" TEXT NOT NULL,
    "nodeNum" BIGINT NOT NULL,
    "offerChannelName" TEXT,
    "hasOffer" BOOLEAN NOT NULL DEFAULT FALSE,
    "firstSeenAt" BIGINT NOT NULL,
    "lastSeenAt" BIGINT NOT NULL,
    "dismissedAt" BIGINT,
    PRIMARY KEY ("sourceId", "nodeNum")
  )`;
const PRE_MYSQL = `
  CREATE TABLE mesh_beacon_offers (
    sourceId VARCHAR(191) NOT NULL,
    nodeNum BIGINT NOT NULL,
    offerChannelName VARCHAR(255),
    hasOffer BOOLEAN NOT NULL DEFAULT FALSE,
    firstSeenAt BIGINT NOT NULL,
    lastSeenAt BIGINT NOT NULL,
    dismissedAt BIGINT,
    PRIMARY KEY (sourceId, nodeNum)
  )`;

/** A ms-epoch mute timestamp — well past what a 32-bit INTEGER column holds. */
const MUTED_AT = 1_800_000_000_000;

describe.skipIf(!postgresAvailable)('migration 166 — PostgreSQL (container)', () => {
  let pool: InstanceType<typeof PgPool>;

  beforeAll(async () => {
    const admin = new PgPool({ host: 'localhost', port: 5433, user: 'test', password: 'test', database: 'meshmonitor_test' });
    await admin.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${PG_SCHEMA}`);
    await admin.end();

    pool = new PgPool({
      host: 'localhost', port: 5433, user: 'test', password: 'test', database: 'meshmonitor_test',
      options: `-c search_path=${PG_SCHEMA}`,
    });
    await pool.query(PRE_PG);
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
      await pool.end();
    }
  });

  it('adds a nullable mutedAt and runs twice safely', async () => {
    const client = await pool.connect();
    try {
      await runMigration166Postgres(client);
      await expect(runMigration166Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    // Existing rows are un-muted: the migration adds a capability, it does not
    // silence anything an upgraded install was already showing.
    await pool.query(
      `INSERT INTO mesh_beacon_offers ("sourceId", "nodeNum", "hasOffer", "firstSeenAt", "lastSeenAt")
       VALUES ('src-a', 305419896, TRUE, 1, 2)`,
    );
    const { rows } = await pool.query(`SELECT "mutedAt" FROM mesh_beacon_offers WHERE "nodeNum" = 305419896`);
    expect(rows[0].mutedAt).toBeNull();
  });

  it('stores a ms-epoch mute without truncating it', async () => {
    await pool.query(
      `INSERT INTO mesh_beacon_offers ("sourceId", "nodeNum", "hasOffer", "firstSeenAt", "lastSeenAt", "mutedAt")
       VALUES ('src-a', 1, TRUE, 1, 2, $1)`,
      [MUTED_AT],
    );
    const { rows } = await pool.query(`SELECT "mutedAt" FROM mesh_beacon_offers WHERE "nodeNum" = 1`);
    expect(Number(rows[0].mutedAt)).toBe(MUTED_AT);
  });
});

describe.skipIf(!mysqlAvailable)('migration 166 — MySQL (container)', () => {
  let pool: mysql.Pool;

  beforeAll(async () => {
    const admin = mysql.createPool({ host: 'localhost', port: 3307, user: 'root', password: 'root', connectionLimit: 1 });
    await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
    await admin.query(`CREATE DATABASE \`${MYSQL_DB}\``);
    await admin.query(`GRANT ALL ON \`${MYSQL_DB}\`.* TO 'test'@'%'`);
    await admin.query('FLUSH PRIVILEGES');
    await admin.end();

    pool = mysql.createPool({ host: 'localhost', port: 3307, user: 'test', password: 'test', database: MYSQL_DB, connectionLimit: 5 });
    await pool.query(PRE_MYSQL);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    const admin = mysql.createPool({ host: 'localhost', port: 3307, user: 'root', password: 'root', connectionLimit: 1 });
    await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
    await admin.end();
  });

  it('adds a nullable mutedAt and runs twice safely', async () => {
    await runMigration166Mysql(pool);
    await expect(runMigration166Mysql(pool)).resolves.toBeUndefined();

    await pool.query(
      `INSERT INTO mesh_beacon_offers (sourceId, nodeNum, hasOffer, firstSeenAt, lastSeenAt)
       VALUES ('src-a', 305419896, TRUE, 1, 2)`,
    );
    const [rows] = await pool.query(`SELECT mutedAt FROM mesh_beacon_offers WHERE nodeNum = 305419896`);
    expect((rows as Array<{ mutedAt: number | null }>)[0].mutedAt).toBeNull();
  });

  it('stores a ms-epoch mute without truncating it', async () => {
    await pool.query(
      `INSERT INTO mesh_beacon_offers (sourceId, nodeNum, hasOffer, firstSeenAt, lastSeenAt, mutedAt)
       VALUES ('src-a', 1, TRUE, 1, 2, ?)`,
      [MUTED_AT],
    );
    const [rows] = await pool.query(`SELECT mutedAt FROM mesh_beacon_offers WHERE nodeNum = 1`);
    expect(Number((rows as Array<{ mutedAt: number }>)[0].mutedAt)).toBe(MUTED_AT);
  });
});
