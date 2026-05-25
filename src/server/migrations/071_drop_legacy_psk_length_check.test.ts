/**
 * Migration 071 — Drop legacy `CHECK (psk_length IN (16, 32))` from SQLite
 * `channel_database`.
 *
 * Asserts:
 *   - on a database created with the legacy CHECK, the migration rebuilds
 *     the table and the constraint is gone (pskLength = 1 now inserts).
 *   - existing rows + ids are preserved across the rebuild.
 *   - on a database without the CHECK (v3.7+ baseline), the migration is a
 *     no-op and leaves the table untouched.
 *   - re-running is idempotent (second pass is a no-op).
 *   - PG / MySQL paths are no-ops (no constraint to drop there).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  migration,
  runMigration071Postgres,
  runMigration071Mysql,
} from './071_drop_legacy_psk_length_check.js';

function createUsersTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
  `);
}

// Mirrors the pre-v3.7 `channel_database` schema, including the legacy
// CHECK constraints removed by the v3.7 baseline.
function createLegacyChannelDatabase(db: Database.Database) {
  db.exec(`
    CREATE TABLE channel_database (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      psk TEXT NOT NULL,
      psk_length INTEGER NOT NULL,
      description TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      enforce_name_validation INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      decrypted_packet_count INTEGER NOT NULL DEFAULT 0,
      last_decrypted_at INTEGER,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      CHECK (is_enabled IN (0, 1)),
      CHECK (psk_length IN (16, 32))
    );
  `);
}

// Mirrors the v3.7 baseline shape — no CHECK constraints on psk_length.
function createBaselineChannelDatabase(db: Database.Database) {
  db.exec(`
    CREATE TABLE channel_database (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      psk TEXT NOT NULL,
      psk_length INTEGER NOT NULL,
      description TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      enforce_name_validation INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      decrypted_packet_count INTEGER NOT NULL DEFAULT 0,
      last_decrypted_at INTEGER,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
  `);
}

function getChannelDatabaseSql(db: Database.Database): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='channel_database'`)
    .get() as { sql?: string } | undefined;
  return row?.sql ?? '';
}

describe('Migration 071 — drop legacy psk_length CHECK constraint', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createUsersTable(db);
  });

  it('rebuilds a legacy table and removes the CHECK constraint', () => {
    createLegacyChannelDatabase(db);

    // Sanity check: legacy table rejects pskLength = 1 before the migration.
    expect(() =>
      db
        .prepare(
          `INSERT INTO channel_database (name, psk, psk_length, created_at, updated_at)
             VALUES ('LongFast', 'AQ==', 1, 0, 0)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);

    migration.up(db);

    const sql = getChannelDatabaseSql(db);
    expect(sql).not.toMatch(/psk_length IN \(16, 32\)/);
    expect(sql).not.toMatch(/CHECK\s*\([^)]*psk_length/i);

    // Now the AQ== bootstrap insert succeeds.
    const now = Date.now();
    expect(() =>
      db
        .prepare(
          `INSERT INTO channel_database (name, psk, psk_length, created_at, updated_at)
             VALUES ('LongFast', 'AQ==', 1, ?, ?)`,
        )
        .run(now, now),
    ).not.toThrow();

    const row = db
      .prepare(`SELECT name, psk, psk_length FROM channel_database WHERE name = 'LongFast'`)
      .get() as { name: string; psk: string; psk_length: number };
    expect(row).toEqual({ name: 'LongFast', psk: 'AQ==', psk_length: 1 });
  });

  it('preserves existing rows + ids across the rebuild', () => {
    createLegacyChannelDatabase(db);

    // Two valid pre-migration rows; legacy constraint allows pskLength 16/32.
    const now = Date.now();
    db.prepare(
      `INSERT INTO channel_database (id, name, psk, psk_length, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(5, 'admin', 'a'.repeat(24), 16, now, now);
    db.prepare(
      `INSERT INTO channel_database (id, name, psk, psk_length, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(8, 'secret', 'b'.repeat(44), 32, now, now);

    migration.up(db);

    const rows = db
      .prepare(`SELECT id, name, psk_length FROM channel_database ORDER BY id`)
      .all() as Array<{ id: number; name: string; psk_length: number }>;
    expect(rows).toEqual([
      { id: 5, name: 'admin', psk_length: 16 },
      { id: 8, name: 'secret', psk_length: 32 },
    ]);
  });

  it('is a no-op on a v3.7 baseline table', () => {
    createBaselineChannelDatabase(db);
    const before = getChannelDatabaseSql(db);

    migration.up(db);

    const after = getChannelDatabaseSql(db);
    expect(after).toBe(before);
  });

  it('is idempotent — second run after a rebuild is a no-op', () => {
    createLegacyChannelDatabase(db);
    migration.up(db);
    const afterFirst = getChannelDatabaseSql(db);

    migration.up(db);
    const afterSecond = getChannelDatabaseSql(db);
    expect(afterSecond).toBe(afterFirst);
  });

  it('handles legacy schemas missing later-added columns', () => {
    // Some very early pre-v3.7 schemas lacked enforce_name_validation /
    // sort_order. The rebuild should still succeed and create the column
    // with its default value.
    db.exec(`
      CREATE TABLE channel_database (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        psk TEXT NOT NULL,
        psk_length INTEGER NOT NULL,
        description TEXT,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        decrypted_packet_count INTEGER NOT NULL DEFAULT 0,
        last_decrypted_at INTEGER,
        created_by INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (psk_length IN (16, 32))
      );
    `);
    db.prepare(
      `INSERT INTO channel_database (id, name, psk, psk_length, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(1, 'old', 'x'.repeat(24), 16, 0, 0);

    expect(() => migration.up(db)).not.toThrow();

    const row = db
      .prepare(
        `SELECT id, name, psk_length, enforce_name_validation, sort_order FROM channel_database`,
      )
      .get() as Record<string, number | string>;
    expect(row.id).toBe(1);
    expect(row.name).toBe('old');
    expect(row.psk_length).toBe(16);
    expect(row.enforce_name_validation).toBe(0);
    expect(row.sort_order).toBe(0);
  });

  it('PostgreSQL and MySQL paths are no-ops', async () => {
    // Both paths should resolve without touching anything — they accept a
    // bogus client/pool because they never call into it.
    await expect(runMigration071Postgres({} as unknown as never)).resolves.toBeUndefined();
    await expect(runMigration071Mysql({} as unknown as never)).resolves.toBeUndefined();
  });
});
