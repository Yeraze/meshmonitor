/**
 * Migration 250 (#6573): `coverage_walkabout_sessions.importId` on SQLite,
 * PostgreSQL and MySQL. PG/MySQL blocks use isolated databases and skip when
 * no container listens. Each backend creates the walkabout tables (248) first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { migration as migration248, runMigration248Postgres, runMigration248Mysql } from './248_create_coverage_walkabout.js';
import { migration, runMigration250Postgres, runMigration250Mysql } from './250_add_walkabout_session_import_id.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const INSERT = `INSERT INTO coverage_walkabout_sessions (id, sourceId, startedAt, createdAt, updatedAt) VALUES ('s1','src',1,1,1)`;

describe('Migration 250 — SQLite', () => {
  it('adds the column and partial index; re-run keeps rows', () => {
    const db = new Database(':memory:');
    migration248.up(db);
    db.exec(INSERT);
    migration.up(db);
    db.exec(`UPDATE coverage_walkabout_sessions SET importId = 'i1'`);
    migration.up(db);
    const cols = (db.prepare(`PRAGMA table_info(coverage_walkabout_sessions)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('importId');
    const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'cov_wk_sess_import_idx'`).get() as { sql: string };
    expect(idx.sql).toMatch(/WHERE importId IS NOT NULL/);
    expect((db.prepare(`SELECT importId FROM coverage_walkabout_sessions`).get() as { importId: string }).importId).toBe('i1');
  });
});

describe.skipIf(!postgresAvailable)('Migration 250 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig250'));
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the column and index and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration248Postgres(client);
      await runMigration250Postgres(client);
      await runMigration250Postgres(client);
    } finally {
      client.release();
    }
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'coverage_walkabout_sessions' AND column_name = 'importId'`,
    );
    expect(cols.rows).toHaveLength(1);
    const i = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'cov_wk_sess_import_idx'`);
    expect(i.rows).toHaveLength(1);
  });
});

describe.skipIf(!mysqlAvailable)('Migration 250 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig250'));
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the column and index and is idempotent', async () => {
    await runMigration248Mysql(pool);
    await runMigration250Mysql(pool);
    await runMigration250Mysql(pool);
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coverage_walkabout_sessions' AND COLUMN_NAME = 'importId'`,
    );
    expect(cols as unknown[]).toHaveLength(1);
    const [idx] = await pool.query(
      `SELECT INDEX_NAME AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coverage_walkabout_sessions' AND INDEX_NAME = 'cov_wk_sess_import_idx'`,
    );
    expect((idx as unknown[]).length).toBeGreaterThan(0);
  });
});
