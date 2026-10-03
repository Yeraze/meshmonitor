/**
 * Tests for migration 192 — `channel_database.protocol` (#5552).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './192_add_channel_database_protocol.js';

function createTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE channel_database (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      psk TEXT NOT NULL,
      psk_length INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

describe('Migration 192 — channel_database.protocol', () => {
  it('adds a NOT NULL column defaulting to meshtastic and is idempotent', () => {
    const db = new Database(':memory:');
    createTable(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const col = (db.prepare('PRAGMA table_info(channel_database)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>)
      .find((c) => c.name === 'protocol');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(1);
    expect(col!.dflt_value).toBe("'meshtastic'");
    db.close();
  });

  it('marks every existing row meshtastic and accepts a meshcore row', () => {
    const db = new Database(':memory:');
    createTable(db);
    db.prepare(`INSERT INTO channel_database (name, psk, psk_length, created_at, updated_at) VALUES ('old', 'AQ==', 1, 1, 1)`).run();
    migration.up(db);
    db.prepare(`INSERT INTO channel_database (name, psk, psk_length, protocol, created_at, updated_at) VALUES ('mc', 'x', 16, 'meshcore', 1, 1)`).run();
    db.prepare(`INSERT INTO channel_database (name, psk, psk_length, created_at, updated_at) VALUES ('new', 'AQ==', 1, 1, 1)`).run();
    expect(db.prepare(`SELECT name, protocol FROM channel_database ORDER BY id`).all()).toEqual([
      { name: 'old', protocol: 'meshtastic' },
      { name: 'mc', protocol: 'meshcore' },
      { name: 'new', protocol: 'meshtastic' },
    ]);
    db.close();
  });
});
