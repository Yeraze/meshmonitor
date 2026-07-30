/**
 * Multi-Database Settings Repository Tests
 *
 * Validates SettingsRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import * as schema from '../schema/index.js';
import { SettingsRepository } from './settings.js';
import {
  TestBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

// Note: SQLite DDL is now provided by createTestDb() via the migration registry.

// SQL for creating the settings table per backend (PostgreSQL and MySQL only)
const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS settings CASCADE;
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS settings;
  CREATE TABLE settings (
    \`key\` VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL
  )
`;

/**
 * Shared test suite that runs against any backend.
 * Call within a describe() block with a function that returns the current backend.
 */
function runSettingsTests(getBackend: () => TestBackend) {
  let repo: SettingsRepository;

  beforeEach(() => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new SettingsRepository(backend.drizzleDb, backend.dbType);
  });

  it('setSetting and getSetting - set and retrieve a value', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSetting('theme', 'dark');
    const result = await repo.getSetting('theme');
    expect(result).toBe('dark');
  });

  it('getSetting - returns null for missing setting', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const result = await repo.getSetting('nonexistent');
    expect(result).toBeNull();
  });

  it('setSetting - overwrites existing setting', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSetting('theme', 'dark');
    await repo.setSetting('theme', 'light');
    const result = await repo.getSetting('theme');
    expect(result).toBe('light');
  });

  it('setSettings - batch set multiple settings', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSettings({
      theme: 'dark',
      language: 'en',
      timezone: 'UTC',
    });

    expect(await repo.getSetting('theme')).toBe('dark');
    expect(await repo.getSetting('language')).toBe('en');
    expect(await repo.getSetting('timezone')).toBe('UTC');
  });

  it('getAllSettings - returns all settings as key-value object', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSetting('a', '1');
    await repo.setSetting('b', '2');
    await repo.setSetting('c', '3');

    // Subset assertion, not exact-equality: the SQLite backend builds its
    // fixture from the real migration registry (createTestDb()), and a
    // migration is free to legitimately seed real settings rows (e.g.
    // migration 131 seeding per-source Node Display defaults for whatever
    // source(s) exist — #4412). This test's contract is "getAllSettings
    // returns what was set", not "the table starts empty".
    const all = await repo.getAllSettings();
    expect(all.a).toBe('1');
    expect(all.b).toBe('2');
    expect(all.c).toBe('3');
  });

  it('deleteSetting - removes a specific setting', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSetting('theme', 'dark');
    await repo.setSetting('language', 'en');

    await repo.deleteSetting('theme');

    expect(await repo.getSetting('theme')).toBeNull();
    expect(await repo.getSetting('language')).toBe('en');
  });

  it('hasSetting - returns true for existing, false for missing', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSetting('theme', 'dark');

    expect(await repo.hasSetting('theme')).toBe(true);
    expect(await repo.hasSetting('nonexistent')).toBe(false);
  });

  it('getSettingWithDefault - returns value when present, default when missing', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSetting('theme', 'dark');

    expect(await repo.getSettingWithDefault('theme', 'light')).toBe('dark');
    expect(await repo.getSettingWithDefault('missing', 'fallback')).toBe('fallback');
  });

  it('getSettingAsNumber - parses numeric strings', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSetting('port', '8080');
    await repo.setSetting('invalid', 'abc');

    expect(await repo.getSettingAsNumber('port')).toBe(8080);
    expect(await repo.getSettingAsNumber('invalid')).toBeNull();
    expect(await repo.getSettingAsNumber('invalid', 3000)).toBe(3000);
    expect(await repo.getSettingAsNumber('missing')).toBeNull();
    expect(await repo.getSettingAsNumber('missing', 9090)).toBe(9090);
  });

  it('getSettingAsBoolean and setSettingBoolean - boolean round-trip', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSettingBoolean('enabled', true);
    expect(await repo.getSettingAsBoolean('enabled')).toBe(true);

    await repo.setSettingBoolean('enabled', false);
    expect(await repo.getSettingAsBoolean('enabled')).toBe(false);

    // Default value when missing
    expect(await repo.getSettingAsBoolean('missing')).toBe(false);
    expect(await repo.getSettingAsBoolean('missing', true)).toBe(true);

    // String '1' should be truthy
    await repo.setSetting('flag', '1');
    expect(await repo.getSettingAsBoolean('flag')).toBe(true);
  });

  it('getSettingAsJson and setSettingJson - JSON round-trip', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const config = { nodes: ['a', 'b'], count: 42, nested: { x: true } };
    await repo.setSettingJson('config', config);
    const result = await repo.getSettingAsJson<typeof config>('config');
    expect(result).toEqual(config);

    // Missing key returns null
    expect(await repo.getSettingAsJson('missing')).toBeNull();

    // Missing key with default
    const defaultVal = { fallback: true };
    expect(await repo.getSettingAsJson('missing', defaultVal)).toEqual(defaultVal);

    // Invalid JSON returns default
    await repo.setSetting('bad', 'not-json');
    expect(await repo.getSettingAsJson('bad')).toBeNull();
    expect(await repo.getSettingAsJson('bad', defaultVal)).toEqual(defaultVal);
  });

  it('deleteSourceSettings - removes only the target source prefix', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSetting('maxNodeAgeHours', '24');
    await repo.setSourceSetting('source-a', 'maxNodeAgeHours', '48');
    await repo.setSourceSetting('source-a', 'hideIncompleteNodes', '1');
    await repo.setSourceSetting('source-b', 'maxNodeAgeHours', '12');

    await repo.deleteSourceSettings('source-a');

    // Target source's namespace is gone.
    expect(await repo.getSourceSettings('source-a')).toEqual({});

    // A sibling source's namespace survives.
    expect(await repo.getSourceSettings('source-b')).toEqual({ maxNodeAgeHours: '12' });

    // The un-namespaced global row survives.
    expect(await repo.getSetting('maxNodeAgeHours')).toBe('24');
  });

  it('deleteSourceSettings - no-op on an unknown sourceId', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSourceSetting('source-a', 'maxNodeAgeHours', '48');

    await expect(repo.deleteSourceSettings('does-not-exist')).resolves.toBeUndefined();

    expect(await repo.getSourceSettings('source-a')).toEqual({ maxNodeAgeHours: '48' });
  });

  it('deleteSourceSettings - a sourceId containing a LIKE wildcard does not over-match a lookalike namespace', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // 'source_a' (underscore) is a single-char LIKE wildcard that would match
    // 'sourceXa' unless escaped. Set up a lookalike sibling namespace that must survive.
    await repo.setSourceSetting('source_a', 'maxNodeAgeHours', '48');
    await repo.setSourceSetting('sourceXa', 'maxNodeAgeHours', '12');

    await repo.deleteSourceSettings('source_a');

    expect(await repo.getSourceSettings('source_a')).toEqual({});
    expect(await repo.getSourceSettings('sourceXa')).toEqual({ maxNodeAgeHours: '12' });
  });

  it('getSourceSettings - returns this source\'s rows with the prefix stripped', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSourceSetting('source-a', 'maxNodeAgeHours', '48');
    await repo.setSourceSetting('source-a', 'hideIncompleteNodes', '1');
    await repo.setSourceSetting('source-b', 'maxNodeAgeHours', '12');
    await repo.setSetting('maxNodeAgeHours', '24');

    const result = await repo.getSourceSettings('source-a');

    expect(result).toEqual({ maxNodeAgeHours: '48', hideIncompleteNodes: '1' });
  });

  it('getSourceSettings - excludes the un-namespaced global rows', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSetting('maxNodeAgeHours', '24');

    const result = await repo.getSourceSettings('source-a');

    expect(result).toEqual({});
  });

  it('getSourceSettings - a sourceId containing a LIKE wildcard does not over-match a lookalike namespace', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // 'source_a' (underscore) is a single-char LIKE wildcard that would match
    // 'sourceXa' unless escaped. Mirrors the deleteSourceSettings test above —
    // this is the test that would catch a wrong ESCAPE literal on MySQL.
    await repo.setSourceSetting('source_a', 'maxNodeAgeHours', '48');
    await repo.setSourceSetting('sourceXa', 'maxNodeAgeHours', '12');

    expect(await repo.getSourceSettings('source_a')).toEqual({ maxNodeAgeHours: '48' });
  });

  it('getSourceSettings - issues exactly one SELECT and does not read the whole table', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // Three sibling sources so a correctly-scoped query returns only A's rows,
    // not the whole table. Counting db.select() calls alone is insufficient:
    // the old getAllSettings()-then-JS-filter body also issues exactly one
    // select() (from inside getAllSettings), so that count is 1 either way.
    // The real distinguishing signal is whether getAllSettings() itself gets
    // called at all — the scoped implementation never calls it.
    await repo.setSourceSetting('source-a', 'maxNodeAgeHours', '48');
    await repo.setSourceSetting('source-b', 'maxNodeAgeHours', '168');
    await repo.setSourceSetting('source-c', 'maxNodeAgeHours', '24');

    // Monkey-patching the protected drizzle handle to count round trips (no-explicit-any is off in *.test.ts).
    const dbHandle = (repo as any).db;
    const realSelect = dbHandle.select.bind(dbHandle);
    let selectCalls = 0;
    dbHandle.select = (...args: unknown[]) => {
      selectCalls += 1;
      return realSelect(...args);
    };

    const realGetAllSettings = repo.getAllSettings.bind(repo);
    let getAllSettingsCalls = 0;
    (repo as any).getAllSettings = (...args: unknown[]) => {
      getAllSettingsCalls += 1;
      return realGetAllSettings(...(args as []));
    };

    try {
      const result = await repo.getSourceSettings('source-a');
      expect(selectCalls).toBe(1);
      expect(getAllSettingsCalls).toBe(0);
      expect(result).toEqual({ maxNodeAgeHours: '48' });
    } finally {
      dbHandle.select = realSelect;
      (repo as any).getAllSettings = realGetAllSettings;
    }
  });

  it('getSourceSettings - a stored __proto__ key does not pollute the prototype', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSourceSetting('source-a', '__proto__', 'pwned');

    const result = await repo.getSourceSettings('source-a');

    expect((({}) as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toBe('pwned');
  });

  it('getSettingForSources - batched multi-source hit/miss for one key', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSourceSetting('source-a', 'maxNodeAgeHours', '48');
    await repo.setSourceSetting('source-b', 'maxNodeAgeHours', '168');
    // source-c has no override; a sibling key on source-c must not bleed in.
    await repo.setSourceSetting('source-c', 'hideIncompleteNodes', '1');
    // The un-namespaced global row must not be picked up for any source.
    await repo.setSetting('maxNodeAgeHours', '999');

    const result = await repo.getSettingForSources(
      ['source-a', 'source-b', 'source-c'],
      'maxNodeAgeHours',
    );

    expect(result.get('source-a')).toBe('48');
    expect(result.get('source-b')).toBe('168');
    expect(result.has('source-c')).toBe(false);
    expect(result.size).toBe(2);
  });

  it('getSettingForSources - empty input returns an empty Map without querying', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const result = await repo.getSettingForSources([], 'maxNodeAgeHours');
    expect(result.size).toBe(0);
  });

  it('getSettingForSources - dedupes a sourceId requested more than once', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSourceSetting('source-a', 'maxNodeAgeHours', '48');

    const result = await repo.getSettingForSources(
      ['source-a', 'source-a', 'source-a'],
      'maxNodeAgeHours',
    );

    expect(result.size).toBe(1);
    expect(result.get('source-a')).toBe('48');
  });

  it('getSettingForSources - no cross-namespace bleed between different keys', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSourceSetting('source-a', 'maxNodeAgeHours', '48');
    await repo.setSourceSetting('source-a', 'inactiveNodeThresholdHours', '72');

    const result = await repo.getSettingForSources(['source-a'], 'maxNodeAgeHours');

    expect(result.get('source-a')).toBe('48');
    expect(result.size).toBe(1);
  });

  it('getSettingForSources - issues exactly one SELECT for the whole batch, not one per source', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSourceSetting('source-a', 'maxNodeAgeHours', '48');
    await repo.setSourceSetting('source-b', 'maxNodeAgeHours', '168');
    await repo.setSourceSetting('source-c', 'maxNodeAgeHours', '24');

    // Monkey-patching the protected drizzle handle to count round trips (no-explicit-any is off in *.test.ts).
    const dbHandle = (repo as any).db;
    const realSelect = dbHandle.select.bind(dbHandle);
    let selectCalls = 0;
    dbHandle.select = (...args: unknown[]) => {
      selectCalls += 1;
      return realSelect(...args);
    };

    try {
      await repo.getSettingForSources(['source-a', 'source-b', 'source-c'], 'maxNodeAgeHours');
      expect(selectCalls).toBe(1);
    } finally {
      dbHandle.select = realSelect;
    }
  });

  it('getSettingForSources - a sourceId containing a colon is resolved by reverse map, not string-split', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // A colon inside the id would corrupt a naive `key.split(':')` resolution
    // (`source:a:b:maxNodeAgeHours` is ambiguous by string-splitting alone).
    // The reverse-map implementation resolves by exact prefixed-key match, so
    // this must round-trip correctly regardless.
    const weirdId = 'weird:id:with:colons';
    await repo.setSourceSetting(weirdId, 'maxNodeAgeHours', '99');
    await repo.setSourceSetting('plain-id', 'maxNodeAgeHours', '11');

    const result = await repo.getSettingForSources([weirdId, 'plain-id'], 'maxNodeAgeHours');

    expect(result.get(weirdId)).toBe('99');
    expect(result.get('plain-id')).toBe('11');
    expect(result.size).toBe(2);
  });

  it('deleteAllSettings - removes all settings', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.setSetting('a', '1');
    await repo.setSetting('b', '2');
    await repo.setSetting('c', '3');

    await repo.deleteAllSettings();

    const all = await repo.getAllSettings();
    expect(Object.keys(all).length).toBe(0);
  });
}

// --- SQLite Backend ---
describe('SettingsRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    const t = createTestDb();
    backend = {
      dbType: 'sqlite',
      drizzleDb: t.db,
      exec: async (sql: string) => { t.sqlite.exec(sql); },
      close: async () => { t.close(); },
      available: true,
    };
  });

  afterEach(async () => {
    await backend.close();
  });

  runSettingsTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('SettingsRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for settings tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'settings');
  });

  runSettingsTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('SettingsRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for settings tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'settings');
  });

  runSettingsTests(() => backend);
});
