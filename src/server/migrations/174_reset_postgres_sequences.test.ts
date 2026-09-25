/**
 * Migration 174 — SQLite / MySQL runners are no-ops.
 *
 * Also pins the reason they can be: SQLite advances its id counter on an
 * explicit-id INSERT (rowid tables and AUTOINCREMENT's sqlite_sequence), so a
 * restore that re-inserts original ids never leaves a stale counter.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration174Mysql } from './174_reset_postgres_sequences.js';

describe('Migration 174 — reset_postgres_sequences', () => {
  it('SQLite: no-op and idempotent', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)');
    db.exec(`INSERT INTO t (id, label) VALUES (5, 'x')`);
    const before = db.prepare('SELECT * FROM sqlite_sequence').all();

    expect(() => migration.up(db)).not.toThrow();
    expect(() => migration.up(db)).not.toThrow();
    expect(db.prepare('SELECT * FROM sqlite_sequence').all()).toEqual(before);
    db.close();
  });

  it('SQLite: explicit-id inserts already advance the counter (why the runner is a no-op)', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE auto (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)');
    db.exec('CREATE TABLE plain (id INTEGER PRIMARY KEY, label TEXT)');
    for (const table of ['auto', 'plain']) {
      // Restore shape: DELETE, then re-insert with original ids.
      db.exec(`INSERT INTO ${table} (label) VALUES ('live')`);
      db.exec(`DELETE FROM ${table}`);
      for (let id = 1; id <= 5; id++) {
        db.prepare(`INSERT INTO ${table} (id, label) VALUES (?, 'old')`).run(id);
      }
      const { lastInsertRowid } = db.prepare(`INSERT INTO ${table} (label) VALUES ('new')`).run();
      expect(Number(lastInsertRowid)).toBe(6);
    }
    db.close();
  });

  it('MySQL: no-op, never touches the pool', async () => {
    const pool = { query: vi.fn(), execute: vi.fn(), getConnection: vi.fn() };
    await runMigration174Mysql(pool);
    await runMigration174Mysql(pool);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.execute).not.toHaveBeenCalled();
    expect(pool.getConnection).not.toHaveBeenCalled();
  });
});
