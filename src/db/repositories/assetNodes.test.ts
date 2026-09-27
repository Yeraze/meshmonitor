/**
 * Asset Nodes Repository Tests (#5354)
 *
 * Upsert / get / clear coverage for the GLOBAL `asset_nodes` table against a
 * real in-memory SQLite database built from the migration registry. The
 * PostgreSQL / MySQL round trip lives in
 * `src/server/migrations/181_create_asset_nodes.pgmysql.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AssetNodesRepository } from './assetNodes.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('AssetNodesRepository', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: AssetNodesRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new AssetNodesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('starts empty', async () => {
    expect(await repo.getAllAsync()).toEqual([]);
    expect((await repo.getMapAsync()).size).toBe(0);
    expect(await repo.getAsync(1)).toBeNull();
  });

  it('stores a node and exposes it through the map and get', async () => {
    const saved = await repo.setAsync(1, 30, 7);
    expect(saved).toMatchObject({ nodeNum: 1, retentionDays: 30, updatedBy: 7 });
    expect((await repo.getMapAsync()).get(1)).toEqual({ retentionDays: 30 });
    expect(await repo.getAsync(1)).toMatchObject({ nodeNum: 1, retentionDays: 30, updatedBy: 7 });
  });

  it('replaces rather than duplicating on a second write for the same node', async () => {
    await repo.setAsync(42, 90, 1);
    await repo.setAsync(42, 10, 2);
    const all = await repo.getAllAsync();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ nodeNum: 42, retentionDays: 10, updatedBy: 2 });
  });

  it('applies a write as an update when a concurrent first insert already created the row', async () => {
    const originalInsert = drizzleDb.insert.bind(drizzleDb);
    let injected = false;
    (drizzleDb as unknown as { insert: typeof drizzleDb.insert }).insert = ((table: never) => {
      if (!injected) {
        injected = true;
        db.prepare('INSERT INTO asset_nodes (nodeNum, retentionDays, updatedBy, updatedAt) VALUES (?, ?, ?, ?)').run(77, 5, 9, 1);
      }
      return originalInsert(table);
    }) as typeof drizzleDb.insert;

    const saved = await repo.setAsync(77, 60, 3);
    expect(saved.retentionDays).toBe(60);
    const all = await repo.getAllAsync();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ nodeNum: 77, retentionDays: 60, updatedBy: 3 });
  });

  it('re-throws an insert failure that is not the concurrent-insert race', async () => {
    (drizzleDb as unknown as { insert: () => never }).insert = () => {
      throw new Error('disk full');
    };
    await expect(repo.setAsync(78, 30)).rejects.toThrow('disk full');
  });

  it('handles an unsigned nodeNum above the signed 32-bit range', async () => {
    const big = 0xfedcba98;
    await repo.setAsync(big, 365);
    expect((await repo.getMapAsync()).get(big)).toEqual({ retentionDays: 365 });
  });

  it('clearing removes the flag, and is silent when nothing was set', async () => {
    await repo.setAsync(7, 90);
    await repo.clearAsync(7);
    await repo.clearAsync(8);
    expect(await repo.getAllAsync()).toEqual([]);
  });

  it('stores a missing author as null', async () => {
    const saved = await repo.setAsync(9, 90);
    expect(saved.updatedBy).toBeNull();
    expect((await repo.getAsync(9))?.updatedBy).toBeNull();
  });
});
