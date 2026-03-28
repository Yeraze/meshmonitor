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
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
} from './test-utils.js';

// SQL for creating the settings table per backend
const SQLITE_CREATE = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )
`;

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

    const all = await repo.getAllSettings();
    expect(all).toEqual({ a: '1', b: '2', c: '3' });
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
    backend = createSqliteBackend(SQLITE_CREATE);
  });

  afterEach(async () => {
    await backend.close();
  });

  runSettingsTests(() => backend);
});

// --- PostgreSQL Backend ---
describe('SettingsRepository - PostgreSQL Backend', () => {
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
describe('SettingsRepository - MySQL Backend', () => {
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
