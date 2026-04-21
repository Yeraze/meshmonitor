/**
 * Migration 042 — Drop legacy messages→nodes(nodeNum) FKs
 *
 * Legacy v3.x SQLite databases carry `messages.fromNodeNum` and
 * `messages.toNodeNum` FKs REFERENCES nodes(nodeNum). After migration 029
 * rebuilt nodes with a composite PK, those FKs are structurally invalid.
 * This migration rebuilds messages without the FKs so future DML doesn't
 * need to toggle foreign_keys.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './042_drop_legacy_messages_nodes_fk.js';

function createLegacySchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE nodes (
      nodeNum INTEGER NOT NULL,
      sourceId TEXT NOT NULL,
      PRIMARY KEY (nodeNum, sourceId)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      fromNodeNum INTEGER NOT NULL REFERENCES nodes(nodeNum) ON DELETE CASCADE,
      toNodeNum INTEGER NOT NULL REFERENCES nodes(nodeNum) ON DELETE CASCADE,
      fromNodeId TEXT NOT NULL,
      toNodeId TEXT NOT NULL,
      text TEXT NOT NULL,
      channel INTEGER NOT NULL DEFAULT 0,
      portnum INTEGER,
      requestId INTEGER,
      timestamp INTEGER NOT NULL,
      rxTime INTEGER,
      hopStart INTEGER,
      hopLimit INTEGER,
      relayNode INTEGER,
      replyId INTEGER,
      emoji INTEGER,
      viaMqtt INTEGER,
      viaStoreForward INTEGER,
      rxSnr REAL,
      rxRssi REAL,
      ackFailed INTEGER,
      routingErrorReceived INTEGER,
      deliveryState TEXT,
      wantAck INTEGER,
      ackFromNode INTEGER,
      createdAt INTEGER NOT NULL,
      decrypted_by TEXT,
      sourceId TEXT
    );
    CREATE INDEX idx_messages_from ON messages(fromNodeNum);
    CREATE INDEX idx_messages_timestamp ON messages(timestamp);
  `);
}

function createBaselineSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE nodes (
      nodeNum INTEGER NOT NULL,
      sourceId TEXT NOT NULL,
      PRIMARY KEY (nodeNum, sourceId)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      fromNodeNum INTEGER NOT NULL,
      toNodeNum INTEGER NOT NULL,
      fromNodeId TEXT NOT NULL,
      toNodeId TEXT NOT NULL,
      text TEXT NOT NULL,
      channel INTEGER NOT NULL DEFAULT 0,
      portnum INTEGER,
      requestId INTEGER,
      timestamp INTEGER NOT NULL,
      rxTime INTEGER,
      hopStart INTEGER,
      hopLimit INTEGER,
      relayNode INTEGER,
      replyId INTEGER,
      emoji INTEGER,
      viaMqtt INTEGER,
      viaStoreForward INTEGER,
      rxSnr REAL,
      rxRssi REAL,
      ackFailed INTEGER,
      routingErrorReceived INTEGER,
      deliveryState TEXT,
      wantAck INTEGER,
      ackFromNode INTEGER,
      createdAt INTEGER NOT NULL,
      decrypted_by TEXT,
      sourceId TEXT
    );
  `);
}

function hasLegacyFk(db: Database.Database): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(messages)`).all() as Array<{
    table: string;
    from: string;
    to: string;
  }>;
  return rows.some((r) => String(r.table).toLowerCase() === 'nodes');
}

function insertMessage(db: Database.Database, id: string, from: number, to: number, sourceId: string | null) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, channel, timestamp, createdAt, sourceId)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(id, from, to, `!${from.toString(16)}`, `!${to.toString(16)}`, 'hi', now, now, sourceId);
}

describe('Migration 042 — drop legacy messages FK', () => {
  let db: Database.Database;

  describe('legacy schema with FK present', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      createLegacySchema(db);
      db.pragma('foreign_keys = OFF');
      insertMessage(db, 'msg-1', 100, 200, 'src-1');
      insertMessage(db, 'msg-2', 300, 400, null);
      db.pragma('foreign_keys = ON');
    });

    it('removes the FKs from messages', () => {
      expect(hasLegacyFk(db)).toBe(true);
      migration.up(db);
      expect(hasLegacyFk(db)).toBe(false);
    });

    it('preserves all messages rows', () => {
      migration.up(db);
      const rows = db.prepare(`SELECT id, fromNodeNum, toNodeNum, sourceId FROM messages ORDER BY id`).all() as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('msg-1');
      expect(rows[0].fromNodeNum).toBe(100);
      expect(rows[0].sourceId).toBe('src-1');
      expect(rows[1].sourceId).toBeNull();
    });

    it('recreates non-auto indexes', () => {
      migration.up(db);
      const idxs = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages' AND name NOT LIKE 'sqlite_autoindex_%'`)
        .all() as Array<{ name: string }>;
      const names = idxs.map((r) => r.name).sort();
      expect(names).toContain('idx_messages_from');
      expect(names).toContain('idx_messages_timestamp');
    });

    it('restores foreign_keys=ON after running', () => {
      migration.up(db);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('allows DELETE on messages after the rebuild', () => {
      migration.up(db);
      expect(() => db.prepare(`DELETE FROM messages WHERE sourceId IS NULL`).run()).not.toThrow();
      const remaining = db.prepare(`SELECT COUNT(*) c FROM messages`).get() as any;
      expect(remaining.c).toBe(1);
    });

    it('is idempotent — second run is a no-op', () => {
      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();
      expect(hasLegacyFk(db)).toBe(false);
    });
  });

  describe('baseline schema without FK', () => {
    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      createBaselineSchema(db);
      insertMessage(db, 'msg-1', 100, 200, 'src-1');
    });

    it('is a no-op when no legacy FK is present', () => {
      expect(hasLegacyFk(db)).toBe(false);
      migration.up(db);
      expect(hasLegacyFk(db)).toBe(false);
      const rows = db.prepare(`SELECT COUNT(*) c FROM messages`).get() as any;
      expect(rows.c).toBe(1);
    });
  });
});
