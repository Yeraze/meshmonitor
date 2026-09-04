/**
 * Migration 159 — PostgreSQL / MySQL container behaviour (#5032).
 *
 * The point of this file is that the migration's hand-written DDL and the
 * Drizzle schema agree. The repository suites build their fixture from the
 * Drizzle definitions, so they cannot catch a migration that creates the table
 * differently — and on `node_identity_merges` a mismatch means the undo journal
 * fails to write, which turns "reversible merge" into a lie discovered only
 * after someone needs the undo.
 *
 * So: run the real migration, then exercise the table through the real Drizzle
 * table object. Every column the app writes has to be there, with a type that
 * holds what the app puts in it.
 *
 * **Isolation.** Own PostgreSQL schema, own MySQL database. Sharing fixture
 * table names across suites in one test database is an active race — two suites
 * dropping `meshcore_nodes` is currently breaking migrations 153 and 156 — and
 * this table is written by the merge suites too.
 *
 * A silent skip still reports `success: true`; confirm coverage via
 * `numPendingTests` in the JSON reporter (CLAUDE.md Multi-Database section).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema/index.js';
import { nodeIdentityMergesPostgres, nodeIdentityMergesMysql } from '../../db/schema/nodeIdentityMerges.js';
import { runMigration159Postgres, runMigration159Mysql } from './159_node_identity_merges.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;

const PG_SCHEMA = 'nim_migration_159';
const MYSQL_DB = 'meshmonitor_test_nim_159';

/** A journal payload big enough that MySQL TEXT's 64 KiB cap would truncate it. */
const BIG_JOURNAL = JSON.stringify({
  version: 1,
  entries: [{ kind: 'rekey', pks: Array.from({ length: 20_000 }, (_, i) => i) }],
});

const ROW = {
  id: 'merge-159-test',
  sourceId: 'src-a',
  // Unsigned 32-bit: above PostgreSQL/MySQL signed INTEGER's ceiling, which is
  // why the column has to be BIGINT.
  fromNodeNum: 0xfedcba98,
  toNodeNum: 0x11223344,
  fromNodeId: '!fedcba98',
  toNodeId: '!11223344',
  basis: 'derivedNodeNum',
  mergedAt: 1_800_000_000_000,
  mergedBy: 'admin',
  rowsRekeyed: 95_413,
  rowsDropped: 3,
  undoable: true,
  undoBlockedReason: null,
  undoneAt: null,
  undoneBy: null,
  journalVersion: 1,
  journal: BIG_JOURNAL,
};

describe.skipIf(!postgresAvailable)('migration 159 — PostgreSQL (container)', () => {
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
      await runMigration159Postgres(client);
      // The ledger normally runs a migration once, but a crash between the
      // migration and its ledger write re-runs it — idempotency is mandatory.
      await expect(runMigration159Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    await db.insert(nodeIdentityMergesPostgres).values(ROW);
    const [row] = await db
      .select()
      .from(nodeIdentityMergesPostgres)
      .where(eq(nodeIdentityMergesPostgres.id, ROW.id));

    expect(Number(row.fromNodeNum)).toBe(ROW.fromNodeNum);
    expect(Number(row.mergedAt)).toBe(ROW.mergedAt);
    expect(row.undoable).toBe(true);
    expect(row.journal).toHaveLength(BIG_JOURNAL.length);
  });
});

describe.skipIf(!mysqlAvailable)('migration 159 — MySQL (container)', () => {
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
    await runMigration159Mysql(pool);
    await expect(runMigration159Mysql(pool)).resolves.toBeUndefined();

    await db.insert(nodeIdentityMergesMysql).values(ROW);
    const [row] = await db
      .select()
      .from(nodeIdentityMergesMysql)
      .where(eq(nodeIdentityMergesMysql.id, ROW.id));

    expect(Number(row.fromNodeNum)).toBe(ROW.fromNodeNum);
    expect(Number(row.mergedAt)).toBe(ROW.mergedAt);
    expect(row.undoable).toBe(true);
    // The whole reason `journal` is LONGTEXT: MySQL TEXT caps at 64 KiB and, in
    // a non-strict mode, truncates silently — a half-written undo tape.
    expect(row.journal).toHaveLength(BIG_JOURNAL.length);
  });
});
