/**
 * Tests for migration 178 — `user_map_preferences.show_aircraft_trails` +
 * `aircraft_trail_hours` (#5364/#5365 Phase 3).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './178_user_map_preferences_aircraft_trails.js';

/** The table as earlier migrations leave it — no trail columns. */
function createParentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_map_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      spread_nodes INTEGER DEFAULT 1,
      aircraft_display_mode TEXT
    )
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('Migration 178 — user_map_preferences aircraft trail columns', () => {
  it('adds both columns and is idempotent (second up() does not throw)', () => {
    const db = new Database(':memory:');
    createParentTable(db);

    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    const cols = columnNames(db, 'user_map_preferences');
    expect(cols).toContain('show_aircraft_trails');
    expect(cols).toContain('aircraft_trail_hours');
    db.close();
  });

  it('existing rows get off / 6 h, and values round-trip', () => {
    const db = new Database(':memory:');
    createParentTable(db);
    db.prepare(`INSERT INTO user_map_preferences (user_id) VALUES (1)`).run();

    migration.up(db);

    const before = db
      .prepare('SELECT show_aircraft_trails, aircraft_trail_hours FROM user_map_preferences WHERE user_id = 1')
      .get() as Record<string, unknown>;
    expect(before.show_aircraft_trails).toBe(0);
    expect(before.aircraft_trail_hours).toBe(6);

    db.prepare(`UPDATE user_map_preferences SET show_aircraft_trails = 1, aircraft_trail_hours = 48 WHERE user_id = 1`).run();
    const after = db
      .prepare('SELECT show_aircraft_trails, aircraft_trail_hours FROM user_map_preferences WHERE user_id = 1')
      .get() as Record<string, unknown>;
    expect(after.show_aircraft_trails).toBe(1);
    expect(after.aircraft_trail_hours).toBe(48);

    db.close();
  });
});
