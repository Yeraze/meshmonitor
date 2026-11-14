/**
 * Migration 235 (#5729): mesh-wide notification rows and one Web Push
 * subscription per browser. The upgrade must leave nobody with a duplicate
 * subscription and nobody without one, and must not change any per-source
 * preference row.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration, planPushCollapse, mergePushSourceIds } from './235_unified_notification_scope.js';

const MESH = '__mesh__';

function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      source_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh_key TEXT NOT NULL,
      auth_key TEXT NOT NULL,
      user_agent TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE UNIQUE INDEX idx_push_subscriptions_user_endpoint_source ON push_subscriptions (user_id, endpoint, source_id);
    CREATE TABLE user_notification_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      enable_web_push INTEGER DEFAULT 1,
      enable_direct_messages INTEGER DEFAULT 1,
      enable_apprise INTEGER DEFAULT 1,
      notify_on_new_node INTEGER DEFAULT 1,
      notify_on_traceroute INTEGER DEFAULT 1,
      notify_on_inactive_node INTEGER DEFAULT 0,
      notify_on_low_battery INTEGER DEFAULT 0,
      notify_on_waypoint INTEGER DEFAULT 0,
      monitored_nodes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, source_id)
    );
  `);
}

function addSub(db: Database.Database, userId: number | null, sourceId: string, endpoint: string, updatedAt: number, key = 'k'): void {
  db.prepare(`INSERT INTO push_subscriptions (user_id, source_id, endpoint, p256dh_key, auth_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)`).run(userId, sourceId, endpoint, key, 'auth', updatedAt);
}

function subs(db: Database.Database) {
  return db.prepare(`SELECT user_id AS userId, source_id AS sourceId, endpoint, p256dh_key AS key
    FROM push_subscriptions ORDER BY user_id, endpoint`).all();
}

function meshRows(db: Database.Database) {
  return db.prepare(`SELECT user_id AS userId, push_source_ids AS pushSourceIds, mesh_defaults_saved AS saved,
      enable_web_push AS webPush, enable_apprise AS apprise, enable_direct_messages AS dm,
      notify_on_new_node AS newNode, notify_on_traceroute AS traceroute
    FROM user_notification_preferences WHERE source_id = ? ORDER BY user_id`).all(MESH);
}

/** One (user, endpoint) pair per browser, before the upgrade. */
function seed(db: Database.Database): void {
  addSub(db, 1, 'src-a', 'https://push/e1', 100, 'old');
  addSub(db, 1, 'src-b', 'https://push/e1', 200, 'new'); // same browser, newer keys
  addSub(db, 1, 'src-a', 'https://push/e2', 100);        // user 1's second browser
  addSub(db, 2, 'src-c', 'https://push/e1', 100);        // another user, same endpoint
  addSub(db, null, 'src-a', 'https://push/anon', 100);   // no user
  addSub(db, null, 'src-b', 'https://push/anon', 50);
}

