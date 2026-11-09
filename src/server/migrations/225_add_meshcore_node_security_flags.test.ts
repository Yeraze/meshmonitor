/**
 * Migration 225 (#6281): meshcore_nodes security flag columns, on SQLite,
 * PostgreSQL and MySQL. PG/MySQL blocks use isolated databases.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { migration, runMigration225Postgres, runMigration225Mysql } from './225_add_meshcore_node_security_flags.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const COLS = [
  'isExcessivePackets',
  'packetRatePerHour',
  'advertRatePerHour',
  'packetRateLastChecked',
  'isTimeOffsetIssue',
  'timeOffsetSeconds',
  'timeOffsetSource',
  'timeOffsetCheckedAt',
];

describe('Migration 225 — SQLite', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE meshcore_nodes (sourceId TEXT, publicKey TEXT, name TEXT)`);
    db.exec(`INSERT INTO meshcore_nodes VALUES ('src-1', 'aa', 'n')`);
  });

  it('adds the columns; flags default false, the rest null; existing data kept', () => {
    migration.up(db);
    const row = db.prepare(`SELECT * FROM meshcore_nodes`).get() as Record<string, unknown>;
    expect(row.name).toBe('n');
    expect(row.isExcessivePackets).toBe(0);
    expect(row.isTimeOffsetIssue).toBe(0);
    for (const c of COLS.filter((c) => !c.startsWith('is'))) expect(row[c]).toBeNull();
  });

  it('is idempotent', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = (db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as Array<{ name: string }>).filter((c) =>
      COLS.includes(c.name),
    );
    expect(cols).toHaveLength(COLS.length);
  });
});

describe.skipIf(!postgresAvailable)('Migration 225 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig225'));
    await pool.query(`CREATE TABLE meshcore_nodes ("sourceId" TEXT, "publicKey" TEXT, name TEXT)`);
    await pool.query(`INSERT INTO meshcore_nodes VALUES ('src-1', 'aa', 'n')`);
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the columns and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration225Postgres(client);
      await expect(runMigration225Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows } = await pool.query(`SELECT * FROM meshcore_nodes`);
    expect(rows[0].isExcessivePackets).toBe(false);
    expect(rows[0].isTimeOffsetIssue).toBe(false);
    expect(rows[0].timeOffsetSeconds).toBeNull();
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='meshcore_nodes' AND column_name = ANY($1)`,
      [COLS],
    );
    expect(cols.rowCount).toBe(COLS.length);
  });
});

describe.skipIf(!mysqlAvailable)('Migration 225 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig225'));
    await pool.query(`CREATE TABLE meshcore_nodes (sourceId VARCHAR(64), publicKey VARCHAR(64), name VARCHAR(64))`);
    await pool.query(`INSERT INTO meshcore_nodes VALUES ('src-1', 'aa', 'n')`);
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the columns and is idempotent', async () => {
    await runMigration225Mysql(pool);
    await expect(runMigration225Mysql(pool)).resolves.toBeUndefined();
    const [rows] = await pool.query(`SELECT * FROM meshcore_nodes`);
    const r = (rows as Array<Record<string, unknown>>)[0];
    expect(Number(r.isExcessivePackets)).toBe(0);
    expect(Number(r.isTimeOffsetIssue)).toBe(0);
    expect(r.timeOffsetSource).toBeNull();
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='meshcore_nodes' AND COLUMN_NAME IN (${COLS.map((c) => `'${c}'`).join(',')})`,
    );
    expect((cols as unknown[]).length).toBe(COLS.length);
  });
});
