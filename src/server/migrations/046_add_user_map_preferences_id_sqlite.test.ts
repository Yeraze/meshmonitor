/**
 * Migration 046 — Add missing `id` / `createdAt` / `updatedAt` columns to
 * SQLite user_map_preferences on legacy databases.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './046_add_user_map_preferences_id_sqlite.js';

function createUsers(db: Database.Database) {
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE
    );
  `);
  db.prepare(`INSERT INTO users (id, username) VALUES (?, ?)`).run(1, 'admin');
  db.prepare(`INSERT INTO users (id, username) VALUES (?, ?)`).run(2, 'user2');
}

function createLegacyMapPrefs(db: Database.Database) {
  // Legacy SQLite table: no id column, uses user_id directly (post migration 007),
  // carries the snake_case feature columns migration 007 added.
  db.exec(`
    CREATE TABLE user_map_preferences (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      centerLat REAL,
      centerLng REAL,
      zoom REAL,
      selectedLayer TEXT,
      map_tileset TEXT,
      show_paths INTEGER DEFAULT 0,
      show_neighbor_info INTEGER DEFAULT 0,
      show_route INTEGER DEFAULT 1,
      show_motion INTEGER DEFAULT 1,
      show_mqtt_nodes INTEGER DEFAULT 1,
      show_meshcore_nodes INTEGER DEFAULT 1,
      show_animations INTEGER DEFAULT 0,
      show_accuracy_regions INTEGER DEFAULT 0,
      show_estimated_positions INTEGER DEFAULT 0,
      position_history_hours INTEGER,
      createdAt INTEGER,
      updatedAt INTEGER
    );
    CREATE INDEX idx_user_map_prefs_user ON user_map_preferences(user_id);
  `);
}

function createModernMapPrefs(db: Database.Database) {
  // Modern table already has id column — migration should be a no-op.
  db.exec(`
    CREATE TABLE user_map_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      centerLat REAL,
      centerLng REAL,
      zoom REAL,
      selectedLayer TEXT,
      map_tileset TEXT,
      show_paths INTEGER DEFAULT 0,
      show_neighbor_info INTEGER DEFAULT 0,
      show_route INTEGER DEFAULT 1,
      show_motion INTEGER DEFAULT 1,
      show_mqtt_nodes INTEGER DEFAULT 1,
      show_meshcore_nodes INTEGER DEFAULT 1,
      show_animations INTEGER DEFAULT 0,
      show_accuracy_regions INTEGER DEFAULT 0,
      show_estimated_positions INTEGER DEFAULT 0,
      position_history_hours INTEGER,
      createdAt INTEGER,
      updatedAt INTEGER
    );
  `);
}

function hasIdColumn(db: Database.Database): boolean {
  const cols = db.prepare(`PRAGMA table_info(user_map_preferences)`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === 'id');
}

describe('Migration 046 — add user_map_preferences id on SQLite', () => {
  let db: Database.Database;

  describe('legacy schema without id', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      createUsers(db);
      createLegacyMapPrefs(db);
      db.prepare(`
        INSERT INTO user_map_preferences
          (user_id, centerLat, centerLng, zoom, selectedLayer, map_tileset,
           show_paths, show_neighbor_info, show_route, show_motion,
           show_mqtt_nodes, show_meshcore_nodes, show_animations,
           show_accuracy_regions, show_estimated_positions,
           position_history_hours, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        1, 40.0, -100.0, 6, 'osm', 'custom',
        1, 0, 1, 1,
        1, 0, 0,
        1, 1,
        24, 1000, 2000,
      );
      db.prepare(`
        INSERT INTO user_map_preferences
          (user_id, centerLat, centerLng, zoom, selectedLayer, map_tileset,
           show_paths, show_neighbor_info, show_route, show_motion,
           show_mqtt_nodes, show_meshcore_nodes, show_animations,
           show_accuracy_regions, show_estimated_positions,
           position_history_hours, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        2, 50.0, -110.0, 8, 'satellite', null,
        0, 1, 0, 0,
        0, 1, 1,
        0, 0,
        null, 1001, 2001,
      );
    });

    it('adds the id column', () => {
      expect(hasIdColumn(db)).toBe(false);
      migration.up(db);
      expect(hasIdColumn(db)).toBe(true);
    });

    it('preserves all user preference rows', () => {
      migration.up(db);
      const rows = db.prepare(
        `SELECT user_id, centerLat, centerLng, zoom, selectedLayer, map_tileset,
                show_paths, show_neighbor_info, show_route, show_motion,
                show_mqtt_nodes, show_meshcore_nodes, show_animations,
                show_accuracy_regions, show_estimated_positions,
                position_history_hours, createdAt, updatedAt
         FROM user_map_preferences ORDER BY user_id`,
      ).all() as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].user_id).toBe(1);
      expect(rows[0].selectedLayer).toBe('osm');
      expect(rows[0].map_tileset).toBe('custom');
      expect(rows[0].show_paths).toBe(1);
      expect(rows[0].position_history_hours).toBe(24);
      expect(rows[0].createdAt).toBe(1000);
      expect(rows[1].user_id).toBe(2);
      expect(rows[1].show_neighbor_info).toBe(1);
      expect(rows[1].position_history_hours).toBeNull();
    });

    it('assigns unique sequential id values', () => {
      migration.up(db);
      const ids = db.prepare(`SELECT id FROM user_map_preferences ORDER BY user_id`).all() as Array<{ id: number }>;
      expect(ids).toHaveLength(2);
      expect(ids[0].id).toBeTypeOf('number');
      expect(ids[0].id).toBeGreaterThan(0);
      expect(ids[1].id).not.toBe(ids[0].id);
    });

    it('allows SELECT id (the regression case from production logs)', () => {
      migration.up(db);
      expect(() =>
        db.prepare(`SELECT id, user_id, createdAt, updatedAt FROM user_map_preferences WHERE user_id = ?`).all(1)
      ).not.toThrow();
    });

    it('restores foreign_keys=ON after running', () => {
      migration.up(db);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('is idempotent — second run is a no-op', () => {
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();
      expect(hasIdColumn(db)).toBe(true);
    });
  });

  describe('modern schema already has id', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      createUsers(db);
      createModernMapPrefs(db);
      db.prepare(
        `INSERT INTO user_map_preferences (user_id, createdAt, updatedAt) VALUES (?, ?, ?)`,
      ).run(1, 1000, 2000);
    });

    it('is a no-op when id already exists', () => {
      const before = db.prepare(`SELECT id, user_id FROM user_map_preferences`).all() as any[];
      migration.up(db);
      const after = db.prepare(`SELECT id, user_id FROM user_map_preferences`).all() as any[];
      expect(after).toEqual(before);
    });
  });

  describe('table does not exist', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      createUsers(db);
    });

    it('is a no-op when the table does not exist', () => {
      expect(() => migration.up(db)).not.toThrow();
    });
  });
});
