/**
 * Tests for migration 231 — `meshcore_messages.senderNameOverride` (#6282).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './231_add_meshcore_message_sender_name_override.js';

function createTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meshcore_messages (
      id TEXT PRIMARY KEY,
      fromPublicKey TEXT NOT NULL,
      toPublicKey TEXT,
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      sourceId TEXT,
      createdAt INTEGER NOT NULL
    )
  `);
}

describe('Migration 231 — meshcore_messages.senderNameOverride', () => {
  it('adds a nullable column and is idempotent', () => {
    const db = new Database(':memory:');
    createTable(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const col = (db.prepare('PRAGMA table_info(meshcore_messages)').all() as Array<{ name: string; notnull: number; type: string }>)
      .find((c) => c.name === 'senderNameOverride');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
    expect(col!.type).toBe('TEXT');
    db.close();
  });

  it('leaves existing rows NULL and round-trips a value per source', () => {
    const db = new Database(':memory:');
    createTable(db);
    db.prepare(`INSERT INTO meshcore_messages (id, fromPublicKey, text, timestamp, sourceId, createdAt)
      VALUES ('a', 'k', 't', 1, 'src-a', 1), ('b', 'k', 't', 1, 'src-b', 1)`).run();
    migration.up(db);
    expect(db.prepare(`SELECT id, senderNameOverride FROM meshcore_messages ORDER BY id`).all())
      .toEqual([{ id: 'a', senderNameOverride: null }, { id: 'b', senderNameOverride: null }]);
    db.prepare(`UPDATE meshcore_messages SET senderNameOverride = 'Bot' WHERE sourceId = 'src-a'`).run();
    expect(db.prepare(`SELECT id, senderNameOverride FROM meshcore_messages ORDER BY id`).all())
      .toEqual([{ id: 'a', senderNameOverride: 'Bot' }, { id: 'b', senderNameOverride: null }]);
    db.close();
  });
});
