/**
 * Migration 079 — Drop residual single-column unique indexes on
 * user_notification_preferences.user_id.
 *
 * Tests that the migration uses PRAGMA introspection to find and drop any
 * single-column unique index on user_id regardless of how it was named,
 * leaving the correct composite (user_id, source_id) index intact.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './079_drop_residual_notif_prefs_user_id_unique.js';

function createTableWithCompositeUnique(db: Database.Database) {
  db.exec(`
    CREATE TABLE user_notification_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_user_notification_preferences_user_source
      ON user_notification_preferences(user_id, source_id);
  `);
}

describe('Migration 079 — drop residual single-column user_id unique', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createTableWithCompositeUnique(db);
  });

  it('drops an old single-column unique index by the legacy name from migration 015', () => {
    db.exec(`CREATE UNIQUE INDEX idx_user_notification_preferences_user_id ON user_notification_preferences(user_id)`);

    migration.up(db);

    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='user_notification_preferences'
    `).all() as any[];
    const names = indexes.map(i => i.name);

    expect(names).not.toContain('idx_user_notification_preferences_user_id');
    expect(names).toContain('idx_user_notification_preferences_user_source');
  });

  it('drops a single-column unique index with any arbitrary name', () => {
    db.exec(`CREATE UNIQUE INDEX some_other_unique_name ON user_notification_preferences(user_id)`);

    migration.up(db);

    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='user_notification_preferences'
    `).all() as any[];
    const names = indexes.map(i => i.name);

    expect(names).not.toContain('some_other_unique_name');
    expect(names).toContain('idx_user_notification_preferences_user_source');
  });

  it('leaves the composite (user_id, source_id) unique index intact', () => {
    migration.up(db);

    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='user_notification_preferences'
    `).all() as any[];
    const names = indexes.map(i => i.name);

    expect(names).toContain('idx_user_notification_preferences_user_source');
  });

  it('does not drop non-unique single-column indexes on user_id', () => {
    db.exec(`CREATE INDEX idx_non_unique_user_id ON user_notification_preferences(user_id)`);

    migration.up(db);

    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='user_notification_preferences'
    `).all() as any[];
    const names = indexes.map(i => i.name);

    expect(names).toContain('idx_non_unique_user_id');
  });

  it('is idempotent — running twice does not throw and leaves schema stable', () => {
    db.exec(`CREATE UNIQUE INDEX idx_user_notification_preferences_user_id ON user_notification_preferences(user_id)`);

    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='user_notification_preferences'
    `).all() as any[];
    expect(indexes.map((i: any) => i.name)).toContain('idx_user_notification_preferences_user_source');
  });

  it('allows per-source upserts after migration (simulating the fixed bug scenario)', () => {
    // Simulate the bug: single-column unique on user_id coexists with composite unique
    db.exec(`CREATE UNIQUE INDEX idx_user_notification_preferences_user_id ON user_notification_preferences(user_id)`);

    // Migration drops the single-column unique
    migration.up(db);

    const now = Date.now();
    // Insert first source row
    db.prepare(
      `INSERT INTO user_notification_preferences (user_id, source_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run(1, 'source-A', now, now);

    // Insert second source row — would have failed with UNIQUE constraint on user_id before fix
    expect(() => {
      db.prepare(
        `INSERT INTO user_notification_preferences (user_id, source_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
      ).run(1, 'source-B', now, now);
    }).not.toThrow();

    const rows = db
      .prepare(`SELECT source_id FROM user_notification_preferences WHERE user_id = 1 ORDER BY source_id`)
      .all() as any[];
    expect(rows.map(r => r.source_id)).toEqual(['source-A', 'source-B']);
  });
});
