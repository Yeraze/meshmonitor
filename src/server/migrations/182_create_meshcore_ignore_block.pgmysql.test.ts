/**
 * Migration 182 — PostgreSQL / MySQL container behaviour (#5408).
 *
 * Skips silently when the containers (localhost:5433 / :3307) are down —
 * confirm coverage via `numPendingTests` in the JSON reporter. Each backend
 * runs in its own isolated database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration182Postgres, runMigration182Mysql } from './182_create_meshcore_ignore_block.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const KEY = 'ab'.repeat(32);

describe.skipIf(!postgresAvailable)('migration 182 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig182'));
    await pool.query('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY)');
    await pool.query(`INSERT INTO sources (id) VALUES ('src-a'), ('src-b') ON CONFLICT DO NOTHING`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the tables, is idempotent, applies defaults, and cascades a source delete', async () => {
    const client = await pool.connect();
    try {
      await runMigration182Postgres(client);
      await expect(runMigration182Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const insert = `INSERT INTO meshcore_ignored_nodes ("sourceId", "publicKey", "createdAt") VALUES ($1, $2, $3)`;
    await pool.query(insert, ['src-a', KEY, Date.now()]);
    await pool.query(insert, ['src-b', KEY, Date.now()]);
    await expect(pool.query(insert, ['src-a', KEY, Date.now()])).rejects.toThrow();
    await pool.query(
      `INSERT INTO meshcore_message_filters (id, "sourceId", "matchType", pattern, "createdAt") VALUES ('r1', 'src-a', 'exact', 'x', $1)`,
      [Date.now()],
    );
    const { rows } = await pool.query(`SELECT * FROM meshcore_message_filters WHERE id = 'r1'`);
    expect(rows[0]).toMatchObject({ mode: 'ignore', fields: 'both', caseSensitive: false, enabled: true, hitCount: 0 });

    await pool.query(`DELETE FROM sources WHERE id = 'src-a'`);
    const n = await pool.query(`SELECT COUNT(*)::int AS c FROM meshcore_ignored_nodes`);
    expect(n.rows[0].c).toBe(1);
    const f = await pool.query(`SELECT COUNT(*)::int AS c FROM meshcore_message_filters`);
    expect(f.rows[0].c).toBe(0);
  });
});

describe.skipIf(!mysqlAvailable)('migration 182 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig182'));
    await pool.query('CREATE TABLE IF NOT EXISTS sources (id VARCHAR(36) PRIMARY KEY)');
    await pool.query(`INSERT IGNORE INTO sources (id) VALUES ('src-a'), ('src-b')`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the tables, is idempotent, applies defaults, and cascades a source delete', async () => {
    await runMigration182Mysql(pool);
    await expect(runMigration182Mysql(pool)).resolves.toBeUndefined();
    const insert = `INSERT INTO meshcore_ignored_nodes (sourceId, publicKey, createdAt) VALUES (?, ?, ?)`;
    await pool.query(insert, ['src-a', KEY, Date.now()]);
    await pool.query(insert, ['src-b', KEY, Date.now()]);
    await expect(pool.query(insert, ['src-a', KEY, Date.now()])).rejects.toThrow();
    await pool.query(
      `INSERT INTO meshcore_message_filters (id, sourceId, matchType, pattern, createdAt) VALUES ('r1', 'src-a', 'exact', 'x', ?)`,
      [Date.now()],
    );
    const [rows] = await pool.query(`SELECT * FROM meshcore_message_filters WHERE id = 'r1'`);
    const r = (rows as any[])[0];
    expect(r.mode).toBe('ignore');
    expect(r.fields).toBe('both');
    expect(Number(r.caseSensitive)).toBe(0);
    expect(Number(r.enabled)).toBe(1);

    await pool.query(`DELETE FROM sources WHERE id = 'src-a'`);
    const [n] = await pool.query(`SELECT COUNT(*) AS c FROM meshcore_ignored_nodes`);
    expect(Number((n as any[])[0].c)).toBe(1);
    const [f] = await pool.query(`SELECT COUNT(*) AS c FROM meshcore_message_filters`);
    expect(Number((f as any[])[0].c)).toBe(0);
  });
});
