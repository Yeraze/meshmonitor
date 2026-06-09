/**
 * Migration 083 — Add spoof/impersonation flags to messages and packet_log
 * (issue #2584).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './083_add_spoof_suspected.js';

function columnNames(db: Database.Database, table: string): string[] {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.map((c) => c.name);
}

describe('Migration 083 — add spoof-suspected flags (SQLite)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Minimal stand-ins for the two target tables.
    db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, text TEXT);`);
    db.exec(`CREATE TABLE packet_log (id INTEGER PRIMARY KEY, from_node INTEGER);`);
  });

  it('adds spoofSuspected to messages and spoof_suspected to packet_log', () => {
    expect(columnNames(db, 'messages')).not.toContain('spoofSuspected');
    expect(columnNames(db, 'packet_log')).not.toContain('spoof_suspected');

    migration.up(db);

    expect(columnNames(db, 'messages')).toContain('spoofSuspected');
    expect(columnNames(db, 'packet_log')).toContain('spoof_suspected');
  });

  it('is idempotent — second run is a no-op', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    expect(columnNames(db, 'messages')).toContain('spoofSuspected');
    expect(columnNames(db, 'packet_log')).toContain('spoof_suspected');
  });

  it('the new columns default to falsey and round-trip a true value', () => {
    migration.up(db);

    db.prepare(`INSERT INTO messages (id, text) VALUES ('a', 'hi')`).run();
    const defaulted = db.prepare(`SELECT spoofSuspected FROM messages WHERE id = 'a'`).get() as any;
    expect(defaulted.spoofSuspected).toBe(0);

    db.prepare(`INSERT INTO messages (id, text, spoofSuspected) VALUES ('b', 'spoof', 1)`).run();
    const flagged = db.prepare(`SELECT spoofSuspected FROM messages WHERE id = 'b'`).get() as any;
    expect(flagged.spoofSuspected).toBe(1);
  });

  it('does not throw when a target table is missing (graceful skip)', () => {
    const bare = new Database(':memory:');
    bare.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY);`); // no packet_log
    expect(() => migration.up(bare)).not.toThrow();
    expect(columnNames(bare, 'messages')).toContain('spoofSuspected');
  });
});
