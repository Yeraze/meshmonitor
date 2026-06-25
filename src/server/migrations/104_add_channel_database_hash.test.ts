/**
 * Migration 104 — Add channel_hash to channel_database (SQLite).
 *
 * PostgreSQL note: migration 104's PG path detects when channel_database has
 * accumulated ≥1500 column tombstones (caused by the migration 021/063
 * ADD/DROP cycle that ran on every startup in older releases) and rebuilds
 * the table from scratch before adding channelHash.  That logic requires a
 * live PostgreSQL connection and is exercised by integration tests; it is
 * not tested here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './104_add_channel_database_hash.js';

function columnNames(db: Database.Database, table: string): string[] {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.map((c) => c.name);
}

describe('Migration 104 — add channel_database.channel_hash (SQLite)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE channel_database (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      psk TEXT NOT NULL
    );`);
  });

  it('adds the channel_hash column', () => {
    expect(columnNames(db, 'channel_database')).not.toContain('channel_hash');
    migration.up(db);
    expect(columnNames(db, 'channel_database')).toContain('channel_hash');
  });

  it('is idempotent — second run is a no-op', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    expect(columnNames(db, 'channel_database')).toContain('channel_hash');
  });

  it('the new column defaults to NULL and round-trips a value', () => {
    migration.up(db);

    db.prepare(`INSERT INTO channel_database (name, psk) VALUES ('LongFast', 'AQ==')`).run();
    const defaulted = db.prepare(`SELECT channel_hash FROM channel_database WHERE name = 'LongFast'`).get() as any;
    expect(defaulted.channel_hash).toBeNull();

    db.prepare(`INSERT INTO channel_database (name, psk, channel_hash) VALUES ('Secret', '', 42)`).run();
    const stored = db.prepare(`SELECT channel_hash FROM channel_database WHERE name = 'Secret'`).get() as any;
    expect(stored.channel_hash).toBe(42);
  });
});
