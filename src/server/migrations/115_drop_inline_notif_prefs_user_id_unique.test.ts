/**
 * Migration 115 — Drop an inline (autoindex) unique constraint on
 * user_notification_preferences.user_id that migration 079 cannot see.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './115_drop_inline_notif_prefs_user_id_unique.js';

function createUsersTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL
    );
  `);
}

function createTableWithInlineUnique(db: Database.Database) {
  // Mirrors what an early `drizzle-kit push` (before the migration system
  // existed) would have produced: a UNIQUE constraint declared inline on the
  // column, which SQLite implements as an autoindex with no `sql` text in
  // sqlite_master — invisible to migration 079's sqlite_master query.
  db.exec(`
    CREATE TABLE user_notification_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      source_id TEXT,
      enable_apprise INTEGER DEFAULT 1,
      apprise_urls TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

function createTableWithCompositeUniqueOnly(db: Database.Database) {
  db.exec(`
    CREATE TABLE user_notification_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      enable_apprise INTEGER DEFAULT 1,
      apprise_urls TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX idx_user_notification_preferences_user_source
      ON user_notification_preferences(user_id, source_id);
  `);
}

describe('Migration 115 — drop inline autoindex unique(user_id)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createUsersTable(db);
  });

  it('rebuilds the table to drop an inline UNIQUE(user_id) autoindex', () => {
    createTableWithInlineUnique(db);
    db.prepare(`INSERT INTO users (id, username) VALUES (1, 'alice')`).run();

    // Sanity check: reproduce the bug before the migration runs — a second
    // source's row for the same user hits the inline unique constraint.
    const now = Date.now();
    db.prepare(`
      INSERT INTO user_notification_preferences (user_id, source_id, created_at, updated_at)
      VALUES (1, 'source-a', ?, ?)
    `).run(now, now);
    expect(() => {
      db.prepare(`
        INSERT INTO user_notification_preferences (user_id, source_id, created_at, updated_at)
        VALUES (1, 'source-b', ?, ?)
      `).run(now, now);
    }).toThrow(/UNIQUE constraint failed: user_notification_preferences\.user_id/);

    migration.up(db);

    // The autoindex is gone — a second source's row for the same user now inserts cleanly.
    expect(() => {
      db.prepare(`
        INSERT INTO user_notification_preferences (user_id, source_id, created_at, updated_at)
        VALUES (1, 'source-b', ?, ?)
      `).run(now, now);
    }).not.toThrow();

    const rows = db.prepare(`SELECT user_id, source_id FROM user_notification_preferences ORDER BY source_id`).all();
    expect(rows).toEqual([
      { user_id: 1, source_id: 'source-a' },
      { user_id: 1, source_id: 'source-b' },
    ]);

    const indexList = db.prepare(`PRAGMA index_list('user_notification_preferences')`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
    }>;
    const singleColumnUserIdUnique = indexList.filter((idx) => {
      if (!idx.unique) return false;
      const cols = db.prepare(`PRAGMA index_info("${idx.name}")`).all() as Array<{ name: string }>;
      return cols.length === 1 && cols[0].name === 'user_id';
    });
    expect(singleColumnUserIdUnique).toEqual([]);
  });

  it('preserves the composite (user_id, source_id) unique constraint after rebuild', () => {
    createTableWithInlineUnique(db);

    migration.up(db);

    const now = Date.now();
    db.prepare(`INSERT INTO users (id, username) VALUES (1, 'alice')`).run();
    db.prepare(`
      INSERT INTO user_notification_preferences (user_id, source_id, created_at, updated_at)
      VALUES (1, 'source-a', ?, ?)
    `).run(now, now);

    // Duplicate (user_id, source_id) must still be rejected.
    expect(() => {
      db.prepare(`
        INSERT INTO user_notification_preferences (user_id, source_id, created_at, updated_at)
        VALUES (1, 'source-a', ?, ?)
      `).run(now, now);
    }).toThrow(/UNIQUE constraint failed/);
  });

  it('preserves existing data across the rebuild', () => {
    createTableWithInlineUnique(db);
    db.prepare(`INSERT INTO users (id, username) VALUES (1, 'alice')`).run();
    const now = Date.now();
    db.prepare(`
      INSERT INTO user_notification_preferences (user_id, source_id, enable_apprise, apprise_urls, created_at, updated_at)
      VALUES (1, 'source-a', 1, '["https://example.com/hook"]', ?, ?)
    `).run(now, now);

    migration.up(db);

    const row = db.prepare(`SELECT user_id, source_id, enable_apprise, apprise_urls FROM user_notification_preferences`).get();
    expect(row).toEqual({
      user_id: 1,
      source_id: 'source-a',
      enable_apprise: 1,
      apprise_urls: '["https://example.com/hook"]',
    });
  });

  it('is a no-op when only the composite unique index is present', () => {
    createTableWithCompositeUniqueOnly(db);

    expect(() => migration.up(db)).not.toThrow();

    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='user_notification_preferences'
    `).all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_user_notification_preferences_user_source');
  });

  it('is a no-op when the table does not exist', () => {
    expect(() => migration.up(db)).not.toThrow();
  });

  it('restores foreign_keys=ON after running', () => {
    createTableWithInlineUnique(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    migration.up(db);

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
