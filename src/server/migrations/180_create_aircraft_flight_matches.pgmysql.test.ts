/**
 * Migration 180 — PostgreSQL / MySQL container behaviour (#5374).
 *
 * Skips silently when the containers (localhost:5433 / :3307) are down —
 * confirm coverage via `numPendingTests` in the JSON reporter. Each backend
 * runs in its own isolated database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration180Postgres, runMigration180Mysql } from './180_create_aircraft_flight_matches.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 180 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig180'));
    await pool.query('DROP TABLE IF EXISTS aircraft_flight_matches CASCADE');
    await pool.query('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY)');
    await pool.query(`INSERT INTO sources (id) VALUES ('src-a'), ('src-b') ON CONFLICT DO NOTHING`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table, is idempotent, keeps unsigned nodeNums, and cascades a source delete', async () => {
    const client = await pool.connect();
    try {
      await runMigration180Postgres(client);
      await expect(runMigration180Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    const insert = `INSERT INTO aircraft_flight_matches ("sourceId", "nodeNum", "episodeStartedAt") VALUES ($1, $2, $3)`;
    await pool.query(insert, ['src-a', 4294967295, Date.now()]);
    await pool.query(insert, ['src-b', 4294967295, Date.now()]);
    await expect(pool.query(insert, ['src-a', 4294967295, Date.now()])).rejects.toThrow();

    const { rows } = await pool.query(`SELECT * FROM aircraft_flight_matches WHERE "sourceId" = 'src-a'`);
    expect(Number(rows[0].nodeNum)).toBe(4294967295);
    expect(rows[0].lookups).toBe(0);
    expect(rows[0].status).toBe('none');

    await pool.query(`DELETE FROM sources WHERE id = 'src-a'`);
    const after = await pool.query(`SELECT COUNT(*)::int AS c FROM aircraft_flight_matches`);
    expect(after.rows[0].c).toBe(1);
  });
});

describe.skipIf(!mysqlAvailable)('migration 180 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig180'));
    await pool.query('DROP TABLE IF EXISTS aircraft_flight_matches');
    await pool.query('CREATE TABLE IF NOT EXISTS sources (id VARCHAR(36) PRIMARY KEY)');
    await pool.query(`INSERT IGNORE INTO sources (id) VALUES ('src-a'), ('src-b')`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table, is idempotent, keeps unsigned nodeNums, and cascades a source delete', async () => {
    await runMigration180Mysql(pool);
    await expect(runMigration180Mysql(pool)).resolves.toBeUndefined();

    const insert = `INSERT INTO aircraft_flight_matches (sourceId, nodeNum, episodeStartedAt) VALUES (?, ?, ?)`;
    await pool.query(insert, ['src-a', 4294967295, Date.now()]);
    await pool.query(insert, ['src-b', 4294967295, Date.now()]);
    await expect(pool.query(insert, ['src-a', 4294967295, Date.now()])).rejects.toThrow();

    const [rows] = await pool.query(`SELECT * FROM aircraft_flight_matches WHERE sourceId = 'src-a'`);
    const r = (rows as any[])[0];
    expect(Number(r.nodeNum)).toBe(4294967295);
    expect(r.lookups).toBe(0);
    expect(r.status).toBe('none');

    await pool.query(`DELETE FROM sources WHERE id = 'src-a'`);
    const [after] = await pool.query(`SELECT COUNT(*) AS c FROM aircraft_flight_matches`);
    expect(Number((after as any[])[0].c)).toBe(1);
  });
});
