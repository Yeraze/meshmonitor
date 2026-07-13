/**
 * MeshCore position-history tests (#3852).
 *
 * Covers the movement-trail storage that backs the MeshCore map overlay:
 * - upsertNode transparently records a point when a node's GPS fix moves,
 * - stationary re-reports (identical / sub-epsilon) are deduped,
 * - getPositionHistory returns points oldest-first and honors `since`,
 * - retention + per-source deletion behave, and rows are source-scoped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MeshCoreRepository } from './meshcore.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('MeshCoreRepository — position history', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MeshCoreRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('upsertNode records a trail point on first fix and on movement, deduping stationary re-reports', async () => {
    // First fix → one point.
    await repo.upsertNode({ publicKey: 'pk1', latitude: 40.0, longitude: -75.0, lastHeard: 1000 }, 'src-a');
    // Identical re-report → no new point.
    await repo.upsertNode({ publicKey: 'pk1', latitude: 40.0, longitude: -75.0, lastHeard: 2000 }, 'src-a');
    // Sub-epsilon jitter → no new point.
    await repo.upsertNode({ publicKey: 'pk1', latitude: 40.0000001, longitude: -75.0000001, lastHeard: 3000 }, 'src-a');
    // Real movement → second point.
    await repo.upsertNode({ publicKey: 'pk1', latitude: 40.5, longitude: -75.5, lastHeard: 4000 }, 'src-a');

    const points = await repo.getPositionHistory('src-a', 'pk1');
    expect(points).toHaveLength(2);
    // Oldest-first ordering.
    expect(points[0].timestamp).toBe(1000);
    expect(points[1].timestamp).toBe(4000);
    expect(points[1].latitude).toBeCloseTo(40.5);
  });

  it('does not record Null Island or absent positions', async () => {
    await repo.upsertNode({ publicKey: 'pk2', latitude: 0, longitude: 0, lastHeard: 1000 }, 'src-a');
    await repo.upsertNode({ publicKey: 'pk2', name: 'no-gps', lastHeard: 2000 }, 'src-a');
    const points = await repo.getPositionHistory('src-a', 'pk2');
    expect(points).toHaveLength(0);
  });

  it('never persists an out-of-range position, and does not clobber a stored valid fix', async () => {
    // Establish a valid fix.
    await repo.upsertNode({ publicKey: 'pk-guard', latitude: 26.331349, longitude: -80.268578, lastHeard: 1000 }, 'src-a');
    // A junk advert (out of range) must NOT overwrite it.
    await repo.upsertNode({ publicKey: 'pk-guard', latitude: 1853.453892, longitude: -1598.745966, lastHeard: 2000 }, 'src-a');

    const kept = await repo.getNodeByPublicKeyAndSource('pk-guard', 'src-a');
    expect(kept?.latitude).toBeCloseTo(26.331349);
    expect(kept?.longitude).toBeCloseTo(-80.268578);
    // The junk fix is not recorded in the movement trail either.
    expect(await repo.getPositionHistory('src-a', 'pk-guard')).toHaveLength(1);
  });

  it('a brand-new node reporting only an out-of-range position is stored with no position', async () => {
    await repo.upsertNode({ publicKey: 'pk-junk-only', name: 'Junk', latitude: 540.096308, longitude: 4.408389, lastHeard: 1000 }, 'src-a');
    const row = await repo.getNodeByPublicKeyAndSource('pk-junk-only', 'src-a');
    expect(row).toBeDefined();
    expect(row?.latitude ?? null).toBeNull();
    expect(row?.longitude ?? null).toBeNull();
  });

  it('getPositionHistory honors the `since` window', async () => {
    await repo.upsertNode({ publicKey: 'pk3', latitude: 10, longitude: 10, lastHeard: 1000 }, 'src-a');
    await repo.upsertNode({ publicKey: 'pk3', latitude: 11, longitude: 11, lastHeard: 5000 }, 'src-a');
    await repo.upsertNode({ publicKey: 'pk3', latitude: 12, longitude: 12, lastHeard: 9000 }, 'src-a');

    const recent = await repo.getPositionHistory('src-a', 'pk3', 5000);
    expect(recent.map(p => p.timestamp)).toEqual([5000, 9000]);
  });

  it('points are source-scoped', async () => {
    await repo.upsertNode({ publicKey: 'pk4', latitude: 1, longitude: 1, lastHeard: 1000 }, 'src-a');
    await repo.upsertNode({ publicKey: 'pk4', latitude: 2, longitude: 2, lastHeard: 1000 }, 'src-b');

    expect(await repo.getPositionHistory('src-a', 'pk4')).toHaveLength(1);
    expect(await repo.getPositionHistory('src-b', 'pk4')).toHaveLength(1);
  });

  it('deletePositionHistoryOlderThan prunes the rolling window', async () => {
    await repo.upsertNode({ publicKey: 'pk5', latitude: 1, longitude: 1, lastHeard: 1000 }, 'src-a');
    await repo.upsertNode({ publicKey: 'pk5', latitude: 2, longitude: 2, lastHeard: 5000 }, 'src-a');

    const removed = await repo.deletePositionHistoryOlderThan(4000);
    expect(removed).toBe(1);
    const remaining = await repo.getPositionHistory('src-a', 'pk5');
    expect(remaining.map(p => p.timestamp)).toEqual([5000]);
  });

  it('deleteAllPositionHistory clears one source only when scoped', async () => {
    await repo.upsertNode({ publicKey: 'pk6', latitude: 1, longitude: 1, lastHeard: 1000 }, 'src-a');
    await repo.upsertNode({ publicKey: 'pk6', latitude: 1, longitude: 1, lastHeard: 1000 }, 'src-b');

    const removed = await repo.deleteAllPositionHistory('src-a');
    expect(removed).toBe(1);
    expect(await repo.getPositionHistory('src-a', 'pk6')).toHaveLength(0);
    expect(await repo.getPositionHistory('src-b', 'pk6')).toHaveLength(1);
  });
});
