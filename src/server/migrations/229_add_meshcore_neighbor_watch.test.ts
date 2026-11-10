/**
 * Migration 229 (#6274): meshcore_neighbor_watch table and
 * meshcore_nodes.neighborWatchBaselinedAt, on SQLite, PostgreSQL and MySQL.
 * PG/MySQL blocks use isolated databases.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { migration, runMigration229Postgres, runMigration229Mysql } from './229_add_meshcore_neighbor_watch.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe('Migration 229 — SQLite', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE meshcore_nodes (sourceId TEXT, publicKey TEXT, name TEXT)`);
    db.exec(`INSERT INTO meshcore_nodes VALUES ('src-1', 'aa', 'n')`);
  });

  it('creates the table, the unique index and the nullable column; data kept', () => {
    migration.up(db);
    const row = db.prepare(`SELECT * FROM meshcore_nodes`).get() as Record<string, unknown>;
    expect(row.name).toBe('n');
    expect(row.neighborWatchBaselinedAt).toBeNull();
    const ins = db.prepare(
      `INSERT INTO meshcore_neighbor_watch (sourceId, reporterPublicKey, neighborPublicKey, state, firstSeenAt, lastHeardAt, updatedAt)
       VALUES ('s','r','n','pending',1,2,3)`,
    );
    ins.run();
    expect(() => ins.run()).toThrow(/UNIQUE/);
    const stored = db.prepare(`SELECT sightings, lastSnr FROM meshcore_neighbor_watch`).get() as Record<string, unknown>;
    expect(stored).toEqual({ sightings: 0, lastSnr: null });
  });

  it('is idempotent', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = (db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as Array<{ name: string }>).filter(
      (c) => c.name === 'neighborWatchBaselinedAt',
    );
    expect(cols).toHaveLength(1);
  });
});

describe.skipIf(!postgresAvailable)('Migration 229 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig229'));
    await pool.query(`CREATE TABLE meshcore_nodes ("sourceId" TEXT, "publicKey" TEXT, name TEXT)`);
    await pool.query(`INSERT INTO meshcore_nodes VALUES ('src-1', 'aa', 'n')`);
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table and column, enforces the unique key, and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration229Postgres(client);
      await runMigration229Postgres(client);
    } finally {
      client.release();
    }
    expect((await pool.query(`SELECT "neighborWatchBaselinedAt" AS v FROM meshcore_nodes`)).rows[0].v).toBeNull();
    const ins = `INSERT INTO meshcore_neighbor_watch ("sourceId","reporterPublicKey","neighborPublicKey",state,"firstSeenAt","lastHeardAt","updatedAt")
       VALUES ('s','r','n','pending',1700000000000,1700000000000,1700000000000)`;
    await pool.query(ins);
    await expect(pool.query(ins)).rejects.toThrow(/duplicate key/);
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='meshcore_nodes' AND column_name='neighborWatchBaselinedAt'`,
    );
    expect(cols.rowCount).toBe(1);
  });
});

describe.skipIf(!mysqlAvailable)('Migration 229 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig229'));
    await pool.query(`CREATE TABLE meshcore_nodes (sourceId VARCHAR(64), publicKey VARCHAR(64), name VARCHAR(64))`);
    await pool.query(`INSERT INTO meshcore_nodes VALUES ('src-1', 'aa', 'n')`);
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table and column, enforces the unique key, and is idempotent', async () => {
    await runMigration229Mysql(pool);
    await runMigration229Mysql(pool);
    const [nodes] = await pool.query(`SELECT neighborWatchBaselinedAt AS v FROM meshcore_nodes`);
    expect((nodes as Array<{ v: unknown }>)[0].v).toBeNull();
    const ins = `INSERT INTO meshcore_neighbor_watch (sourceId,reporterPublicKey,neighborPublicKey,state,firstSeenAt,lastHeardAt,updatedAt)
       VALUES ('s','r','n','pending',1700000000000,1700000000000,1700000000000)`;
    await pool.query(ins);
    await expect(pool.query(ins)).rejects.toThrow(/Duplicate entry/);
  });
});
