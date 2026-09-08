/**
 * Migration 160 — PostgreSQL / MySQL container behaviour (#5097).
 *
 * The repository suites build their fixture from the Drizzle definitions, so
 * they cannot catch a migration whose `ALTER TABLE` disagrees with the schema.
 * Here the consequence of a mismatch is quiet: every traceroute insert would
 * either fail or drop `transportMechanism` on the floor, and the map's Show RF
 * / UDP / MQTT toggles would silently classify every route segment as RF —
 * looking exactly like the bug this migration exists to fix.
 *
 * So: create the table as it stood BEFORE this migration, run the real
 * migration, then write and read through the real Drizzle table object (which
 * now includes the column).
 *
 * **Isolation.** Own PostgreSQL schema, own MySQL database. `traceroutes` is a
 * fixture table in several other suites, and two suites creating/dropping the
 * same name in one test database is an active race (CLAUDE.md Multi-Database).
 *
 * A silent skip still reports `success: true`; confirm coverage via
 * `numPendingTests` in the JSON reporter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema/index.js';
import { traceroutesPostgres, traceroutesMysql } from '../../db/schema/traceroutes.js';
import { runMigration160Postgres, runMigration160Mysql } from './160_traceroute_transport_mechanism.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;

const PG_SCHEMA = 'tr_migration_160';
const MYSQL_DB = 'meshmonitor_test_tr_160';

/**
 * `traceroutes` as it existed at migration 159 — no `transportMechanism`, and
 * no FK to `nodes` (irrelevant to the column under test, and requiring the
 * whole nodes table here would just couple this suite to an unrelated schema).
 */
const PRE_MIGRATION_PG = `
  CREATE TABLE traceroutes (
    id SERIAL PRIMARY KEY,
    "fromNodeNum" BIGINT NOT NULL,
    "toNodeNum" BIGINT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    route TEXT,
    "routeBack" TEXT,
    "snrTowards" TEXT,
    "snrBack" TEXT,
    "routePositions" TEXT,
    channel INTEGER,
    "packetId" BIGINT,
    timestamp BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "sourceId" TEXT
  )`;

const PRE_MIGRATION_MYSQL = `
  CREATE TABLE traceroutes (
    id SERIAL PRIMARY KEY,
    fromNodeNum BIGINT NOT NULL,
    toNodeNum BIGINT NOT NULL,
    fromNodeId TEXT NOT NULL,
    toNodeId TEXT NOT NULL,
    route TEXT,
    routeBack TEXT,
    snrTowards TEXT,
    snrBack TEXT,
    routePositions TEXT,
    channel INT,
    packetId BIGINT,
    timestamp BIGINT NOT NULL,
    createdAt BIGINT NOT NULL,
    sourceId VARCHAR(36)
  )`;

const BASE_ROW = {
  fromNodeNum: 0xfedcba98, // unsigned 32-bit, above signed INTEGER's ceiling
  toNodeNum: 0x11223344,
  fromNodeId: '!fedcba98',
  toNodeId: '!11223344',
  route: '[300]',
  routeBack: '[300]',
  snrTowards: '[40,40]',
  snrBack: '[40,40]',
  routePositions: null,
  channel: 0,
  packetId: 987654321,
  timestamp: 1_800_000_000_000,
  createdAt: 1_800_000_000_000,
  sourceId: 'src-a',
};

/** MULTICAST_UDP — the value that could not be stored before this migration. */
const UDP = 6;

describe.skipIf(!postgresAvailable)('migration 160 — PostgreSQL (container)', () => {
  let pool: InstanceType<typeof PgPool>;
  let db: ReturnType<typeof drizzlePostgres>;

  beforeAll(async () => {
    const admin = new PgPool({
      host: 'localhost', port: 5433, user: 'test', password: 'test', database: 'meshmonitor_test',
    });
    await admin.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${PG_SCHEMA}`);
    await admin.end();

    pool = new PgPool({
      host: 'localhost', port: 5433, user: 'test', password: 'test', database: 'meshmonitor_test',
      options: `-c search_path=${PG_SCHEMA}`,
    });
    await pool.query(PRE_MIGRATION_PG);
    db = drizzlePostgres(pool, { schema });
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
      await pool.end();
    }
  });

  it('adds a column the Drizzle schema can round-trip, and runs twice safely', async () => {
    const client = await pool.connect();
    try {
      await runMigration160Postgres(client);
      // The ledger normally runs a migration once, but a crash between the
      // migration and its ledger write re-runs it — idempotency is mandatory.
      await expect(runMigration160Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    await db.insert(traceroutesPostgres).values({ ...BASE_ROW, transportMechanism: UDP });
    const [row] = await db
      .select()
      .from(traceroutesPostgres)
      .where(eq(traceroutesPostgres.packetId, BASE_ROW.packetId));

    expect(row.transportMechanism).toBe(UDP);
    expect(Number(row.fromNodeNum)).toBe(BASE_ROW.fromNodeNum);
  });

  it('leaves the column NULL for a row that supplies none', async () => {
    // The upgrade path: readers resolve NULL to 'rf', so historical traceroutes
    // stay visible. A NOT NULL / DEFAULT here would have been wrong — it would
    // assert a transport nobody recorded.
    await db.insert(traceroutesPostgres).values({ ...BASE_ROW, packetId: 111 });
    const [row] = await db
      .select()
      .from(traceroutesPostgres)
      .where(eq(traceroutesPostgres.packetId, 111));

    expect(row.transportMechanism).toBeNull();
  });
});

describe.skipIf(!mysqlAvailable)('migration 160 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzleMysql>;

  beforeAll(async () => {
    const admin = mysql.createPool({
      host: 'localhost', port: 3307, user: 'root', password: 'root', connectionLimit: 1,
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
    await admin.query(`CREATE DATABASE \`${MYSQL_DB}\``);
    await admin.query(`GRANT ALL ON \`${MYSQL_DB}\`.* TO 'test'@'%'`);
    await admin.query('FLUSH PRIVILEGES');
    await admin.end();

    pool = mysql.createPool({
      host: 'localhost', port: 3307, user: 'test', password: 'test', database: MYSQL_DB, connectionLimit: 5,
    });
    await pool.query(PRE_MIGRATION_MYSQL);
    db = drizzleMysql(pool, { schema, mode: 'default' });
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    const admin = mysql.createPool({
      host: 'localhost', port: 3307, user: 'root', password: 'root', connectionLimit: 1,
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
    await admin.end();
  });

  it('adds a column the Drizzle schema can round-trip, and runs twice safely', async () => {
    await runMigration160Mysql(pool);
    await expect(runMigration160Mysql(pool)).resolves.toBeUndefined();

    await db.insert(traceroutesMysql).values({ ...BASE_ROW, transportMechanism: UDP });
    const [row] = await db
      .select()
      .from(traceroutesMysql)
      .where(eq(traceroutesMysql.packetId, BASE_ROW.packetId));

    expect(row.transportMechanism).toBe(UDP);
    expect(Number(row.fromNodeNum)).toBe(BASE_ROW.fromNodeNum);
  });

  it('leaves the column NULL for a row that supplies none', async () => {
    await db.insert(traceroutesMysql).values({ ...BASE_ROW, packetId: 111 });
    const [row] = await db
      .select()
      .from(traceroutesMysql)
      .where(eq(traceroutesMysql.packetId, 111));

    expect(row.transportMechanism).toBeNull();
  });
});
