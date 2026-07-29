/**
 * Migration 130 — add `waypoints.channel` (#4341).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration as createWaypoints } from './053_create_waypoints.js';
import { migration } from './130_add_waypoint_channel.js';

function createSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      createdBy INTEGER
    );
  `);
  createWaypoints.up(db);
  const ts = Date.now();
  db.prepare(`
    INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
    VALUES ('src-1', 'Source 1', 'meshtastic_tcp', '{}', 1, ?, ?)
  `).run(ts, ts);
}

function columns(db: Database.Database): string[] {
  return (db.prepare(`PRAGMA table_info(waypoints)`).all() as any[]).map((c) => c.name);
}

describe('Migration 130 — add waypoints.channel', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  it('adds the channel column', () => {
    expect(columns(db)).not.toContain('channel');
    migration.up(db);
    expect(columns(db)).toContain('channel');
  });

  it('leaves pre-existing rows on NULL, which readers treat as slot 0', () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO waypoints (source_id, waypoint_id, latitude, longitude, first_seen_at, last_updated_at)
      VALUES ('src-1', 1, 30, -90, ?, ?)
    `).run(now, now);

    migration.up(db);

    const row = db.prepare(`SELECT channel FROM waypoints WHERE waypoint_id = 1`).get() as any;
    expect(row.channel).toBeNull();
  });

  it('stores a chosen slot', () => {
    migration.up(db);
    const now = Date.now();
    db.prepare(`
      INSERT INTO waypoints (source_id, waypoint_id, latitude, longitude, channel, first_seen_at, last_updated_at)
      VALUES ('src-1', 2, 30, -90, 3, ?, ?)
    `).run(now, now);

    const row = db.prepare(`SELECT channel FROM waypoints WHERE waypoint_id = 2`).get() as any;
    expect(row.channel).toBe(3);
  });

  it('is idempotent', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    expect(columns(db).filter((c) => c === 'channel')).toHaveLength(1);
  });
});
