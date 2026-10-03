/**
 * Migration 189 — drop per-source copies of global UI preferences (#5558).
 * Pure planner + real SQLite `up()` against in-memory better-sqlite3.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration, planGlobalUiPrefCleanup } from './189_global_ui_prefs_drop_source_copies.js';

function createSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
}

function seed(db: Database.Database, sources: string[], settings: Record<string, string>) {
  const ts = Date.now();
  for (const id of sources) db.prepare(`INSERT INTO sources (id, name) VALUES (?, ?)`).run(id, id);
  const stmt = db.prepare(`INSERT INTO settings (key, value, createdAt, updatedAt) VALUES (?, ?, ?, ?)`);
  for (const [k, v] of Object.entries(settings)) stmt.run(k, v, ts, ts);
}

function settingsMap(db: Database.Database): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const rows = (m: Record<string, string>) => Object.entries(m).map(([key, value]) => ({ key, value }));

describe('planGlobalUiPrefCleanup (pure)', () => {
  it('does nothing when no source copies exist', () => {
    expect(planGlobalUiPrefCleanup(rows({ appearanceMode: 'dark' }), ['a'])).toEqual({ promote: {}, deleteKeys: [] });
  });

  it('promotes a unanimous appearance set when the global set is unset', () => {
    const plan = planGlobalUiPrefCleanup(rows({
      'source:a:appearanceMode': 'dark', 'source:a:darkTheme': 'mocha', 'source:a:lightTheme': 'mocha',
      'source:b:appearanceMode': 'dark', 'source:b:darkTheme': 'mocha', 'source:b:lightTheme': 'mocha',
    }), ['a', 'b']);
    expect(plan.promote).toEqual({ appearanceMode: 'dark', darkTheme: 'mocha', lightTheme: 'mocha' });
    expect(plan.deleteKeys).toHaveLength(6);
  });

  it('promotes over a global set that is still the defaults', () => {
    const plan = planGlobalUiPrefCleanup(rows({
      appearanceMode: 'system', darkTheme: 'mocha', lightTheme: 'latte', theme: 'latte',
      'source:a:appearanceMode': 'dark', 'source:a:theme': 'mocha',
    }), ['a']);
    expect(plan.promote).toEqual({ appearanceMode: 'dark', theme: 'mocha' });
  });

  it('keeps a non-default global appearance set', () => {
    const plan = planGlobalUiPrefCleanup(rows({
      appearanceMode: 'light', 'source:a:appearanceMode': 'dark',
    }), ['a']);
    expect(plan.promote).toEqual({});
    expect(plan.deleteKeys).toEqual(['source:a:appearanceMode']);
  });

  it('keeps global when sources disagree on the appearance set (judged as a whole tuple)', () => {
    const plan = planGlobalUiPrefCleanup(rows({
      'source:a:appearanceMode': 'dark', 'source:a:darkTheme': 'mocha',
      // Same mode, but b has no darkTheme copy — a different set.
      'source:b:appearanceMode': 'dark',
    }), ['a', 'b']);
    expect(plan.promote).toEqual({});
    expect(plan.deleteKeys).toHaveLength(3);
  });

  it('gives copies from deleted sources no vote, but still deletes them', () => {
    const plan = planGlobalUiPrefCleanup(rows({
      'source:a:appearanceMode': 'dark',
      'source:gone:appearanceMode': 'light',
    }), ['a']);
    expect(plan.promote).toEqual({ appearanceMode: 'dark' });
    expect(plan.deleteKeys.sort()).toEqual(['source:a:appearanceMode', 'source:gone:appearanceMode']);
  });

  it('judges other UI preferences per key: promote only when global is unset and copies agree', () => {
    const plan = planGlobalUiPrefCleanup(rows({
      temperatureUnit: 'C',
      'source:a:temperatureUnit': 'F',          // global set → global wins
      'source:a:timeFormat': '12', 'source:b:timeFormat': '12', // unanimous → promote
      'source:a:distanceUnit': 'mi', 'source:b:distanceUnit': 'km', // disagree → drop
    }), ['a', 'b']);
    expect(plan.promote).toEqual({ timeFormat: '12' });
    expect(plan.deleteKeys).toHaveLength(5);
  });

  it('ignores unrelated and look-alike keys', () => {
    const plan = planGlobalUiPrefCleanup(rows({
      'source:a:maxNodeAgeHours': '48',
      'source:a:themeExtra': 'x',
    }), ['a']);
    expect(plan).toEqual({ promote: {}, deleteKeys: [] });
  });
});

describe('migration 189 — SQLite', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('promotes a source-only theme to global, deletes every copy, leaves other rows, and is idempotent', () => {
    seed(db, ['a', 'b'], {
      'source:a:appearanceMode': 'dark', 'source:a:darkTheme': 'mocha', 'source:a:lightTheme': 'mocha', 'source:a:theme': 'mocha',
      'source:b:appearanceMode': 'dark', 'source:b:darkTheme': 'mocha', 'source:b:lightTheme': 'mocha', 'source:b:theme': 'mocha',
      'source:a:maxNodeAgeHours': '48',
      lightTheme: 'latte',
    });
    migration.up(db);
    const after = settingsMap(db);
    expect(after).toMatchObject({ appearanceMode: 'dark', darkTheme: 'mocha', lightTheme: 'mocha', theme: 'mocha' });
    expect(Object.keys(after).filter((k) => k.startsWith('source:'))).toEqual(['source:a:maxNodeAgeHours']);

    migration.up(db);
    expect(settingsMap(db)).toEqual(after);
  });

  it('leaves a chosen global theme alone', () => {
    seed(db, ['a'], { appearanceMode: 'light', lightTheme: 'nord', 'source:a:appearanceMode': 'dark' });
    migration.up(db);
    expect(settingsMap(db)).toEqual({ appearanceMode: 'light', lightTheme: 'nord' });
  });

  it('runs when the sources table is missing (every copy votes)', () => {
    db.exec('DROP TABLE sources');
    seed(db, [], { 'source:x:dateFormat': 'DD/MM/YYYY' });
    migration.up(db);
    expect(settingsMap(db)).toEqual({ dateFormat: 'DD/MM/YYYY' });
  });
});
