/**
 * MeshcorePathfindingTargetsRepository — per-source isolation tests (#4024).
 *
 * `meshcore_pathfinding_targets` backs the OR-union "specific contact"
 * allowlist sub-filter for MeshCore Auto-Pathfinding target filtering. Every
 * row carries a `sourceId` (composite UNIQUE with `publicKey`), so these
 * tests assert that setting the allowlist for one source never leaks into
 * or clobbers another source's allowlist for the same public keys.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MeshcorePathfindingTargetsRepository } from './meshcorePathfindingTargets.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const K1 = 'a'.repeat(64);
const K2 = 'b'.repeat(64);
const K3 = 'c'.repeat(64);

describe('MeshcorePathfindingTargetsRepository — per-source isolation', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MeshcorePathfindingTargetsRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MeshcorePathfindingTargetsRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('returns an empty allowlist for a source with no rows', async () => {
    expect(await repo.getTargets('src-a')).toEqual([]);
  });

  it('setTargets then getTargets round-trips ordered by insertion', async () => {
    await repo.setTargets([K1, K2], 'src-a');
    expect(await repo.getTargets('src-a')).toEqual([K1, K2]);
    expect(await repo.getTargets('src-b')).toEqual([]);
  });

  it('writing one source does not affect another source with the same keys', async () => {
    await repo.setTargets([K1, K2], 'src-a');
    await repo.setTargets([K1], 'src-b');

    expect(await repo.getTargets('src-a')).toEqual([K1, K2]);
    expect(await repo.getTargets('src-b')).toEqual([K1]);
  });

  it('setTargets replaces the whole allowlist for a source (delete-then-insert)', async () => {
    await repo.setTargets([K1, K2], 'src-a');
    await repo.setTargets([K3], 'src-a');

    expect(await repo.getTargets('src-a')).toEqual([K3]);
  });

  it('replacing one source leaves other sources untouched', async () => {
    await repo.setTargets([K1, K2], 'src-a');
    await repo.setTargets([K3], 'src-b');

    await repo.setTargets([K3], 'src-a');

    expect(await repo.getTargets('src-a')).toEqual([K3]);
    expect(await repo.getTargets('src-b')).toEqual([K3]);
  });

  it('de-dupes duplicate input keys without violating UNIQUE(sourceId, publicKey)', async () => {
    await expect(repo.setTargets([K1, K1, K2, K2], 'src-a')).resolves.not.toThrow();
    expect(await repo.getTargets('src-a')).toEqual([K1, K2]);
  });

  it('setTargets([]) clears the allowlist for a source', async () => {
    await repo.setTargets([K1, K2], 'src-a');
    await repo.setTargets([], 'src-a');
    expect(await repo.getTargets('src-a')).toEqual([]);
  });
});
