/**
 * Migration 064 — Backfill global `channel_database` permission for admins.
 *
 * SQLite-only test. PostgreSQL / MySQL paths share the same shape and are
 * exercised by the integration suite. Asserts:
 *   - admins receive exactly one global `channel_database` grant with
 *     canRead=1, canWrite=1, sourceId=NULL
 *   - non-admin users receive nothing
 *   - re-running the migration does not create duplicates
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './064_add_channel_database_permission.js';

function createSchema(db: Database.Database) {
  // users + permissions schemas match the post-033 shape: snake_case columns,
  // no CHECK constraint on resource, sourceId column present, and a unique
  // index on (user_id, resource, sourceId).
  db.exec(`
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
    CREATE UNIQUE INDEX permissions_user_resource_source_uniq
      ON permissions(user_id, resource, sourceId);
  `);
}

function insertUser(db: Database.Database, username: string, isAdmin: boolean): number {
  const result = db
    .prepare(`INSERT INTO users (username, is_admin, created_at) VALUES (?, ?, ?)`)
    .run(username, isAdmin ? 1 : 0, Date.now());
  return result.lastInsertRowid as number;
}

describe('Migration 064 — backfill channel_database permission for admins', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('grants admins a global channel_database row with read+write', () => {
    const adminId = insertUser(db, 'admin', true);

    migration.up(db);

    const rows = db
      .prepare(
        `SELECT user_id, resource, can_read, can_write, can_view_on_map, can_delete, sourceId
           FROM permissions
          WHERE user_id = ? AND resource = 'channel_database'`,
      )
      .all(adminId) as Array<{
      user_id: number;
      resource: string;
      can_read: number;
      can_write: number;
      can_view_on_map: number;
      can_delete: number;
      sourceId: string | null;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].can_read).toBe(1);
    expect(rows[0].can_write).toBe(1);
    expect(rows[0].can_view_on_map).toBe(0);
    expect(rows[0].can_delete).toBe(0);
    expect(rows[0].sourceId).toBeNull();
  });

  it('does not grant channel_database to non-admin users', () => {
    insertUser(db, 'alice', false);
    insertUser(db, 'bob', false);

    migration.up(db);

    const rows = db
      .prepare(`SELECT 1 FROM permissions WHERE resource = 'channel_database'`)
      .all();
    expect(rows).toHaveLength(0);
  });

  it('is idempotent across re-runs', () => {
    insertUser(db, 'admin1', true);
    insertUser(db, 'admin2', true);
    insertUser(db, 'regular', false);

    migration.up(db);
    const after1 = db
      .prepare(`SELECT COUNT(*) as c FROM permissions WHERE resource = 'channel_database'`)
      .get() as { c: number };
    expect(after1.c).toBe(2);

    migration.up(db);
    const after2 = db
      .prepare(`SELECT COUNT(*) as c FROM permissions WHERE resource = 'channel_database'`)
      .get() as { c: number };
    expect(after2.c).toBe(2);
  });

  it('preserves an existing custom grant without duplicating it', () => {
    const adminId = insertUser(db, 'admin', true);
    // Pre-existing manual grant — only canRead, no canWrite (atypical, but
    // simulates a future state where an admin's row was downgraded).
    db.prepare(
      `INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at, sourceId)
         VALUES (?, 'channel_database', 1, 0, ?, NULL)`,
    ).run(adminId, Date.now());

    migration.up(db);

    const rows = db
      .prepare(
        `SELECT can_read, can_write FROM permissions
          WHERE user_id = ? AND resource = 'channel_database' AND sourceId IS NULL`,
      )
      .all(adminId) as Array<{ can_read: number; can_write: number }>;

    expect(rows).toHaveLength(1);
    // Existing row preserved as-is — migration only inserts when no row exists.
    expect(rows[0].can_read).toBe(1);
    expect(rows[0].can_write).toBe(0);
  });
});
