/**
 * Migration 248 (#5891): Walkabout Coverage tables on SQLite, PostgreSQL and
 * MySQL. PG/MySQL blocks use isolated databases and skip when no container
 * listens, so confirm coverage via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { migration, runMigration248Postgres, runMigration248Mysql } from './248_create_coverage_walkabout.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const TABLES = ['coverage_walkabout_sessions', 'coverage_walkabout_samples', 'coverage_walkabout_receptions'];
const INDEXES = [
  'cov_wk_sess_source_started_idx', 'cov_wk_sess_ended_idx',
  'cov_wk_smp_session_fix_idx', 'cov_wk_smp_source_idx',
  'cov_wk_rx_uniq', 'cov_wk_rx_session_heard_idx', 'cov_wk_rx_source_idx',
];

describe('Migration 248 — SQLite', () => {
  it('creates tables and indexes, keeps rows on re-run', () => {
    const db = new Database(':memory:');
    migration.up(db);
    db.exec(`INSERT INTO coverage_walkabout_sessions (id, sourceId, startedAt, createdAt, updatedAt) VALUES ('s1','src',1,1,1)`);
    migration.up(db);
    const names = (t: string) =>
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(t) as Array<{ name: string }>).map((r) => r.name);
    expect(names('table')).toEqual(expect.arrayContaining(TABLES));
    expect(names('index')).toEqual(expect.arrayContaining(INDEXES));
    expect((db.prepare(`SELECT COUNT(*) AS n FROM coverage_walkabout_sessions`).get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe.skipIf(!postgresAvailable)('Migration 248 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig248'));
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('creates tables and indexes and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration248Postgres(client);
      await pool.query(`INSERT INTO coverage_walkabout_sessions ("id","sourceId","startedAt","createdAt","updatedAt") VALUES ('s1','src',1,1,1)`);
      await runMigration248Postgres(client);
    } finally {
      client.release();
    }
    const t = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`);
    expect(t.rows.map((r) => r.tablename)).toEqual(expect.arrayContaining(TABLES));
    const i = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`);
    expect(i.rows.map((r) => r.indexname)).toEqual(expect.arrayContaining(INDEXES));
    const n = await pool.query(`SELECT COUNT(*)::int AS n FROM coverage_walkabout_sessions`);
    expect(n.rows[0].n).toBe(1);
  });
});

describe.skipIf(!mysqlAvailable)('Migration 248 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig248'));
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('creates tables and indexes and is idempotent', async () => {
    await runMigration248Mysql(pool);
    await pool.query(`INSERT INTO coverage_walkabout_sessions (id, sourceId, startedAt, createdAt, updatedAt) VALUES ('s1','src',1,1,1)`);
    await runMigration248Mysql(pool);
    const [t] = await pool.query(`SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`);
    expect((t as Array<{ n: string }>).map((r) => r.n)).toEqual(expect.arrayContaining(TABLES));
    const [i] = await pool.query(`SELECT DISTINCT INDEX_NAME AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()`);
    expect((i as Array<{ n: string }>).map((r) => r.n)).toEqual(expect.arrayContaining(INDEXES));
    const [c] = await pool.query(`SELECT COUNT(*) AS n FROM coverage_walkabout_sessions`);
    expect(Number((c as Array<{ n: unknown }>)[0].n)).toBe(1);
  });
});
