/**
 * Migration 033 — per-source permissions expansion. SQLite-only test.
 *
 * Regression for #3657: 033 backfills `channel_database.sourceId`, but
 * channel_database is global-by-design — migration 021 no longer adds that
 * column and migration 063 drops it. On PostgreSQL (which re-runs every
 * migration on every boot) and on fresh installs, the column is absent when 033
 * runs, so the unguarded `UPDATE channel_database SET sourceId ...` crashed with
 * `column "sourceId" does not exist`. The crash only surfaces when at least one
 * source is registered (the backfill is gated on `sources.length > 0`), which is
 * why the CI fixtures — having no sources — never caught it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './033_per_source_permissions.js';

/** Pre-033 schema with permissions already in the post-rebuild shape (named
 *  sourceId column, no old inline UNIQUE) so 033 skips the table rebuild. */
function createBaseSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      resource TEXT NOT NULL,
      can_view_on_map INTEGER NOT NULL DEFAULT 0,
      can_read INTEGER NOT NULL DEFAULT 0,
      can_write INTEGER NOT NULL DEFAULT 0,
      can_delete INTEGER NOT NULL DEFAULT 0,
      granted_at INTEGER NOT NULL,
      granted_by INTEGER,
      sourceId TEXT
    );
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('Migration 033 — channel_database backfill guard (#3657)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createBaseSchema(db);
    db.prepare(`INSERT INTO sources (id, name) VALUES (?, ?)`).run('src-a', 'Source A');
  });

  it('does NOT throw when channel_database has no sourceId column and a source exists', () => {
    // The #3657 condition: channel_database without sourceId (post-021-fix / post-063).
    db.exec(`CREATE TABLE channel_database (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, psk TEXT)`);
    db.prepare(`INSERT INTO channel_database (name, psk) VALUES (?, ?)`).run('LongFast', 'AQ==');

    expect(() => migration.up(db)).not.toThrow();
    // The guard skipped the backfill; the column was never (re)introduced.
    expect(columnNames(db, 'channel_database')).not.toContain('sourceId');
  });

  it('still backfills channel_database.sourceId when the legacy column is present', () => {
    // Back-compat: a mid-upgrade DB where 021 had added sourceId and 063 has not
    // yet dropped it. The backfill must still run.
    db.exec(`CREATE TABLE channel_database (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, psk TEXT, sourceId TEXT)`);
    db.prepare(`INSERT INTO channel_database (name, psk, sourceId) VALUES (?, ?, NULL)`).run('LongFast', 'AQ==');

    expect(() => migration.up(db)).not.toThrow();
    const row = db.prepare(`SELECT sourceId FROM channel_database WHERE name = 'LongFast'`).get() as { sourceId: string | null };
    expect(row.sourceId).toBe('src-a');
  });

  it('does not throw with no sources registered (channel_database column absent)', () => {
    db.exec(`DELETE FROM sources`);
    db.exec(`CREATE TABLE channel_database (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, psk TEXT)`);
    expect(() => migration.up(db)).not.toThrow();
  });
});
