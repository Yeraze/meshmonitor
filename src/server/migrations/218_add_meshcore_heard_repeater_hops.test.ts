/**
 * Migration 218 — meshcore_heard_repeaters.hops (#6000).
 *
 * SQLite always runs. The PostgreSQL / MySQL blocks skip silently when the
 * containers (localhost:5433 / :3307) are down; each owns an isolated database.
 * A minimal `meshcore_heard_repeaters` table stands in for the real one: the
 * migration only adds a column.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { migration, runMigration218Postgres, runMigration218Mysql } from './218_add_meshcore_heard_repeater_hops.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe('Migration 218 — SQLite', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE meshcore_heard_repeaters (sourceId TEXT, messageId TEXT, repeaterHash TEXT, snr REAL)`);
    db.exec(`INSERT INTO meshcore_heard_repeaters VALUES ('src-1', 'm1', 'aa', 4)`);
  });

  it('adds a nullable column and leaves existing rows null', () => {
    migration.up(db);
    const row = db.prepare(`SELECT * FROM meshcore_heard_repeaters`).get() as any;
    expect(row.hops).toBeNull();
    expect(row.snr).toBe(4);
  });

  it('is idempotent', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = (db.prepare(`PRAGMA table_info(meshcore_heard_repeaters)`).all() as any[]).filter(
      (c) => c.name === 'hops',
    );
    expect(cols).toHaveLength(1);
  });
});

describe.skipIf(!postgresAvailable)('Migration 218 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig218'));
    await pool.query(
      `CREATE TABLE IF NOT EXISTS meshcore_heard_repeaters ("sourceId" TEXT, "messageId" TEXT, "repeaterHash" TEXT, snr REAL)`,
    );
    await pool.query(`INSERT INTO meshcore_heard_repeaters VALUES ('src-a', 'm1', 'aa', 4)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the column, is idempotent, and leaves existing rows null', async () => {
    const client = await pool.connect();
    try {
      await runMigration218Postgres(client);
      await expect(runMigration218Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows } = await pool.query(`SELECT * FROM meshcore_heard_repeaters`);
    expect(rows[0].hops).toBeNull();
    await pool.query(`UPDATE meshcore_heard_repeaters SET hops = 2`);
    const { rows: after } = await pool.query(`SELECT hops FROM meshcore_heard_repeaters`);
    expect(after[0].hops).toBe(2);
  });
});

describe.skipIf(!mysqlAvailable)('Migration 218 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig218'));
    await pool.query(
      `CREATE TABLE IF NOT EXISTS meshcore_heard_repeaters (sourceId VARCHAR(64), messageId VARCHAR(64), repeaterHash VARCHAR(16), snr DOUBLE)`,
    );
    await pool.query(`INSERT INTO meshcore_heard_repeaters VALUES ('src-a', 'm1', 'aa', 4)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the column, is idempotent, and leaves existing rows null', async () => {
    await runMigration218Mysql(pool);
    await expect(runMigration218Mysql(pool)).resolves.toBeUndefined();
    const [rows] = await pool.query(`SELECT * FROM meshcore_heard_repeaters`);
    expect((rows as any[])[0].hops).toBeNull();
    await pool.query(`UPDATE meshcore_heard_repeaters SET hops = 2`);
    const [after] = await pool.query(`SELECT hops FROM meshcore_heard_repeaters`);
    expect(Number((after as any[])[0].hops)).toBe(2);
  });
});
