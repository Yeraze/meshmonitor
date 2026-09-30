/**
 * Migration 183 — `waypoints.hop_limit` + `waypoints.automation_key` (#5482).
 *
 * SQLite always runs. The PostgreSQL / MySQL blocks skip silently when the
 * containers (localhost:5433 / :3307) are down; each owns an isolated database.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import pg from 'pg';
import mysql from 'mysql2/promise';
import {
  migration as createWaypoints,
  runMigration053Postgres,
  runMigration053Mysql,
} from './053_create_waypoints.js';
import { migration as addChannel, runMigration130Postgres, runMigration130Mysql } from './130_add_waypoint_channel.js';
import { migration, runMigration183Postgres, runMigration183Mysql } from './183_add_waypoint_hop_limit_automation_key.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

function sqliteColumns(db: Database.Database): string[] {
  return (db.prepare(`PRAGMA table_info(waypoints)`).all() as any[]).map((c) => c.name);
}

describe('Migration 183 — SQLite', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE sources (id TEXT PRIMARY KEY)`);
    db.exec(`INSERT INTO sources (id) VALUES ('src-1')`);
    createWaypoints.up(db);
    addChannel.up(db);
  });

  it('adds both columns and leaves existing rows on NULL (inherit)', () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO waypoints (source_id, waypoint_id, latitude, longitude, first_seen_at, last_updated_at)
      VALUES ('src-1', 1, 30, -90, ?, ?)
    `).run(now, now);
    expect(sqliteColumns(db)).not.toContain('hop_limit');

    migration.up(db);

    expect(sqliteColumns(db)).toEqual(expect.arrayContaining(['hop_limit', 'automation_key', 'broadcast_fingerprint']));
    const row = db.prepare(`SELECT hop_limit, automation_key FROM waypoints WHERE waypoint_id = 1`).get() as any;
    expect(row.hop_limit).toBeNull();
    expect(row.automation_key).toBeNull();
  });

  it('is idempotent', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    expect(sqliteColumns(db).filter((c) => c === 'hop_limit')).toHaveLength(1);
    expect(sqliteColumns(db).filter((c) => c === 'automation_key')).toHaveLength(1);
  });
});

describe.skipIf(!postgresAvailable)('Migration 183 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig183'));
    await pool.query('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY)');
    await pool.query(`INSERT INTO sources (id) VALUES ('src-a') ON CONFLICT DO NOTHING`);
    const client = await pool.connect();
    try {
      await runMigration053Postgres(client);
      await runMigration130Postgres(client);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the columns, is idempotent, and stores values', async () => {
    const client = await pool.connect();
    try {
      await runMigration183Postgres(client);
      await expect(runMigration183Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    await pool.query(
      `INSERT INTO waypoints (source_id, waypoint_id, latitude, longitude, hop_limit, automation_key, broadcast_fingerprint, first_seen_at, last_updated_at)
       VALUES ('src-a', 7, 30, -90, 2, 'auto-1:border', 'abc', $1, $1)`,
      [Date.now()],
    );
    const { rows } = await pool.query(`SELECT hop_limit, automation_key, broadcast_fingerprint FROM waypoints WHERE waypoint_id = 7`);
    expect(rows[0]).toMatchObject({ hop_limit: 2, automation_key: 'auto-1:border', broadcast_fingerprint: 'abc' });
  });
});

describe.skipIf(!mysqlAvailable)('Migration 183 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig183'));
    await pool.query('CREATE TABLE IF NOT EXISTS sources (id VARCHAR(36) PRIMARY KEY)');
    await pool.query(`INSERT IGNORE INTO sources (id) VALUES ('src-a')`);
    await runMigration053Mysql(pool);
    await runMigration130Mysql(pool);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the columns, is idempotent, and stores values', async () => {
    await runMigration183Mysql(pool);
    await expect(runMigration183Mysql(pool)).resolves.toBeUndefined();
    await pool.query(
      `INSERT INTO waypoints (source_id, waypoint_id, latitude, longitude, description, hop_limit, automation_key, broadcast_fingerprint, first_seen_at, last_updated_at)
       VALUES ('src-a', 7, 30, -90, '', 0, 'auto-1:border', 'abc', ?, ?)`,
      [Date.now(), Date.now()],
    );
    const [rows] = await pool.query(`SELECT hop_limit, automation_key, broadcast_fingerprint FROM waypoints WHERE waypoint_id = 7`);
    expect((rows as any[])[0]).toMatchObject({ hop_limit: 0, automation_key: 'auto-1:border', broadcast_fingerprint: 'abc' });
  });
});
