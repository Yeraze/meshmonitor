/**
 * Saved Regions Repository Tests (#3770)
 *
 * CRUD + normalization + de-dup coverage for the GLOBAL `meshcore_saved_regions`
 * catalog against a real in-memory SQLite database (migration 108 applied via
 * createTestDb).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { SavedRegionsRepository, normalizeRegionName } from './savedRegions.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('normalizeRegionName', () => {
  it('strips leading #, lowercases, and drops invalid chars', () => {
    expect(normalizeRegionName('#Muenchen')).toBe('muenchen');
    expect(normalizeRegionName('  Sample City! ')).toBe('samplecity');
    expect(normalizeRegionName('foo-bar-123')).toBe('foo-bar-123');
    expect(normalizeRegionName('###')).toBe('');
    expect(normalizeRegionName('')).toBe('');
  });
});

describe('SavedRegionsRepository', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: SavedRegionsRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new SavedRegionsRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('starts empty', async () => {
    expect(await repo.getAllAsync()).toEqual([]);
  });

  it('adds and retrieves a region (normalized)', async () => {
    const added = await repo.addAsync('#Muenchen', 'big city');
    expect(added.id).toBeGreaterThan(0);
    expect(added.name).toBe('muenchen');
    expect(added.note).toBe('big city');
    expect(added.createdAt).toBeGreaterThan(0);

    const all = await repo.getAllAsync();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('muenchen');
  });

  it('is idempotent on duplicate names (returns existing, no duplicate row)', async () => {
    const first = await repo.addAsync('muenchen');
    const second = await repo.addAsync('#MUENCHEN'); // same after normalization
    expect(second.id).toBe(first.id);
    expect(await repo.getAllAsync()).toHaveLength(1);
  });

  it('updates the note when re-adding the same name with a new note', async () => {
    const first = await repo.addAsync('berlin');
    expect(first.note).toBeNull();
    const updated = await repo.addAsync('berlin', 'capital');
    expect(updated.id).toBe(first.id);
    expect(updated.note).toBe('capital');
    const fetched = await repo.getByNameAsync('berlin');
    expect(fetched?.note).toBe('capital');
  });

  it('rejects an empty/invalid name', async () => {
    await expect(repo.addAsync('###')).rejects.toThrow(/Invalid region name/);
    await expect(repo.addAsync('   ')).rejects.toThrow(/Invalid region name/);
  });

  it('looks up by name case-insensitively', async () => {
    await repo.addAsync('Hamburg');
    expect((await repo.getByNameAsync('#HAMBURG'))?.name).toBe('hamburg');
    expect(await repo.getByNameAsync('nope')).toBeNull();
  });

  it('lists regions ordered by name', async () => {
    await repo.addAsync('zulu');
    await repo.addAsync('alpha');
    await repo.addAsync('mike');
    const names = (await repo.getAllAsync()).map((r) => r.name);
    expect(names).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('deletes a region by id', async () => {
    const a = await repo.addAsync('alpha');
    await repo.addAsync('bravo');
    await repo.deleteAsync(a.id);
    const names = (await repo.getAllAsync()).map((r) => r.name);
    expect(names).toEqual(['bravo']);
  });
});
