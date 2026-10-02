/**
 * "Already applied?" checks must look at THIS database/schema only.
 *
 * Old migrations queried `information_schema` (and PG catalogs) by table name
 * alone. On a MySQL server hosting a second database (two MeshMonitor
 * instances, or parallel CI suites with isolated databases), a column that
 * exists in the OTHER database made the check skip the ALTER here. On
 * PostgreSQL the same happens across schemas in one database.
 *
 * Each test plants a decoy (table/column/constraint) in a second
 * database/schema, runs the check against the target, and asserts the target
 * still gets the change. A silent skip still reports success; confirm via
 * `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration034Mysql } from './034_add_via_store_forward.js';
import { runMigration035Mysql } from './035_add_is_store_forward_server.js';
import { runMigration084Postgres } from './008_add_key_mismatch_columns.js';
import { runMigration024Postgres } from './024_add_source_id_to_traceroute_tables.js';
import { runMigration047Postgres } from './047_add_selected_layer_to_user_map_preferences.js';
import {
  addColumnIfMissingMysql,
  createTableIfMissingMysql,
  createIndexIfMissingMysql,
} from './helpers.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

async function mysqlColumnExists(pool: mysql.Pool, table: string, column: string): Promise<boolean> {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return (rows as unknown[]).length > 0;
}

describe.skipIf(!mysqlAvailable)('information_schema checks are scoped to DATABASE() — MySQL', () => {
  let decoy: mysql.Pool;
  let target: mysql.Pool;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    const a = await createIsolatedMysqlDatabase('infoschema_decoy');
    const b = await createIsolatedMysqlDatabase('infoschema_target');
    decoy = a.pool;
    target = b.pool;
    cleanups.push(a.cleanup, b.cleanup);

    // Decoy database: every column/table/index the checks look for already exists.
    await decoy.query('CREATE TABLE messages (id INT PRIMARY KEY, viaStoreForward BOOLEAN)');
    await decoy.query('CREATE TABLE nodes (id INT PRIMARY KEY, isStoreForwardServer BOOLEAN, helperCol INT)');
    await decoy.query('CREATE INDEX idx_nodes_helper ON nodes(helperCol)');
    await decoy.query('CREATE TABLE helper_table (id INT PRIMARY KEY)');

    // Target database: none of them exist yet.
    await target.query('CREATE TABLE messages (id INT PRIMARY KEY)');
    await target.query('CREATE TABLE nodes (id INT PRIMARY KEY)');
  });

  afterAll(async () => {
    for (const c of cleanups) await c();
  });

  it('migrations 034/035 add their column even when another database already has it', async () => {
    await runMigration034Mysql(target);
    await runMigration035Mysql(target);
    expect(await mysqlColumnExists(target, 'messages', 'viaStoreForward')).toBe(true);
    expect(await mysqlColumnExists(target, 'nodes', 'isStoreForwardServer')).toBe(true);

    // Still idempotent on a second run.
    await runMigration034Mysql(target);
    await runMigration035Mysql(target);
  });

  it('addColumnIfMissingMysql / createIndexIfMissingMysql / createTableIfMissingMysql ignore other databases', async () => {
    await addColumnIfMissingMysql(target, 'nodes', 'helperCol', 'helperCol INT');
    expect(await mysqlColumnExists(target, 'nodes', 'helperCol')).toBe(true);

    await createIndexIfMissingMysql(
      target, 'nodes', 'idx_nodes_helper', 'CREATE INDEX idx_nodes_helper ON nodes(helperCol)',
    );
    const [idx] = await target.query(
      `SELECT 1 FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nodes' AND INDEX_NAME = 'idx_nodes_helper'`,
    );
    expect((idx as unknown[]).length).toBeGreaterThan(0);

    await createTableIfMissingMysql(target, 'helper_table', 'CREATE TABLE helper_table (id INT PRIMARY KEY)');
    const [tbl] = await target.query(
      `SELECT 1 FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'helper_table'`,
    );
    expect((tbl as unknown[]).length).toBe(1);
  });
});

describe.skipIf(!postgresAvailable)('information_schema / pg_catalog checks are scoped to current_schema() — PostgreSQL', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  async function pgColumnExists(table: string, column: string): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return rows.length > 0;
  }

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('infoschema'));

    // Decoy schema (not on the search path) already holds everything.
    await pool.query('CREATE SCHEMA decoy');
    await pool.query('CREATE TABLE decoy.nodes (id INT PRIMARY KEY, "lastMeshReceivedKey" TEXT)');
    await pool.query('CREATE TABLE decoy.user_map_preferences (id INT PRIMARY KEY, "selectedLayer" TEXT)');
    await pool.query('CREATE TABLE decoy.auto_traceroute_nodes ("nodeNum" BIGINT, "sourceId" TEXT)');
    await pool.query(
      `ALTER TABLE decoy.auto_traceroute_nodes
         ADD CONSTRAINT auto_traceroute_nodes_nodenum_sourceid_uniq UNIQUE ("nodeNum", "sourceId")`,
    );

    // Target (public) schema: tables exist, the migrated bits do not.
    await pool.query('CREATE TABLE nodes (id INT PRIMARY KEY)');
    await pool.query('CREATE TABLE user_map_preferences (id INT PRIMARY KEY)');
    await pool.query('CREATE TABLE auto_traceroute_nodes ("nodeNum" BIGINT)');
    await pool.query('CREATE TABLE auto_traceroute_log (id INT PRIMARY KEY)');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  async function withClient(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
    const client = await pool.connect();
    try {
      await fn(client);
    } finally {
      client.release();
    }
  }

  it('migration 084 (008) adds nodes.lastMeshReceivedKey despite the decoy schema', async () => {
    await withClient((c) => runMigration084Postgres(c));
    expect(await pgColumnExists('nodes', 'lastMeshReceivedKey')).toBe(true);
    await withClient((c) => runMigration084Postgres(c));
  });

  it('migration 047 adds user_map_preferences.selectedLayer despite the decoy schema', async () => {
    await withClient((c) => runMigration047Postgres(c));
    expect(await pgColumnExists('user_map_preferences', 'selectedLayer')).toBe(true);
    await withClient((c) => runMigration047Postgres(c));
  });

  it('migration 024 adds its unique constraint despite a same-named one in the decoy schema', async () => {
    await withClient((c) => runMigration024Postgres(c));
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_constraint
       WHERE conname = 'auto_traceroute_nodes_nodenum_sourceid_uniq'
         AND conrelid = 'public.auto_traceroute_nodes'::regclass`,
    );
    expect(rows).toHaveLength(1);
    await withClient((c) => runMigration024Postgres(c));
  });
});
