/**
 * Tests for migration 202: `notify_on_mention` on `user_notification_preferences`.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './202_add_notify_on_mention.js';

function createParentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_notification_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source_id TEXT NOT NULL DEFAULT ''
    )
  `);
}

describe('Migration 202: notify_on_mention', () => {
  it('adds the column and is idempotent', () => {
    const db = new Database(':memory:');
    createParentTable(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = (db.prepare('PRAGMA table_info(user_notification_preferences)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('notify_on_mention');
    db.close();
  });

  it('an existing row reads off, so an upgrade alerts nobody', () => {
    const db = new Database(':memory:');
    createParentTable(db);
    db.prepare(`INSERT INTO user_notification_preferences (user_id, source_id) VALUES (1, 'src')`).run();
    migration.up(db);
    const row = db.prepare('SELECT notify_on_mention FROM user_notification_preferences WHERE user_id = 1').get() as { notify_on_mention: number };
    expect(row.notify_on_mention).toBe(0);
    db.close();
  });
});
