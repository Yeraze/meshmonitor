import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { migration } from './213_backfill_traceroute_write_for_meshcore_trace.js';

/**
 * Migration 213 (#5898): MeshCore trace-path moved from nodes:write to
 * traceroute:write. Every (user, MeshCore source) with nodes:write must end
 * up with traceroute:write, and nothing else may change.
 */
describe('migration 213: backfill traceroute:write for MeshCore nodes:write holders', () => {
  let db: Database;

  const insertSource = (id: string, type: string) =>
    db.prepare(`INSERT INTO sources (id, type) VALUES (?, ?)`).run(id, type);

  const insertPermission = (
    userId: number,
    resource: string,
    sourceId: string | null,
    flags: { read?: 0 | 1; write?: 0 | 1; map?: 0 | 1 },
  ) =>
    db
      .prepare(
        `INSERT INTO permissions (user_id, resource, can_view_on_map, can_read, can_write, granted_at, sourceId)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, resource, flags.map ?? 0, flags.read ?? 0, flags.write ?? 0, 1, sourceId);

  const tracerouteRows = (userId: number, sourceId: string) =>
    db
      .prepare(
        `SELECT can_view_on_map, can_read, can_write FROM permissions
          WHERE user_id = ? AND resource = 'traceroute' AND sourceId = ?`,
      )
      .all(userId, sourceId) as Array<{ can_view_on_map: number; can_read: number; can_write: number }>;

  const snapshot = () => db.prepare(`SELECT * FROM permissions ORDER BY id`).all();

  beforeEach(() => {
    db = new DatabaseConstructor(':memory:');
    db.exec(`
      CREATE TABLE sources (id TEXT PRIMARY KEY, type TEXT NOT NULL);
      CREATE TABLE permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        resource TEXT NOT NULL,
        can_view_on_map INTEGER NOT NULL DEFAULT 0,
        can_read INTEGER NOT NULL DEFAULT 0,
        can_write INTEGER NOT NULL DEFAULT 0,
        granted_at INTEGER NOT NULL,
        granted_by INTEGER,
        sourceId TEXT
      );
      CREATE UNIQUE INDEX permissions_user_resource_source ON permissions (user_id, resource, sourceId);
    `);
    insertSource('mc-1', 'meshcore');
    insertSource('mc-2', 'meshcore');
    insertSource('mt-1', 'meshtastic_tcp');
  });

  it('inserts a write-only traceroute row when none exists', () => {
    insertPermission(10, 'nodes', 'mc-1', { read: 1, write: 1 });
    migration.up(db);
    expect(tracerouteRows(10, 'mc-1')).toEqual([{ can_view_on_map: 0, can_read: 0, can_write: 1 }]);
  });

  it('sets canWrite on an existing read-only traceroute row and keeps read', () => {
    insertPermission(10, 'nodes', 'mc-1', { write: 1 });
    insertPermission(10, 'traceroute', 'mc-1', { read: 1 });
    migration.up(db);
    expect(tracerouteRows(10, 'mc-1')).toEqual([{ can_view_on_map: 0, can_read: 1, can_write: 1 }]);
  });

  it('only grants on the source where the user has nodes:write', () => {
    insertPermission(10, 'nodes', 'mc-1', { write: 1 });
    insertPermission(10, 'nodes', 'mc-2', { read: 1 });
    insertPermission(10, 'traceroute', 'mc-2', { read: 1 });
    migration.up(db);
    expect(tracerouteRows(10, 'mc-1')[0].can_write).toBe(1);
    expect(tracerouteRows(10, 'mc-2')).toEqual([{ can_view_on_map: 0, can_read: 1, can_write: 0 }]);
  });

  it('ignores Meshtastic sources and global (NULL) nodes rows', () => {
    insertPermission(10, 'nodes', 'mt-1', { write: 1 });
    insertPermission(11, 'nodes', null, { write: 1 });
    const before = snapshot();
    migration.up(db);
    expect(snapshot()).toEqual(before);
  });

  it('does not grant when nodes is read-only', () => {
    insertPermission(10, 'nodes', 'mc-1', { read: 1 });
    migration.up(db);
    expect(tracerouteRows(10, 'mc-1')).toEqual([]);
  });

  it('never reduces an existing traceroute grant', () => {
    insertPermission(10, 'nodes', 'mc-1', { write: 1 });
    insertPermission(10, 'traceroute', 'mc-1', { read: 1, write: 1, map: 1 });
    const before = snapshot();
    migration.up(db);
    expect(snapshot()).toEqual(before);
  });

  it('is idempotent', () => {
    insertPermission(10, 'nodes', 'mc-1', { write: 1 });
    insertPermission(12, 'nodes', 'mc-2', { write: 1 });
    insertPermission(12, 'traceroute', 'mc-2', { read: 1 });
    migration.up(db);
    const once = snapshot();
    migration.up(db);
    expect(snapshot()).toEqual(once);
  });
});
