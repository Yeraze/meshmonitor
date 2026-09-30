/**
 * Tests for migration 185 — `channels.useAead` (#5248 Phase 1).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './185_add_channel_use_aead.js';

function createChannelsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      pk INTEGER PRIMARY KEY AUTOINCREMENT,
      id INTEGER NOT NULL,
      name TEXT NOT NULL,
      psk TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      sourceId TEXT
    )
  `);
}

describe('Migration 185 — channels.useAead', () => {
  it('adds the column and is idempotent', () => {
    const db = new Database(':memory:');
    createChannelsTable(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const col = (db.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>)
      .find((c) => c.name === 'useAead');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(1);
    expect(col!.dflt_value).toBe('0');
    db.close();
  });

  it('existing rows read false, and a true write round-trips per source', () => {
    const db = new Database(':memory:');
    createChannelsTable(db);
    db.prepare(`INSERT INTO channels (id, name, createdAt, updatedAt, sourceId) VALUES (0, 'a', 1, 1, 'src-a'), (0, 'b', 1, 1, 'src-b')`).run();
    migration.up(db);
    const before = db.prepare(`SELECT sourceId, useAead FROM channels ORDER BY sourceId`).all();
    expect(before).toEqual([{ sourceId: 'src-a', useAead: 0 }, { sourceId: 'src-b', useAead: 0 }]);
    db.prepare(`UPDATE channels SET useAead = 1 WHERE sourceId = 'src-a'`).run();
    const after = db.prepare(`SELECT sourceId, useAead FROM channels ORDER BY sourceId`).all();
    expect(after).toEqual([{ sourceId: 'src-a', useAead: 1 }, { sourceId: 'src-b', useAead: 0 }]);
    db.close();
  });
});
