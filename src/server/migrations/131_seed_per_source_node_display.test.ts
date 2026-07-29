/**
 * Migration 131 — seed per-source Node Display settings (#4412 Phase 1 WP4).
 *
 * Covers the pure `computeSeedInserts()` function plus the real SQLite `up()`
 * against an in-memory better-sqlite3 database, following the DDL bootstrap
 * pattern used by 130_add_waypoint_channel.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  migration,
  computeSeedInserts,
  NODE_DISPLAY_SEED,
} from './131_seed_per_source_node_display.js';

const TEN_KEYS = NODE_DISPLAY_SEED.map(([key]) => key);

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
  `);
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
}

function insertSource(db: Database.Database, id: string) {
  const ts = Date.now();
  db.prepare(`
    INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
    VALUES (?, ?, 'meshtastic_tcp', '{}', 1, ?, ?)
  `).run(id, id, ts, ts);
}

function insertSetting(db: Database.Database, key: string, value: string) {
  const ts = Date.now();
  db.prepare(`
    INSERT INTO settings (key, value, createdAt, updatedAt) VALUES (?, ?, ?, ?)
  `).run(key, value, ts, ts);
}

function settingsMap(db: Database.Database): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>;
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

describe('computeSeedInserts (pure)', () => {
  it('returns [] for no sources', () => {
    expect(computeSeedInserts([], {})).toEqual([]);
  });

  it('produces 20 default rows for two sources with no globals', () => {
    const rows = computeSeedInserts(['s1', 's2'], {});
    expect(rows).toHaveLength(20);
    const bySourceAndKey = new Map(rows.map((r) => [r.key, r.value]));
    for (const [key, fallback] of NODE_DISPLAY_SEED) {
      expect(bySourceAndKey.get(`source:s1:${key}`)).toBe(fallback);
      expect(bySourceAndKey.get(`source:s2:${key}`)).toBe(fallback);
    }
  });

  it('prefers the global value for a key, defaults for the rest', () => {
    const rows = computeSeedInserts(['s1'], { maxNodeAgeHours: '72' });
    const map = new Map(rows.map((r) => [r.key, r.value]));
    expect(map.get('source:s1:maxNodeAgeHours')).toBe('72');
    for (const [key, fallback] of NODE_DISPLAY_SEED) {
      if (key === 'maxNodeAgeHours') continue;
      expect(map.get(`source:s1:${key}`)).toBe(fallback);
    }
  });

  it('seeds the two booleans as "0", never "false"', () => {
    const rows = computeSeedInserts(['s1'], {});
    const map = new Map(rows.map((r) => [r.key, r.value]));
    expect(map.get('source:s1:hideIncompleteNodes')).toBe('0');
    expect(map.get('source:s1:nodeDimmingEnabled')).toBe('0');
  });
});

describe('Migration 131 (SQLite) — seed per-source Node Display settings', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
  });

  it('is a no-op on an empty sources table', () => {
    expect(() => migration.up(db)).not.toThrow();
    expect(settingsMap(db)).toEqual({});
  });

  it('does not throw when the sources table is missing entirely', () => {
    const bare = new Database(':memory:');
    bare.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
    `);
    expect(() => migration.up(bare)).not.toThrow();
  });

  it('seeds every key for a source that has never had a setting written', () => {
    // This is the load-bearing case: table-driven enumeration must not skip
    // a source with zero pre-existing source:{id}: rows (spec §5.4 step 1).
    insertSource(db, 'fresh-source');
    migration.up(db);
    const settings = settingsMap(db);
    for (const key of TEN_KEYS) {
      expect(settings[`source:fresh-source:${key}`]).toBeDefined();
    }
  });

  it('propagates the global value, preserves an existing per-source override, and defaults the rest', () => {
    insertSource(db, 'override-source');
    insertSource(db, 'plain-source');
    insertSource(db, 'global-source');

    // override-source already chose its own value — must survive untouched.
    insertSetting(db, 'source:override-source:maxNodeAgeHours', '99');
    // A global value exists and should propagate to sources with no override.
    insertSetting(db, 'maxNodeAgeHours', '72');

    migration.up(db);
    const settings = settingsMap(db);

    // Untouched override.
    expect(settings['source:override-source:maxNodeAgeHours']).toBe('99');
    // Global propagated to the other two sources.
    expect(settings['source:plain-source:maxNodeAgeHours']).toBe('72');
    expect(settings['source:global-source:maxNodeAgeHours']).toBe('72');

    // Every source got every key, and un-set keys got their documented default.
    for (const source of ['override-source', 'plain-source', 'global-source']) {
      for (const [key, fallback] of NODE_DISPLAY_SEED) {
        if (source === 'override-source' && key === 'maxNodeAgeHours') continue;
        if (key === 'maxNodeAgeHours') continue; // covered above
        expect(settings[`source:${source}:${key}`]).toBe(fallback);
      }
    }

    // Booleans specifically use '0', not 'false'.
    expect(settings['source:plain-source:hideIncompleteNodes']).toBe('0');
    expect(settings['source:plain-source:nodeDimmingEnabled']).toBe('0');

    // The un-namespaced global row is unchanged.
    expect(settings['maxNodeAgeHours']).toBe('72');
  });

  it('supplies non-null createdAt/updatedAt on every inserted row', () => {
    insertSource(db, 's1');
    migration.up(db);
    const rows = db.prepare(`SELECT createdAt, updatedAt FROM settings WHERE key LIKE 'source:s1:%'`).all() as Array<{ createdAt: number; updatedAt: number }>;
    expect(rows.length).toBe(TEN_KEYS.length);
    for (const row of rows) {
      expect(row.createdAt).not.toBeNull();
      expect(row.updatedAt).not.toBeNull();
    }
  });

  it('is idempotent: a second run inserts nothing new and preserves overrides', () => {
    insertSource(db, 's1');
    insertSetting(db, 'source:s1:maxNodeAgeHours', '99');

    migration.up(db);
    const countAfterFirst = (db.prepare(`SELECT COUNT(*) AS c FROM settings`).get() as { c: number }).c;

    migration.up(db);
    const countAfterSecond = (db.prepare(`SELECT COUNT(*) AS c FROM settings`).get() as { c: number }).c;

    expect(countAfterSecond).toBe(countAfterFirst);
    const settings = settingsMap(db);
    expect(settings['source:s1:maxNodeAgeHours']).toBe('99');
  });
});
