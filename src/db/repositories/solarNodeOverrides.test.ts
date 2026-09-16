/**
 * Solar Node Overrides Repository Tests (#3195)
 *
 * Upsert / clear coverage for the GLOBAL `solar_node_overrides` table against a
 * real in-memory SQLite database built from the migration registry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { SolarNodeOverridesRepository } from './solarNodeOverrides.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('SolarNodeOverridesRepository', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: SolarNodeOverridesRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new SolarNodeOverridesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('starts empty', async () => {
    expect(await repo.getAllAsync()).toEqual([]);
    expect((await repo.getMapAsync()).size).toBe(0);
  });

  it('stores true and false as real booleans, not 0/1', async () => {
    await repo.setAsync(1, true, 'admin');
    await repo.setAsync(2, false, 'admin');
    const map = await repo.getMapAsync();
    expect(map.get(1)).toBe(true);
    expect(map.get(2)).toBe(false);
  });

  it('replaces rather than duplicating on a second write for the same node', async () => {
    await repo.setAsync(42, true, 'admin');
    await repo.setAsync(42, false, 'editor');
    const all = await repo.getAllAsync();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ nodeNum: 42, isSolar: false, updatedBy: 'editor' });
  });

  it('applies a write as an update when a concurrent first insert already created the row', async () => {
    // Simulate losing the race: the row appears between our SELECT and INSERT.
    const originalInsert = drizzleDb.insert.bind(drizzleDb);
    let injected = false;
    (drizzleDb as unknown as { insert: typeof drizzleDb.insert }).insert = ((table: never) => {
      if (!injected) {
        injected = true;
        db.prepare('INSERT INTO solar_node_overrides (nodeNum, isSolar, updatedBy, updatedAt) VALUES (?, ?, ?, ?)').run(77, 1, 'other', 1);
      }
      return originalInsert(table);
    }) as typeof drizzleDb.insert;

    const saved = await repo.setAsync(77, false, 'me');

    expect(saved.isSolar).toBe(false);
    const all = await repo.getAllAsync();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ nodeNum: 77, isSolar: false, updatedBy: 'me' });
  });

  it('re-throws an insert failure that is not the concurrent-insert race', async () => {
    (drizzleDb as unknown as { insert: () => never }).insert = () => {
      throw new Error('disk full');
    };
    await expect(repo.setAsync(78, true)).rejects.toThrow('disk full');
  });

  it('handles an unsigned nodeNum above the signed 32-bit range', async () => {
    const big = 0xfedcba98;
    await repo.setAsync(big, true);
    expect((await repo.getMapAsync()).get(big)).toBe(true);
  });

  it('clearing returns the node to auto-detection, and is silent when nothing was set', async () => {
    await repo.setAsync(7, true);
    await repo.clearAsync(7);
    await repo.clearAsync(8);
    expect(await repo.getAllAsync()).toEqual([]);
  });

  it('stores a blank author as null', async () => {
    const saved = await repo.setAsync(9, true, '   ');
    expect(saved.updatedBy).toBeNull();
  });
});
