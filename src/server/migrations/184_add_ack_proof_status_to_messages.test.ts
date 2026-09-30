/**
 * Tests for migration 184 — `messages.ackProofStatus` column (#5279).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './184_add_ack_proof_status_to_messages.js';

/** A minimal `messages` table without the ackProofStatus column. */
function createParentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      fromNodeNum INTEGER NOT NULL,
      toNodeNum INTEGER NOT NULL,
      fromNodeId TEXT NOT NULL,
      toNodeId TEXT NOT NULL,
      text TEXT NOT NULL,
      channel INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      createdAt INTEGER NOT NULL DEFAULT 0
    )
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('Migration 184 — messages.ackProofStatus (SQLite)', () => {
  it('adds ackProofStatus and is idempotent (second up() does not throw)', () => {
    const db = new Database(':memory:');
    createParentTable(db);
    expect(columnNames(db, 'messages')).not.toContain('ackProofStatus');

    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    expect(columnNames(db, 'messages')).toContain('ackProofStatus');
    db.close();
  });

  it('existing rows read NULL, and ABSENT (0) round-trips as 0, not NULL', () => {
    const db = new Database(':memory:');
    createParentTable(db);
    db.prepare(`
      INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, channel, timestamp, createdAt)
      VALUES ('msg-1', 1, 2, '!00000001', '!00000002', 'hi', -1, 1000, 1000)
    `).run();

    migration.up(db);

    const before = db.prepare(`SELECT ackProofStatus FROM messages WHERE id = 'msg-1'`).get() as Record<string, unknown>;
    expect(before.ackProofStatus).toBeNull();

    db.prepare(`UPDATE messages SET ackProofStatus = 0 WHERE id = 'msg-1'`).run();
    const zero = db.prepare(`SELECT ackProofStatus FROM messages WHERE id = 'msg-1'`).get() as Record<string, unknown>;
    expect(zero.ackProofStatus).toBe(0);

    db.prepare(`UPDATE messages SET ackProofStatus = 2 WHERE id = 'msg-1'`).run();
    const invalid = db.prepare(`SELECT ackProofStatus FROM messages WHERE id = 'msg-1'`).get() as Record<string, unknown>;
    expect(invalid.ackProofStatus).toBe(2);
    db.close();
  });
});
