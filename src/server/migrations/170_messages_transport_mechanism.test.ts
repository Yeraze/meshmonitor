/**
 * Tests for migration 170 — `messages.transportMechanism` column (#5101).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './170_messages_transport_mechanism.js';

/** A minimal `messages` table without the transportMechanism column. */
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
      viaMqtt INTEGER,
      timestamp INTEGER NOT NULL,
      createdAt INTEGER NOT NULL DEFAULT 0
    )
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('Migration 170 — messages.transportMechanism (SQLite)', () => {
  it('adds transportMechanism and is idempotent (second up() does not throw)', () => {
    const db = new Database(':memory:');
    createParentTable(db);

    expect(columnNames(db, 'messages')).not.toContain('transportMechanism');

    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    expect(columnNames(db, 'messages')).toContain('transportMechanism');

    db.close();
  });

  it('an existing row reads NULL, and an explicit 0 (INTERNAL) round-trips as 0, not NULL', () => {
    const db = new Database(':memory:');
    createParentTable(db);
    db.prepare(`
      INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, timestamp, createdAt)
      VALUES ('msg-1', 1, 2, '!00000001', '!00000002', 'hi', 1000, 1000)
    `).run();

    migration.up(db);

    const before = db.prepare(`SELECT * FROM messages WHERE id = 'msg-1'`).get() as Record<string, unknown>;
    expect(before.transportMechanism).toBeNull();

    db.prepare(`UPDATE messages SET transportMechanism = 0 WHERE id = 'msg-1'`).run();
    const after = db.prepare(`SELECT * FROM messages WHERE id = 'msg-1'`).get() as Record<string, unknown>;
    expect(after.transportMechanism).toBe(0);

    db.close();
  });
});
