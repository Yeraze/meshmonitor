/**
 * Tests for migration 208 — `channel_database.use_aead` (#5248 Phase 2).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './208_add_channel_database_use_aead.js';

describe('Migration 208 — channel_database.use_aead', () => {
  it('adds a NOT NULL column defaulting to 0, keeps existing rows plain, and is idempotent', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE channel_database (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    db.prepare(`INSERT INTO channel_database (name) VALUES ('old')`).run();
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const col = (db.prepare('PRAGMA table_info(channel_database)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>)
      .find((c) => c.name === 'use_aead');
    expect(col).toMatchObject({ notnull: 1, dflt_value: '0' });
    db.prepare(`INSERT INTO channel_database (name, use_aead) VALUES ('aead', 1)`).run();
    expect(db.prepare(`SELECT name, use_aead FROM channel_database ORDER BY id`).all()).toEqual([
      { name: 'old', use_aead: 0 },
      { name: 'aead', use_aead: 1 },
    ]);
    db.close();
  });
});
