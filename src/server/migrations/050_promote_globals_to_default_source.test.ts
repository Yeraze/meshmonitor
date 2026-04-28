/**
 * Migration 050 — Promote legacy global per-source settings (and orphan
 * NULL-sourceId rows in auto_traceroute_nodes / auto_time_sync_nodes) to the
 * default source's namespace. Validates the upgrade path that keeps
 * single-source pre-4.x users' configuration after the global fallback in
 * `getSettingForSource` is removed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './050_promote_globals_to_default_source.js';

function createSchema(db: Database.Database) {
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
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE auto_traceroute_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nodeNum INTEGER NOT NULL,
      enabled INTEGER DEFAULT 1,
      createdAt INTEGER NOT NULL,
      sourceId TEXT
    );
    CREATE TABLE auto_time_sync_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nodeNum INTEGER NOT NULL,
      enabled INTEGER DEFAULT 1,
      createdAt INTEGER NOT NULL,
      sourceId TEXT
    );
  `);
}

function insertSource(db: Database.Database, id: string, createdAt: number) {
  db.prepare(`
    INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
    VALUES (?, ?, 'meshtastic_tcp', '{}', 1, ?, ?)
  `).run(id, `Source ${id}`, createdAt, createdAt);
}

function insertSetting(db: Database.Database, key: string, value: string) {
  const ts = Date.now();
  db.prepare(`INSERT INTO settings (key, value, createdAt, updatedAt) VALUES (?, ?, ?, ?)`).run(key, value, ts, ts);
}

function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

describe('Migration 050 — promote globals to default source', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('promotes legacy global per-source keys into source:{defaultId}: namespace', () => {
    insertSource(db, 'src-old', 1000);
    insertSource(db, 'src-new', 2000);
    insertSetting(db, 'autoResponderEnabled', 'true');
    insertSetting(db, 'autoResponderTriggers', '[{"trigger":"hi","response":"hello"}]');
    insertSetting(db, 'tracerouteIntervalMinutes', '30');

    migration.up(db);

    expect(getSetting(db, 'source:src-old:autoResponderEnabled')).toBe('true');
    expect(getSetting(db, 'source:src-old:autoResponderTriggers')).toBe('[{"trigger":"hi","response":"hello"}]');
    expect(getSetting(db, 'source:src-old:tracerouteIntervalMinutes')).toBe('30');
    // The newer source must NOT inherit
    expect(getSetting(db, 'source:src-new:autoResponderEnabled')).toBeNull();
    expect(getSetting(db, 'source:src-new:tracerouteIntervalMinutes')).toBeNull();
  });

  it('preserves the original global value (non-destructive)', () => {
    insertSource(db, 'src-old', 1000);
    insertSetting(db, 'autoResponderEnabled', 'true');

    migration.up(db);

    expect(getSetting(db, 'autoResponderEnabled')).toBe('true');
  });

  it('does NOT overwrite an existing per-source override', () => {
    insertSource(db, 'src-old', 1000);
    insertSetting(db, 'autoResponderEnabled', 'true'); // legacy global
    insertSetting(db, 'source:src-old:autoResponderEnabled', 'false'); // user already saved per-source

    migration.up(db);

    expect(getSetting(db, 'source:src-old:autoResponderEnabled')).toBe('false');
  });

  it('skips keys that have no global value', () => {
    insertSource(db, 'src-old', 1000);
    // No globals set at all

    migration.up(db);

    // Migration should run cleanly with no per-source keys created
    const rows = db
      .prepare(`SELECT key FROM settings WHERE key LIKE 'source:%'`)
      .all() as Array<{ key: string }>;
    expect(rows).toHaveLength(0);
  });

  it('is idempotent — re-running does not duplicate or change data', () => {
    insertSource(db, 'src-old', 1000);
    insertSetting(db, 'autoResponderEnabled', 'true');

    migration.up(db);
    migration.up(db);

    const rows = db
      .prepare(`SELECT key, value FROM settings WHERE key = 'source:src-old:autoResponderEnabled'`)
      .all() as Array<{ key: string; value: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('true');
  });

  it('backfills NULL-sourceId rows in auto_traceroute_nodes to the default source', () => {
    insertSource(db, 'src-old', 1000);
    insertSource(db, 'src-new', 2000);
    const ts = Date.now();
    db.prepare(`INSERT INTO auto_traceroute_nodes (nodeNum, createdAt, sourceId) VALUES (?, ?, ?)`).run(0xdeadbeef, ts, null);
    db.prepare(`INSERT INTO auto_traceroute_nodes (nodeNum, createdAt, sourceId) VALUES (?, ?, ?)`).run(0xcafebabe, ts, null);
    db.prepare(`INSERT INTO auto_traceroute_nodes (nodeNum, createdAt, sourceId) VALUES (?, ?, ?)`).run(0x12345678, ts, 'src-new');

    migration.up(db);

    const rows = db.prepare(`SELECT nodeNum, sourceId FROM auto_traceroute_nodes ORDER BY nodeNum`).all() as Array<{ nodeNum: number; sourceId: string | null }>;
    expect(rows).toHaveLength(3);
    const oldSrcRows = rows.filter((r) => r.sourceId === 'src-old');
    const newSrcRows = rows.filter((r) => r.sourceId === 'src-new');
    expect(oldSrcRows).toHaveLength(2);
    expect(newSrcRows).toHaveLength(1);
    // No NULL sourceIds remain
    expect(rows.every((r) => r.sourceId !== null)).toBe(true);
  });

  it('backfills NULL-sourceId rows in auto_time_sync_nodes to the default source', () => {
    insertSource(db, 'src-old', 1000);
    const ts = Date.now();
    db.prepare(`INSERT INTO auto_time_sync_nodes (nodeNum, createdAt, sourceId) VALUES (?, ?, ?)`).run(0xdeadbeef, ts, null);

    migration.up(db);

    const row = db.prepare(`SELECT sourceId FROM auto_time_sync_nodes WHERE nodeNum = ?`).get(0xdeadbeef) as { sourceId: string };
    expect(row.sourceId).toBe('src-old');
  });

  it('synthesizes a default source when sources table is empty', () => {
    insertSetting(db, 'autoResponderEnabled', 'true');

    migration.up(db);

    const sources = db.prepare(`SELECT id FROM sources`).all() as Array<{ id: string }>;
    expect(sources).toHaveLength(1);
    const id = sources[0].id;
    expect(getSetting(db, `source:${id}:autoResponderEnabled`)).toBe('true');
  });
});
