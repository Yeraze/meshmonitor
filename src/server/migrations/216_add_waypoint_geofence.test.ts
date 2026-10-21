/**
 * Migration 216 — waypoint geofence columns (#5922).
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
import { migration, runMigration216Postgres, runMigration216Mysql } from './216_add_waypoint_geofence.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const COLUMNS = [
  'geofence_radius_m', 'bbox_west', 'bbox_south', 'bbox_east', 'bbox_north',
  'notify_on_enter', 'notify_on_exit', 'notify_favorites_only',
];

function sqliteColumns(db: Database.Database): string[] {
  return (db.prepare(`PRAGMA table_info(waypoints)`).all() as any[]).map((c) => c.name);
}

describe('Migration 216 — SQLite', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE sources (id TEXT PRIMARY KEY)`);
    db.exec(`INSERT INTO sources (id) VALUES ('src-1')`);
    createWaypoints.up(db);
  });

  it('adds the columns and gives existing rows no geofence', () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO waypoints (source_id, waypoint_id, latitude, longitude, first_seen_at, last_updated_at)
      VALUES ('src-1', 1, 30, -90, ?, ?)
    `).run(now, now);

    migration.up(db);

    expect(sqliteColumns(db)).toEqual(expect.arrayContaining(COLUMNS));
    const row = db.prepare(`SELECT * FROM waypoints WHERE waypoint_id = 1`).get() as any;
    expect(row.geofence_radius_m).toBeNull();
    expect(row.bbox_west).toBeNull();
    expect(row.notify_on_enter).toBe(0);
    expect(row.notify_on_exit).toBe(0);
    expect(row.notify_favorites_only).toBe(0);
  });

  it('is idempotent', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    for (const c of COLUMNS) expect(sqliteColumns(db).filter((x) => x === c)).toHaveLength(1);
  });
});

describe.skipIf(!postgresAvailable)('Migration 216 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig216'));
    await pool.query('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY)');
    await pool.query(`INSERT INTO sources (id) VALUES ('src-a') ON CONFLICT DO NOTHING`);
    const client = await pool.connect();
    try {
      await runMigration053Postgres(client);
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
      await runMigration216Postgres(client);
      await expect(runMigration216Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    await pool.query(
      `INSERT INTO waypoints (source_id, waypoint_id, latitude, longitude, geofence_radius_m, bbox_west, bbox_south, bbox_east, bbox_north, notify_on_enter, first_seen_at, last_updated_at)
       VALUES ('src-a', 7, 30, -90, 500, -90.1, 29.9, -89.9, 30.1, 1, $1, $1)`,
      [Date.now()],
    );
    const { rows } = await pool.query(`SELECT * FROM waypoints WHERE waypoint_id = 7`);
    expect(rows[0]).toMatchObject({ geofence_radius_m: 500, bbox_west: -90.1, bbox_north: 30.1, notify_on_enter: 1, notify_on_exit: 0 });
  });
});

describe.skipIf(!mysqlAvailable)('Migration 216 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig216'));
    await pool.query('CREATE TABLE IF NOT EXISTS sources (id VARCHAR(36) PRIMARY KEY)');
    await pool.query(`INSERT IGNORE INTO sources (id) VALUES ('src-a')`);
    await runMigration053Mysql(pool);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds the columns, is idempotent, and stores values', async () => {
    await runMigration216Mysql(pool);
    await expect(runMigration216Mysql(pool)).resolves.toBeUndefined();
    await pool.query(
      `INSERT INTO waypoints (source_id, waypoint_id, latitude, longitude, description, geofence_radius_m, bbox_west, bbox_south, bbox_east, bbox_north, notify_on_exit, first_seen_at, last_updated_at)
       VALUES ('src-a', 7, 30, -90, '', 500, -90.1, 29.9, -89.9, 30.1, 1, ?, ?)`,
      [Date.now(), Date.now()],
    );
    const [rows] = await pool.query(`SELECT * FROM waypoints WHERE waypoint_id = 7`);
    expect((rows as any[])[0]).toMatchObject({ geofence_radius_m: 500, bbox_west: -90.1, notify_on_enter: 0, notify_on_exit: 1 });
  });
});
