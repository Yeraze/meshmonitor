/**
 * Tests for migration 251 — `meshcore_nodes.lastRoomClearAt` (#6579).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './251_add_meshcore_room_clear_at.js';

function createTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meshcore_nodes (
      publicKey TEXT NOT NULL,
      sourceId TEXT NOT NULL,
      lastRoomSyncAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (sourceId, publicKey)
    )
  `);
}

describe('Migration 251 — meshcore_nodes.lastRoomClearAt', () => {
  it('adds a nullable INTEGER column and is idempotent', () => {
    const db = new Database(':memory:');
    createTable(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const col = (db.prepare('PRAGMA table_info(meshcore_nodes)').all() as Array<{ name: string; notnull: number; type: string }>)
      .find((c) => c.name === 'lastRoomClearAt');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
    expect(col!.type).toBe('INTEGER');
    db.close();
  });

  it('leaves existing rows NULL and round-trips a value per source', () => {
    const db = new Database(':memory:');
    createTable(db);
    db.prepare(`INSERT INTO meshcore_nodes (publicKey, sourceId, createdAt, updatedAt)
      VALUES ('room', 'src-a', 1, 1), ('room', 'src-b', 1, 1)`).run();
    migration.up(db);
    expect(db.prepare(`SELECT sourceId, lastRoomClearAt FROM meshcore_nodes ORDER BY sourceId`).all())
      .toEqual([{ sourceId: 'src-a', lastRoomClearAt: null }, { sourceId: 'src-b', lastRoomClearAt: null }]);
    db.prepare(`UPDATE meshcore_nodes SET lastRoomClearAt = 1700000000000 WHERE sourceId = 'src-a'`).run();
    expect(db.prepare(`SELECT sourceId, lastRoomClearAt FROM meshcore_nodes ORDER BY sourceId`).all())
      .toEqual([{ sourceId: 'src-a', lastRoomClearAt: 1700000000000 }, { sourceId: 'src-b', lastRoomClearAt: null }]);
    db.close();
  });
});
