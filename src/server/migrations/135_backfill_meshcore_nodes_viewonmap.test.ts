import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { migration } from './135_backfill_meshcore_nodes_viewonmap.js';

/**
 * Migration 135 (issue #4559): buildSourceNodes() is being fixed to require
 * nodes:viewOnMap (not just nodes:read) before publishing MeshCore contact
 * positions on the map. Without this backfill, every existing `nodes` grant
 * has canViewOnMap=false (the admin UI never exposed a control to set it for
 * `nodes`), so the fix would silently blank every MeshCore map that works
 * today. This migration sets canViewOnMap=true on existing `nodes` grants for
 * meshcore-typed sources that already have canRead=true.
 */
describe('migration 135: backfill canViewOnMap on meshcore nodes grants', () => {
  let db: Database;

  const insertSource = (id: string, type: string) =>
    db.prepare(`INSERT INTO sources (id, type) VALUES (?, ?)`).run(id, type);

  const insertPermission = (
    userId: number,
    resource: string,
    sourceId: string | null,
    canRead: 0 | 1,
    canViewOnMap: 0 | 1,
  ) =>
    db
      .prepare(
        `INSERT INTO permissions (user_id, resource, can_view_on_map, can_read, can_write, granted_at, sourceId)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(userId, resource, canViewOnMap, canRead, Date.now(), sourceId);

  const viewOnMapFor = (userId: number, sourceId: string) =>
    (db
      .prepare(`SELECT can_view_on_map FROM permissions WHERE user_id = ? AND resource = 'nodes' AND sourceId = ?`)
      .get(userId, sourceId) as { can_view_on_map: number } | undefined)?.can_view_on_map;

  beforeEach(() => {
    db = new DatabaseConstructor(':memory:');
    db.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL
      );
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
    `);
  });

  it('sets canViewOnMap=true on a meshcore nodes:read grant', () => {
    insertSource('mc-1', 'meshcore');
    insertPermission(10, 'nodes', 'mc-1', 1, 0);

    migration.up(db);

    expect(viewOnMapFor(10, 'mc-1')).toBe(1);
  });

  it('leaves a meshtastic nodes:read grant untouched', () => {
    insertSource('mt-1', 'meshtastic_tcp');
    insertPermission(10, 'nodes', 'mt-1', 1, 0);

    migration.up(db);

    expect(viewOnMapFor(10, 'mt-1')).toBe(0);
  });

  it('does not grant viewOnMap when canRead is false', () => {
    insertSource('mc-1', 'meshcore');
    insertPermission(10, 'nodes', 'mc-1', 0, 0);

    migration.up(db);

    expect(viewOnMapFor(10, 'mc-1')).toBe(0);
  });

  it('leaves other resources (e.g. messages) untouched', () => {
    insertSource('mc-1', 'meshcore');
    insertPermission(10, 'messages', 'mc-1', 1, 0);

    migration.up(db);

    expect(
      (db.prepare(`SELECT can_view_on_map FROM permissions WHERE resource = 'messages'`).get() as any)
        .can_view_on_map,
    ).toBe(0);
  });

  it('is idempotent — a second run does not throw and leaves state unchanged', () => {
    insertSource('mc-1', 'meshcore');
    insertPermission(10, 'nodes', 'mc-1', 1, 0);

    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    expect(viewOnMapFor(10, 'mc-1')).toBe(1);
  });

  it('does not touch a grant that already has viewOnMap set (no-op, not an error)', () => {
    insertSource('mc-1', 'meshcore');
    insertPermission(10, 'nodes', 'mc-1', 1, 1);

    expect(() => migration.up(db)).not.toThrow();
    expect(viewOnMapFor(10, 'mc-1')).toBe(1);
  });
});
