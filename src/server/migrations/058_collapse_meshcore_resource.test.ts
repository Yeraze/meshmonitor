/**
 * Migration 058 — Collapse the global `meshcore` permission resource into
 * per-source rows on the sourcey set (connection / configuration / nodes /
 * messages). SQLite-only test; the Postgres / MySQL paths share the same
 * shape and are exercised by the integration suite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './058_collapse_meshcore_resource.js';

const TARGET_RESOURCES = ['connection', 'configuration', 'nodes', 'messages'] as const;

function createSchema(db: Database.Database) {
  // permissions schema matches the post-033 shape (no CHECK constraint, with
  // sourceId column + the unique index 033 added).
  db.exec(`
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      createdBy INTEGER
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

function insertSource(db: Database.Database, id: string, type: string) {
  const ts = Date.now();
  db.prepare(
    `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt) VALUES (?, ?, ?, '{}', 1, ?, ?)`,
  ).run(id, `src-${id}`, type, ts, ts);
}

function insertGlobalMeshcoreGrant(db: Database.Database, userId: number, opts: { read?: boolean; write?: boolean } = {}) {
  db.prepare(
    `INSERT INTO permissions (user_id, resource, can_read, can_write, granted_at) VALUES (?, 'meshcore', ?, ?, ?)`,
  ).run(userId, opts.read ? 1 : 0, opts.write ? 1 : 0, Date.now());
}

describe('Migration 058 — collapse meshcore resource', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('expands a global meshcore grant into per-source rows on every target resource', () => {
    insertSource(db, 'mc-A', 'meshcore');
    insertSource(db, 'mc-B', 'meshcore');
    insertSource(db, 'mt-1', 'meshtastic');
    insertGlobalMeshcoreGrant(db, 42, { read: true, write: true });

    migration.up(db);

    // Expect 4 resources × 2 meshcore sources = 8 rows for user 42
    const rows = db
      .prepare(
        `SELECT resource, sourceId, can_read, can_write FROM permissions WHERE user_id = 42 ORDER BY resource, sourceId`,
      )
      .all() as Array<{ resource: string; sourceId: string; can_read: number; can_write: number }>;

    expect(rows).toHaveLength(TARGET_RESOURCES.length * 2);
    const sourceIds = new Set(rows.map((r) => r.sourceId));
    expect(sourceIds).toEqual(new Set(['mc-A', 'mc-B']));
    const resources = new Set(rows.map((r) => r.resource));
    expect(resources).toEqual(new Set(TARGET_RESOURCES));
    expect(rows.every((r) => r.can_read === 1 && r.can_write === 1)).toBe(true);
  });

  it('drops the original global meshcore rows', () => {
    insertSource(db, 'mc-A', 'meshcore');
    insertGlobalMeshcoreGrant(db, 42, { read: true });

    migration.up(db);

    const remaining = db
      .prepare(`SELECT 1 FROM permissions WHERE resource = 'meshcore'`)
      .all();
    expect(remaining).toHaveLength(0);
  });

  it('skips non-meshcore source types', () => {
    insertSource(db, 'mt-1', 'meshtastic');
    insertGlobalMeshcoreGrant(db, 42, { read: true });

    migration.up(db);

    const rows = db
      .prepare(`SELECT 1 FROM permissions WHERE user_id = 42 AND sourceId = 'mt-1'`)
      .all();
    expect(rows).toHaveLength(0);
  });

  it('still drops global meshcore rows when no meshcore sources exist', () => {
    insertGlobalMeshcoreGrant(db, 42, { read: true });

    migration.up(db);

    const rows = db.prepare(`SELECT 1 FROM permissions WHERE user_id = 42`).all();
    expect(rows).toHaveLength(0);
  });

  it('is idempotent across re-runs', () => {
    insertSource(db, 'mc-A', 'meshcore');
    insertGlobalMeshcoreGrant(db, 42, { read: true, write: true });

    migration.up(db);
    const after1 = db.prepare(`SELECT COUNT(*) as c FROM permissions`).get() as { c: number };

    migration.up(db);
    const after2 = db.prepare(`SELECT COUNT(*) as c FROM permissions`).get() as { c: number };

    expect(after2.c).toBe(after1.c);
  });

  it('preserves canRead/canWrite distinct from each other', () => {
    insertSource(db, 'mc-A', 'meshcore');
    insertGlobalMeshcoreGrant(db, 42, { read: true, write: false });

    migration.up(db);

    const rows = db
      .prepare(`SELECT can_read, can_write FROM permissions WHERE user_id = 42`)
      .all() as Array<{ can_read: number; can_write: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.can_read === 1 && r.can_write === 0)).toBe(true);
  });
});
