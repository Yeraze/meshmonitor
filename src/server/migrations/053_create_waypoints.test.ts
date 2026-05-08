/**
 * Migration 053 — Create waypoints table.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './053_create_waypoints.js';

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
}

function insertSource(db: Database.Database, id: string) {
  const ts = Date.now();
  db.prepare(`
    INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
    VALUES (?, ?, 'meshtastic_tcp', '{}', 1, ?, ?)
  `).run(id, `Source ${id}`, ts, ts);
}

describe('Migration 053 — create waypoints', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  it('creates the waypoints table with composite PK', () => {
    migration.up(db);
    const tableInfo = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='waypoints'`)
      .get();
    expect(tableInfo).toBeDefined();
  });

  it('rejects rows with missing required columns', () => {
    migration.up(db);
    insertSource(db, 'src-1');
    expect(() => {
      db.prepare(`
        INSERT INTO waypoints (source_id, waypoint_id, first_seen_at, last_updated_at)
        VALUES ('src-1', 1, ?, ?)
      `).run(Date.now(), Date.now());
    }).toThrow(); // missing latitude/longitude (NOT NULL)
  });

  it('inserts and retrieves waypoint rows', () => {
    migration.up(db);
    insertSource(db, 'src-1');
    const now = Date.now();
    db.prepare(`
      INSERT INTO waypoints (
        source_id, waypoint_id, owner_node_num, latitude, longitude,
        expire_at, locked_to, name, description, icon_codepoint, icon_emoji,
        is_virtual, first_seen_at, last_updated_at
      ) VALUES ('src-1', 100, 555, 30.0, -90.0, ?, 0, 'Hideout', 'Camp 1', 128512, '😀', 0, ?, ?)
    `).run(now + 3600, now, now);

    const row = db
      .prepare(`SELECT * FROM waypoints WHERE source_id = 'src-1' AND waypoint_id = 100`)
      .get() as any;
    expect(row.name).toBe('Hideout');
    expect(row.latitude).toBe(30.0);
    expect(row.longitude).toBe(-90.0);
    expect(row.icon_emoji).toBe('😀');
    expect(row.is_virtual).toBe(0);
  });

  it('enforces the (source_id, waypoint_id) primary key', () => {
    migration.up(db);
    insertSource(db, 'src-1');
    const now = Date.now();
    const insert = `
      INSERT INTO waypoints (source_id, waypoint_id, latitude, longitude, first_seen_at, last_updated_at)
      VALUES (?, ?, 30, -90, ?, ?)
    `;
    db.prepare(insert).run('src-1', 1, now, now);
    expect(() => db.prepare(insert).run('src-1', 1, now, now)).toThrow();
    // Same waypoint_id under a different source IS allowed.
    insertSource(db, 'src-2');
    expect(() => db.prepare(insert).run('src-2', 1, now, now)).not.toThrow();
  });

  it('cascades delete when source is removed', () => {
    migration.up(db);
    insertSource(db, 'src-1');
    const now = Date.now();
    db.prepare(`
      INSERT INTO waypoints (source_id, waypoint_id, latitude, longitude, first_seen_at, last_updated_at)
      VALUES ('src-1', 1, 30, -90, ?, ?)
    `).run(now, now);

    db.prepare(`DELETE FROM sources WHERE id = 'src-1'`).run();
    const remaining = db.prepare(`SELECT COUNT(*) as cnt FROM waypoints`).get() as any;
    expect(remaining.cnt).toBe(0);
  });

  it('is idempotent', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
  });
});
