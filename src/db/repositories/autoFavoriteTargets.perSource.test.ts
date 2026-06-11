/**
 * AutoFavoriteTargetsRepository tests (issue #2608)
 *
 * Covers CRUD on the per-source/per-target config + assignment ledger, and
 * asserts source isolation (two sources sharing a targetNodeNum never leak).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AutoFavoriteTargetsRepository } from './autoFavoriteTargets.js';
import type { AutoFavoriteTargetInput } from './autoFavoriteTargets.js';
import * as schema from '../schema/index.js';

function baseConfig(overrides: Partial<AutoFavoriteTargetInput> = {}): AutoFavoriteTargetInput {
  return {
    sourceId: 'source-a',
    targetNodeNum: 111,
    enabled: true,
    useNeighborInfo: true,
    useTraceroutes: true,
    intervalHours: 24,
    maxNewPerCycle: 1,
    maxRefavoritePerCycle: 1,
    eligibleRoles: '[2,11,12]',
    ...overrides,
  };
}

describe('AutoFavoriteTargetsRepository', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: AutoFavoriteTargetsRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE auto_favorite_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        targetNodeNum INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        useNeighborInfo INTEGER NOT NULL DEFAULT 1,
        useTraceroutes INTEGER NOT NULL DEFAULT 1,
        intervalHours INTEGER NOT NULL DEFAULT 24,
        maxNewPerCycle INTEGER NOT NULL DEFAULT 1,
        maxRefavoritePerCycle INTEGER NOT NULL DEFAULT 1,
        eligibleRoles TEXT NOT NULL DEFAULT '[2,11,12]',
        lastRunAt INTEGER,
        lastNeighborRequestAt INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE UNIQUE INDEX aft_source_target_uniq ON auto_favorite_targets(sourceId, targetNodeNum)`);
    db.exec(`
      CREATE TABLE auto_favorite_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        targetNodeNum INTEGER NOT NULL,
        favoriteNodeNum INTEGER NOT NULL,
        discoverySource TEXT,
        firstAssignedAt INTEGER NOT NULL,
        lastAssignedAt INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE UNIQUE INDEX afa_source_target_fav_uniq ON auto_favorite_assignments(sourceId, targetNodeNum, favoriteNodeNum)`);

    drizzleDb = drizzle(db, { schema });
    repo = new AutoFavoriteTargetsRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('returns null for an unconfigured target', async () => {
    expect(await repo.getTarget('source-a', 999)).toBeNull();
  });

  it('creates then updates a config via upsert (no duplicate row)', async () => {
    await repo.upsertTarget(baseConfig());
    let cfg = await repo.getTarget('source-a', 111);
    expect(cfg).not.toBeNull();
    expect(cfg!.enabled).toBe(true);
    expect(cfg!.intervalHours).toBe(24);

    await repo.upsertTarget(baseConfig({ enabled: false, intervalHours: 48, maxNewPerCycle: 3 }));
    cfg = await repo.getTarget('source-a', 111);
    expect(cfg!.enabled).toBe(false);
    expect(cfg!.intervalHours).toBe(48);
    expect(cfg!.maxNewPerCycle).toBe(3);

    // Still a single row for this (source, target)
    const all = await repo.getTargetsForSource('source-a');
    expect(all).toHaveLength(1);
  });

  it('getEnabledTargets returns only enabled rows across sources', async () => {
    await repo.upsertTarget(baseConfig({ sourceId: 'source-a', targetNodeNum: 1, enabled: true }));
    await repo.upsertTarget(baseConfig({ sourceId: 'source-a', targetNodeNum: 2, enabled: false }));
    await repo.upsertTarget(baseConfig({ sourceId: 'source-b', targetNodeNum: 1, enabled: true }));

    const enabled = await repo.getEnabledTargets();
    expect(enabled).toHaveLength(2);
    expect(enabled.every((t) => t.enabled)).toBe(true);
  });

  it('isolates config between sources sharing a targetNodeNum', async () => {
    await repo.upsertTarget(baseConfig({ sourceId: 'source-a', targetNodeNum: 500, intervalHours: 6 }));
    await repo.upsertTarget(baseConfig({ sourceId: 'source-b', targetNodeNum: 500, intervalHours: 99 }));

    expect((await repo.getTarget('source-a', 500))!.intervalHours).toBe(6);
    expect((await repo.getTarget('source-b', 500))!.intervalHours).toBe(99);
  });

  it('records assignments and bumps lastAssignedAt on re-record', async () => {
    await repo.recordAssignment('source-a', 111, 222, 'discovery', 1000);
    await repo.recordAssignment('source-a', 111, 333, 'discovery', 2000);

    let assignments = await repo.getAssignments('source-a', 111);
    expect(assignments).toHaveLength(2);
    // ordered ascending by lastAssignedAt
    expect(assignments[0].favoriteNodeNum).toBe(222);

    // Re-record 222 (e.g. re-favorite) bumps its lastAssignedAt to newest
    await repo.recordAssignment('source-a', 111, 222, 'discovery', 5000);
    assignments = await repo.getAssignments('source-a', 111);
    expect(assignments).toHaveLength(2); // no duplicate
    expect(assignments[assignments.length - 1].favoriteNodeNum).toBe(222);
    expect(assignments[assignments.length - 1].firstAssignedAt).toBe(1000); // preserved
  });

  it('touchAssignment updates lastAssignedAt only', async () => {
    await repo.recordAssignment('source-a', 111, 222, 'discovery', 1000);
    await repo.touchAssignment('source-a', 111, 222, 9000);
    const a = (await repo.getAssignments('source-a', 111))[0];
    expect(a.lastAssignedAt).toBe(9000);
    expect(a.firstAssignedAt).toBe(1000);
  });

  it('touchLastRun and touchLastNeighborRequest persist timestamps', async () => {
    await repo.upsertTarget(baseConfig());
    await repo.touchLastRun('source-a', 111, 7777);
    await repo.touchLastNeighborRequest('source-a', 111, 8888);
    const cfg = await repo.getTarget('source-a', 111);
    expect(cfg!.lastRunAt).toBe(7777);
    expect(cfg!.lastNeighborRequestAt).toBe(8888);
  });

  it('deleteTarget removes config and its assignments', async () => {
    await repo.upsertTarget(baseConfig());
    await repo.recordAssignment('source-a', 111, 222, 'discovery', 1000);
    await repo.deleteTarget('source-a', 111);
    expect(await repo.getTarget('source-a', 111)).toBeNull();
    expect(await repo.getAssignments('source-a', 111)).toHaveLength(0);
  });
});
