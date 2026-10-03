/**
 * Tests for migration 191 — repeater ingest columns (#5551, #5553).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './191_add_meshcore_repeater_ingest_columns.js';

function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE meshcore_messages (
      id TEXT PRIMARY KEY,
      fromPublicKey TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      sourceId TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE meshcore_nodes (
      publicKey TEXT NOT NULL,
      sourceId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (sourceId, publicKey)
    );
  `);
}

const columns = (db: Database.Database, table: string) =>
  db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; type: string }>;

describe('Migration 191 — repeater ingest columns', () => {
  it('adds nullable columns to both tables and is idempotent', () => {
    const db = new Database(':memory:');
    createTables(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    const msg = columns(db, 'meshcore_messages');
    for (const [name, type] of [['keySourceId', 'TEXT'], ['keyChannelIdx', 'INTEGER'], ['keyFingerprint', 'TEXT']]) {
      const col = msg.find((c) => c.name === name);
      expect(col, name).toBeDefined();
      expect(col!.notnull).toBe(0);
      expect(col!.type).toBe(type);
    }
    const node = columns(db, 'meshcore_nodes').find((c) => c.name === 'repeaterNeighborAt');
    expect(node).toBeDefined();
    expect(node!.notnull).toBe(0);
    db.close();
  });

  it('leaves existing rows NULL (unkeyed, not a listed neighbour)', () => {
    const db = new Database(':memory:');
    createTables(db);
    db.prepare(`INSERT INTO meshcore_messages (id, fromPublicKey, text, timestamp, sourceId, createdAt)
      VALUES ('a', 'channel-0', 't', 1, 'src-a', 1)`).run();
    db.prepare(`INSERT INTO meshcore_nodes (publicKey, sourceId, createdAt, updatedAt) VALUES ('k', 'src-a', 1, 1)`).run();
    migration.up(db);
    expect(db.prepare(`SELECT keySourceId, keyChannelIdx, keyFingerprint FROM meshcore_messages`).get())
      .toEqual({ keySourceId: null, keyChannelIdx: null, keyFingerprint: null });
    expect(db.prepare(`SELECT repeaterNeighborAt FROM meshcore_nodes`).get()).toEqual({ repeaterNeighborAt: null });
    db.close();
  });
});
