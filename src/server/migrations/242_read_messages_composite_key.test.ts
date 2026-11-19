/**
 * migration 242 — SQLite `read_messages` keyed by (message_id, user_id) (#6505).
 * PG/MySQL are no-ops; their (messageId, userId) behaviour is covered by the
 * two-user test in `src/db/repositories/notifications.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './242_read_messages_composite_key.js';

function oldShapeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT);
    INSERT INTO users (id, username) VALUES (1, 'a'), (2, 'b');
    CREATE TABLE read_messages (
      message_id TEXT NOT NULL PRIMARY KEY,
      user_id INTEGER,
      read_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    INSERT INTO read_messages VALUES ('m1', 1, 100), ('m2', 2, 200), ('m3', NULL, 300);
  `);
  return db;
}

const pkCols = (db: Database.Database) =>
  (db.prepare(`PRAGMA table_info('read_messages')`).all() as Array<{ name: string; pk: number }>)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);

describe('migration 242 — SQLite', () => {
  it('rebuilds the key as (message_id, user_id) and keeps every row', () => {
    const db = oldShapeDb();
    migration.up(db);

    expect(pkCols(db)).toEqual(['message_id', 'user_id']);
    expect(db.prepare('SELECT message_id, user_id, read_at FROM read_messages ORDER BY message_id').all()).toEqual([
      { message_id: 'm1', user_id: 1, read_at: 100 },
      { message_id: 'm2', user_id: 2, read_at: 200 },
      { message_id: 'm3', user_id: null, read_at: 300 },
    ]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('lets a second user mark a message another user already read', () => {
    const db = oldShapeDb();
    migration.up(db);

    const mark = db.prepare('INSERT INTO read_messages (message_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
    expect(mark.run('m1', 2, 400).changes).toBe(1);
    expect(mark.run('m1', 2, 500).changes).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM read_messages WHERE message_id = 'm1'`).get()).toEqual({ n: 2 });
    db.close();
  });

  it('keeps the user foreign key cascade', () => {
    const db = oldShapeDb();
    migration.up(db);
    db.prepare('DELETE FROM users WHERE id = 1').run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM read_messages WHERE user_id = 1`).get()).toEqual({ n: 0 });
    db.close();
  });

  it('is idempotent and recovers from a leftover rebuild table', () => {
    const db = oldShapeDb();
    db.exec('CREATE TABLE read_messages_rebuild_242 (junk TEXT)');
    migration.up(db);
    migration.up(db);

    expect(pkCols(db)).toEqual(['message_id', 'user_id']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM read_messages').get()).toEqual({ n: 3 });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'read_messages_rebuild_242'`).get(),
    ).toEqual({ n: 0 });
    db.close();
  });
});
