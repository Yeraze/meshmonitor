/**
 * Tests for migration 205 — `user_map_preferences.show_mqtt_messages_by_source` (#5824).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './205_user_map_preferences_mqtt_messages_by_source.js';

function createParentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_map_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      show_mqtt_nodes INTEGER DEFAULT 1
    )
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('Migration 205 — user_map_preferences per-source MQTT message toggle', () => {
  it('adds the column and is idempotent (second up() does not throw)', () => {
    const db = new Database(':memory:');
    createParentTable(db);

    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    expect(columnNames(db, 'user_map_preferences')).toContain('show_mqtt_messages_by_source');
    db.close();
  });

  it('existing rows read NULL (never set)', () => {
    const db = new Database(':memory:');
    createParentTable(db);
    db.prepare(`INSERT INTO user_map_preferences (user_id) VALUES (1)`).run();

    migration.up(db);

    const row = db
      .prepare('SELECT show_mqtt_messages_by_source FROM user_map_preferences WHERE user_id = 1')
      .get() as Record<string, unknown>;
    expect(row.show_mqtt_messages_by_source).toBeNull();
    db.close();
  });
});
