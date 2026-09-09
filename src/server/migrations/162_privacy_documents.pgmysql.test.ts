/**
 * Migration 162 — PostgreSQL / MySQL container behaviour (#5156).
 *
 * The repository suite builds its fixture from the Drizzle definitions, so it
 * cannot catch a migration whose `CREATE TABLE` disagrees with the schema.
 * Here the consequences are both quiet and bad:
 *
 *  - a column-name mismatch (`updatedBy` unquoted in PostgreSQL folds to
 *    `updatedby`) breaks every read of a published policy;
 *  - a missing UNIQUE on `slug` lets a second row appear for the same slug,
 *    and the links endpoint would then serve whichever one the planner
 *    happened to return;
 *  - `content` declared TEXT instead of LONGTEXT on MySQL truncates a long
 *    policy at 64 KiB, silently in non-strict mode. A half-published privacy
 *    policy is worse than none, so that one is asserted explicitly.
 *
 * So: run the real migration against an empty database, then write and read
 * through the real Drizzle table object.
 *
 * **Isolation.** Own PostgreSQL schema, own MySQL database (CLAUDE.md
 * Multi-Database: two suites creating/dropping the same table name in one test
 * database is an active race, not a flake).
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
import { privacyDocumentsPostgres, privacyDocumentsMysql } from '../../db/schema/privacyDocuments.js';
import { runMigration162Postgres, runMigration162Mysql } from './162_privacy_documents.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;

const PG_SCHEMA = 'privacy_migration_162';
const MYSQL_DB = 'meshmonitor_test_privacy_162';

const NOW = 1_800_000_000_000;

const BASE_ROW = {
  slug: 'privacy',
  title: 'Privacy Policy',
  content: '# Privacy Policy\n\nWe keep mesh packets.',
  updatedBy: 'admin',
  createdAt: NOW,
  updatedAt: NOW,
};

/** Comfortably past MySQL TEXT's 64 KiB ceiling. */
const LONG_POLICY = `# Policy\n\n${'All your packets are belong to us. '.repeat(3000)}`;

describe.skipIf(!postgresAvailable)('migration 162 — PostgreSQL (container)', () => {
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
      await runMigration162Postgres(client);
      // The ledger normally runs a migration once, but a crash between the
      // migration and its ledger write re-runs it — idempotency is mandatory.
      await expect(runMigration162Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    await db.insert(privacyDocumentsPostgres).values(BASE_ROW);
    const [row] = await db
      .select()
      .from(privacyDocumentsPostgres)
      .where(eq(privacyDocumentsPostgres.slug, 'privacy'));

    expect(row.title).toBe('Privacy Policy');
    expect(row.content).toBe(BASE_ROW.content);
    // Quoted camelCase: an unquoted DDL would fold this to `updatedby` and the
    // Drizzle select would come back undefined rather than error.
    expect(row.updatedBy).toBe('admin');
    expect(Number(row.createdAt)).toBe(NOW);
  });

  it('rejects a second row for the same slug', async () => {
    await expect(
      db.insert(privacyDocumentsPostgres).values({ ...BASE_ROW, title: 'Duplicate' }),
    ).rejects.toThrow();
  });

  it('stores a policy larger than 64 KiB without truncating it', async () => {
    await db.insert(privacyDocumentsPostgres).values({
      ...BASE_ROW,
      slug: 'terms',
      content: LONG_POLICY,
    });
    const [row] = await db
      .select()
      .from(privacyDocumentsPostgres)
      .where(eq(privacyDocumentsPostgres.slug, 'terms'));

    expect(row.content).toHaveLength(LONG_POLICY.length);
  });
});

describe.skipIf(!mysqlAvailable)('migration 162 — MySQL (container)', () => {
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
    await runMigration162Mysql(pool);
    await expect(runMigration162Mysql(pool)).resolves.toBeUndefined();

    await db.insert(privacyDocumentsMysql).values(BASE_ROW);
    const [row] = await db
      .select()
      .from(privacyDocumentsMysql)
      .where(eq(privacyDocumentsMysql.slug, 'privacy'));

    expect(row.title).toBe('Privacy Policy');
    expect(row.content).toBe(BASE_ROW.content);
    expect(row.updatedBy).toBe('admin');
    expect(Number(row.createdAt)).toBe(NOW);
  });

  it('rejects a second row for the same slug', async () => {
    await expect(
      db.insert(privacyDocumentsMysql).values({ ...BASE_ROW, title: 'Duplicate' }),
    ).rejects.toThrow();
  });

  it('stores a policy larger than 64 KiB without truncating it', async () => {
    // The regression this guards: `content TEXT` caps at 64 KiB and, in
    // non-strict mode, truncates instead of erroring — publishing a policy
    // that silently stops mid-sentence. The column must be LONGTEXT.
    await db.insert(privacyDocumentsMysql).values({
      ...BASE_ROW,
      slug: 'terms',
      content: LONG_POLICY,
    });
    const [row] = await db
      .select()
      .from(privacyDocumentsMysql)
      .where(eq(privacyDocumentsMysql.slug, 'terms'));

    expect(row.content).toHaveLength(LONG_POLICY.length);
  });
});
