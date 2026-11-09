/**
 * #6306: `upsertNode` reports whether it created the row, and
 * `getEarliestNodeCreatedAt` gives the new-node alert gate its starting point.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { MeshCoreRepository } from './meshcore.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const KEY = 'cc'.repeat(32);
const KEY2 = 'dd'.repeat(32);

describe('MeshCoreRepository insert report (#6306)', () => {
  let db: Database.Database;
  let repo: MeshCoreRepository;
  let clock = 1_760_000_000_000;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    repo = new MeshCoreRepository(t.db, 'sqlite');
    (repo as unknown as { now: () => number }).now = () => clock;
  });

  afterEach(() => db.close());

  it('reports inserted true once, then false, per source', async () => {
    expect(await repo.upsertNode({ publicKey: KEY, name: 'a' }, 'src-a')).toEqual({ inserted: true });
    expect(await repo.upsertNode({ publicKey: KEY, name: 'a2' }, 'src-a')).toEqual({ inserted: false });
    // Same key on another source is new to that source.
    expect(await repo.upsertNode({ publicKey: KEY, name: 'a' }, 'src-b')).toEqual({ inserted: true });
  });

  it('returns the earliest createdAt of one source, or null when it has no rows', async () => {
    expect(await repo.getEarliestNodeCreatedAt('src-a')).toBeNull();
    await repo.upsertNode({ publicKey: KEY }, 'src-a');
    clock += 5000;
    await repo.upsertNode({ publicKey: KEY2 }, 'src-a');
    clock += 5000;
    await repo.upsertNode({ publicKey: 'ee'.repeat(32) }, 'src-b');
    expect(await repo.getEarliestNodeCreatedAt('src-a')).toBe(1_760_000_000_000);
    expect(await repo.getEarliestNodeCreatedAt('src-b')).toBe(1_760_000_010_000);
    expect(await repo.getEarliestNodeCreatedAt('src-none')).toBeNull();
  });
});