describe('Migration 235 — unified notification scope (SQLite)', () => {
  it('adds the two mesh-row columns, idempotently', () => {
    const db = new Database(':memory:');
    createTables(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = db.prepare(`PRAGMA table_info(user_notification_preferences)`).all() as Array<{ name: string; dflt_value: unknown }>;
    expect(cols.filter(c => c.name === 'push_source_ids')).toHaveLength(1);
    expect(cols.find(c => c.name === 'mesh_defaults_saved')?.dflt_value).toBe('0');
    db.close();
  });

  it('leaves one subscription per (user, browser): no duplicate, nobody dropped', () => {
    const db = new Database(':memory:');
    createTables(db);
    seed(db);
    const pairsBefore = new Set((subs(db) as Array<{ userId: number | null; endpoint: string }>).map(r => `${r.userId}|${r.endpoint}`));

    migration.up(db);

    const after = subs(db) as Array<{ userId: number | null; sourceId: string; endpoint: string; key: string }>;
    expect(after.every(r => r.sourceId === MESH)).toBe(true);
    const pairsAfter = after.map(r => `${r.userId}|${r.endpoint}`);
    expect(new Set(pairsAfter).size).toBe(pairsAfter.length); // no duplicate
    expect(new Set(pairsAfter)).toEqual(pairsBefore);         // nobody dropped
    // The newest row of a browser is the one kept (freshest keys).
    expect(after.find(r => r.userId === 1 && r.endpoint === 'https://push/e1')?.key).toBe('new');
    db.close();
  });

  it('records each user\'s subscribed sources as their Web Push source list, opt-ins off', () => {
    const db = new Database(':memory:');
    createTables(db);
    seed(db);
    migration.up(db);

    expect(meshRows(db)).toEqual([
      { userId: 1, pushSourceIds: '["src-a","src-b"]', saved: 0, webPush: 0, apprise: 0, dm: 0, newNode: 0, traceroute: 0 },
      { userId: 2, pushSourceIds: '["src-c"]', saved: 0, webPush: 0, apprise: 0, dm: 0, newNode: 0, traceroute: 0 },
    ]);
    db.close();
  });

  it('does not touch per-source preference rows (they become overrides as they are)', () => {
    const db = new Database(':memory:');
    createTables(db);
    seed(db);
    db.prepare(`INSERT INTO user_notification_preferences (user_id, source_id, enable_web_push, notify_on_inactive_node, monitored_nodes, created_at, updated_at)
      VALUES (1, 'src-a', 1, 1, '["!aaaa"]', 5, 5)`).run();
    const before = db.prepare(`SELECT * FROM user_notification_preferences WHERE source_id = 'src-a'`).get();
    migration.up(db);
    expect(db.prepare(`SELECT * FROM user_notification_preferences WHERE source_id = 'src-a'`).get())
      .toEqual({ ...(before as object), push_source_ids: null, mesh_defaults_saved: 0 });
    db.close();
  });

  it('a second run changes nothing', () => {
    const db = new Database(':memory:');
    createTables(db);
    seed(db);
    migration.up(db);
    const subsOnce = subs(db);
    const meshOnce = meshRows(db);
    migration.up(db);
    expect(subs(db)).toEqual(subsOnce);
    expect(meshRows(db)).toEqual(meshOnce);
    db.close();
  });

  it('an existing mesh row keeps a NULL ("every source") list and widens a narrow one', () => {
    const db = new Database(':memory:');
    createTables(db);
    migration.up(db); // columns
    db.prepare(`INSERT INTO user_notification_preferences (user_id, source_id, push_source_ids, mesh_defaults_saved, created_at, updated_at)
      VALUES (1, ?, NULL, 1, 1, 1), (2, ?, '["src-a"]', 1, 1, 1)`).run(MESH, MESH);
    addSub(db, 1, 'src-b', 'https://push/x', 1);
    addSub(db, 2, 'src-b', 'https://push/y', 1);
    migration.up(db);
    const rows = db.prepare(`SELECT user_id AS userId, push_source_ids AS ids, mesh_defaults_saved AS saved
      FROM user_notification_preferences WHERE source_id = ? ORDER BY user_id`).all(MESH);
    expect(rows).toEqual([
      { userId: 1, ids: null, saved: 1 },
      { userId: 2, ids: '["src-a","src-b"]', saved: 1 },
    ]);
    db.close();
  });
});

describe('planPushCollapse / mergePushSourceIds', () => {
  it('keeps an already-relabelled row over a newer per-source one (an interrupted run)', () => {
    const plan = planPushCollapse([
      { id: 1, userId: 1, sourceId: MESH, endpoint: 'e', updatedAt: 1 },
      { id: 2, userId: 1, sourceId: 'src-a', endpoint: 'e', updatedAt: 9 },
    ]);
    expect(plan.deleteIds).toEqual([2]);
    expect(plan.relabelIds).toEqual([]);
    expect(plan.sourcesByUser.get(1)).toEqual(['src-a']);
  });

  it('breaks an updatedAt tie on the higher id, and never groups across users', () => {
    const plan = planPushCollapse([
      { id: 1, userId: 1, sourceId: 'a', endpoint: 'e', updatedAt: 5 },
      { id: 2, userId: 1, sourceId: 'b', endpoint: 'e', updatedAt: 5 },
      { id: 3, userId: 2, sourceId: 'a', endpoint: 'e', updatedAt: 5 },
    ]);
    expect(plan.deleteIds).toEqual([1]);
    expect(plan.relabelIds.sort()).toEqual([2, 3]);
  });

  it('merges lists: NULL stays NULL, a list only grows, no change is undefined', () => {
    expect(mergePushSourceIds(null, ['a'])).toBeUndefined();
    expect(mergePushSourceIds('["a"]', ['a'])).toBeUndefined();
    expect(mergePushSourceIds('["b"]', ['a'])).toBe('["a","b"]');
    expect(mergePushSourceIds('not json', ['a'])).toBe('["a"]');
  });
});
