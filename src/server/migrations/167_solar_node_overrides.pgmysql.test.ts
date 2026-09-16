/**
 * Migration 167 — PostgreSQL / MySQL container behaviour (#3195).
 *
 * The repository suite builds its fixture from SQLite, so it cannot catch a
 * migration whose `CREATE TABLE` disagrees with the Drizzle schema on the other
 * two backends. Two quiet failures matter here:
 *
 *  - `nodeNum` declared INTEGER instead of BIGINT overflows for any node number
 *    above 0x7fffffff — roughly half of all real node numbers;
 *  - an unquoted `"isSolar"` in PostgreSQL folds to `issolar`, and the Drizzle
 *    select comes back undefined rather than erroring.
 *
 * So: run the real migration against an empty database, then write and read
 * through the real Drizzle table object.
 *
 * **Isolation.** Own PostgreSQL schema and own MySQL database (CLAUDE.md
 * Multi-Database). A silent skip still reports `success: true`; confirm
 * coverage via `numPendingTests` in the JSON reporter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema/index.js';
import { solarNodeOverridesPostgres, solarNodeOverridesMysql } from '../../db/schema/solarNodeOverrides.js';
import { runMigration167Postgres, runMigration167Mysql } from './167_solar_node_overrides.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;

const PG_SCHEMA = 'solar_overrides_migration_167';
const MYSQL_DB = 'meshmonitor_test_solar_167';

/** Above the signed 32-bit ceiling — the case an INTEGER column breaks. */
const BIG_NODE = 0xfedcba98;
const NOW = 1_800_000_000_000;

describe.skipIf(!postgresAvailable)('migration 167 — PostgreSQL (container)', () => {
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
    db = drizzlePostgres(pool, { schema });
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
      await pool.end();
    }
  });

  it('creates a table the Drizzle schema can round-trip, and runs twice safely', async () => {
    const client = await pool.connect();
    try {
      await runMigration167Postgres(client);
      await expect(runMigration167Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    await db.insert(solarNodeOverridesPostgres).values({ nodeNum: BIG_NODE, isSolar: true, updatedBy: 'admin', updatedAt: NOW });
    const [row] = await db.select().from(solarNodeOverridesPostgres).where(eq(solarNodeOverridesPostgres.nodeNum, BIG_NODE));

    expect(Number(row.nodeNum)).toBe(BIG_NODE);
    expect(row.isSolar).toBe(true);
    expect(row.updatedBy).toBe('admin');
    expect(Number(row.updatedAt)).toBe(NOW);
  });

  it('rejects a second row for the same node', async () => {
    await expect(
      db.insert(solarNodeOverridesPostgres).values({ nodeNum: BIG_NODE, isSolar: false, updatedAt: NOW }),
    ).rejects.toThrow();
  });
});

describe.skipIf(!mysqlAvailable)('migration 167 — MySQL (container)', () => {
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

  it('creates a table the Drizzle schema can round-trip, and runs twice safely', async () => {
    await runMigration167Mysql(pool);
    await expect(runMigration167Mysql(pool)).resolves.toBeUndefined();

    await db.insert(solarNodeOverridesMysql).values({ nodeNum: BIG_NODE, isSolar: false, updatedBy: 'admin', updatedAt: NOW });
    const [row] = await db.select().from(solarNodeOverridesMysql).where(eq(solarNodeOverridesMysql.nodeNum, BIG_NODE));

    expect(Number(row.nodeNum)).toBe(BIG_NODE);
    expect(row.isSolar).toBe(false);
    expect(row.updatedBy).toBe('admin');
  });

  it('rejects a second row for the same node', async () => {
    await expect(
      db.insert(solarNodeOverridesMysql).values({ nodeNum: BIG_NODE, isSolar: true, updatedAt: NOW }),
    ).rejects.toThrow();
  });
});
