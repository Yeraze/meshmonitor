/**
 * Tests for migration 196 — user_notification_preferences message templates (#5593).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './196_add_notification_message_templates.js';

function createTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE user_notification_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      prefix_with_node_name INTEGER DEFAULT 0,
      whitelist TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, source_id)
    );
  `);
}

const COLUMNS = ['message_title_template', 'message_body_template'];

describe('Migration 196 — notification message templates (SQLite)', () => {
  it('adds two nullable text columns and is idempotent', () => {
    const db = new Database(':memory:');
    createTable(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    const cols = db.prepare(`PRAGMA table_info(user_notification_preferences)`).all() as Array<{
      name: string; type: string; notnull: number; dflt_value: unknown;
    }>;
    for (const name of COLUMNS) {
      const matches = cols.filter((c) => c.name === name);
      expect(matches).toHaveLength(1);
      expect(matches[0].type).toBe('TEXT');
      expect(matches[0].notnull).toBe(0);
      expect(matches[0].dflt_value).toBeNull();
    }
    db.close();
  });

  it('leaves existing rows NULL (the built-in default) and keeps their other columns', () => {
    const db = new Database(':memory:');
    createTable(db);
    db.prepare(`INSERT INTO user_notification_preferences (user_id, source_id, prefix_with_node_name, whitelist, created_at, updated_at)
      VALUES (1, 'src-a', 1, '["Hi"]', 1, 1)`).run();
    migration.up(db);
    expect(
      db.prepare(`SELECT user_id, source_id, prefix_with_node_name, whitelist, message_title_template, message_body_template
        FROM user_notification_preferences`).get(),
    ).toEqual({
      user_id: 1,
      source_id: 'src-a',
      prefix_with_node_name: 1,
      whitelist: '["Hi"]',
      message_title_template: null,
      message_body_template: null,
    });
    db.close();
  });

  it('stores a template per (user, source) row', () => {
    const db = new Database(':memory:');
    createTable(db);
    migration.up(db);
    const insert = db.prepare(`INSERT INTO user_notification_preferences
      (user_id, source_id, message_title_template, message_body_template, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)`);
    insert.run(1, 'src-a', '{{ channelName }}', '{{ text }}');
    insert.run(1, 'src-b', null, null);
    const rows = db.prepare(`SELECT source_id, message_title_template AS t, message_body_template AS b
      FROM user_notification_preferences ORDER BY source_id`).all();
    expect(rows).toEqual([
      { source_id: 'src-a', t: '{{ channelName }}', b: '{{ text }}' },
      { source_id: 'src-b', t: null, b: null },
    ]);
    db.close();
  });
});
