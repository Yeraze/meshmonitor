/**
 * Migration 217 — nodes.channelLocked (#5923).
 *
 * SQLite always runs. The PostgreSQL / MySQL blocks skip silently when the
 * containers (localhost:5433 / :3307) are down; each owns an isolated database.
 * A minimal `nodes` table stands in for the real one: the migration only adds
 * a column.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { migration, runMigration217Postgres, runMigration217Mysql } from './217_add_node_channel_locked.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe('Migration 217 — SQLite', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE nodes (nodeNum INTEGER, sourceId TEXT, channel INTEGER)`);
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, channel) VALUES (1, 'src-1', 2)`);
  });

  it('adds the column and leaves existing rows unlocked', () => {
    migration.up(db);
    const row = db.prepare(`SELECT * FROM nodes WHERE nodeNum = 1`).get() as any;
    expect(row.channelLocked).toBe(0);
    expect(row.channel).toBe(2);
  });

  it('is idempotent', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = (db.prepare(`PRAGMA table_info(nodes)`).all() as any[]).filter((c) => c.name === 'channelLocked');
    expect(cols).toHaveLength(1);
  });
});

describe.skipIf(!postgresAvailable)('Migration 217 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig217'));
    await pool.query(`CREATE TABLE IF NOT EXISTS nodes ("nodeNum" BIGINT, "sourceId" TEXT, channel INTEGER)`);
    await pool.query(`INSERT INTO nodes ("nodeNum", "sourceId", channel) VALUES (1, 'src-a', 2)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the column, is idempotent, and leaves existing rows unlocked', async () => {
    const client = await pool.connect();
    try {
      await runMigration217Postgres(client);
      await expect(runMigration217Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows } = await pool.query(`SELECT * FROM nodes WHERE "nodeNum" = 1`);
    expect(rows[0].channelLocked).toBe(false);
  });
});

describe.skipIf(!mysqlAvailable)('Migration 217 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig217'));
    await pool.query(`CREATE TABLE IF NOT EXISTS nodes (nodeNum BIGINT, sourceId VARCHAR(36), channel INT)`);
    await pool.query(`INSERT INTO nodes (nodeNum, sourceId, channel) VALUES (1, 'src-a', 2)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the column, is idempotent, and leaves existing rows unlocked', async () => {
    await runMigration217Mysql(pool);
    await expect(runMigration217Mysql(pool)).resolves.toBeUndefined();
    const [rows] = await pool.query(`SELECT * FROM nodes WHERE nodeNum = 1`);
    expect(Number((rows as any[])[0].channelLocked)).toBe(0);
  });
});
