/**
 * Tests for migration 203 - reaction columns on meshcore_messages (#5759).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './203_add_meshcore_reaction_columns.js';

const COLS = ['mc1Hash','reactionEmoji','reactionFormat','reactionTargetHash','reactionTargetSender','reactionTargetId','reactionRawText'];

function createTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meshcore_messages (
      id TEXT PRIMARY KEY,
      fromPublicKey TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      sourceId TEXT,
      createdAt INTEGER NOT NULL
    )
  `);
}

describe('Migration 203 - meshcore reaction columns', () => {
  it('adds seven nullable TEXT columns and the index, idempotently', () => {
    const db = new Database(':memory:');
    createTable(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const info = db.prepare('PRAGMA table_info(meshcore_messages)').all() as Array<{ name: string; notnull: number; type: string; dflt_value: unknown }>;
    for (const name of COLS) {
      const c = info.find((x) => x.name === name);
      expect(c, name).toBeDefined();
      expect(c!.notnull).toBe(0);
      expect(c!.type).toBe('TEXT');
      expect(c!.dflt_value).toBeNull();
    }
    const idx = db.prepare(`PRAGMA index_info(idx_meshcore_messages_mc1hash)`).all() as Array<{ name: string }>;
    expect(idx.map((i) => i.name)).toEqual(['sourceId', 'mc1Hash']);
    db.close();
  });

  it('leaves existing rows NULL and round-trips values per source', () => {
    const db = new Database(':memory:');
    createTable(db);
    db.prepare(`INSERT INTO meshcore_messages (id, fromPublicKey, text, timestamp, sourceId, createdAt)
      VALUES ('a', 'k', 't', 1, 'src-a', 1), ('b', 'k', 't', 1, 'src-b', 1)`).run();
    migration.up(db);
    expect(db.prepare(`SELECT id, mc1Hash, reactionEmoji, reactionTargetId FROM meshcore_messages ORDER BY id`).all())
      .toEqual([
        { id: 'a', mc1Hash: null, reactionEmoji: null, reactionTargetId: null },
        { id: 'b', mc1Hash: null, reactionEmoji: null, reactionTargetId: null },
      ]);
    db.prepare(`UPDATE meshcore_messages SET mc1Hash = 'b45pc4ek', reactionEmoji = ? WHERE sourceId = 'src-a'`).run('\u{1F44D}');
    expect(db.prepare(`SELECT id, mc1Hash, reactionEmoji FROM meshcore_messages ORDER BY id`).all())
      .toEqual([
        { id: 'a', mc1Hash: 'b45pc4ek', reactionEmoji: '\u{1F44D}' },
        { id: 'b', mc1Hash: null, reactionEmoji: null },
      ]);
    db.close();
  });
});
