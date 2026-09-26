/**
 * Tests for migration 176 — `user_map_preferences.aircraft_display_mode`
 * (#5364/#5365 Phase 1 WP1).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './176_user_map_preferences_aircraft_display_mode.js';

/** The table as migration 164 leaves it — no `aircraft_display_mode`. */
function createParentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_map_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      spread_nodes INTEGER DEFAULT 1
    )
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('Migration 176 — user_map_preferences.aircraft_display_mode', () => {
  it('adds the column and is idempotent (second up() does not throw)', () => {
    const db = new Database(':memory:');
    createParentTable(db);

    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    expect(columnNames(db, 'user_map_preferences')).toContain('aircraft_display_mode');
    db.close();
  });

  it('existing rows read null (frontend treats null as \'mark\'), and a value round-trips', () => {
    const db = new Database(':memory:');
    createParentTable(db);
    db.prepare(`INSERT INTO user_map_preferences (user_id) VALUES (1)`).run();

    migration.up(db);

    const before = db.prepare('SELECT aircraft_display_mode FROM user_map_preferences WHERE user_id = 1').get() as Record<string, unknown>;
    expect(before.aircraft_display_mode).toBeNull();

    db.prepare(`UPDATE user_map_preferences SET aircraft_display_mode = 'hide' WHERE user_id = 1`).run();
    const after = db.prepare('SELECT aircraft_display_mode FROM user_map_preferences WHERE user_id = 1').get() as Record<string, unknown>;
    expect(after.aircraft_display_mode).toBe('hide');

    db.close();
  });
});
