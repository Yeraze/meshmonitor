/**
 * Integration test for the fail-closed withSourceScope (Task 1.1).
 *
 * Seeds nodes across two sources and verifies:
 *   - getAllNodes(sourceId)   → only that source's rows
 *   - getAllNodes(ALL_SOURCES) → rows from both sources
 *   - getAllNodes(undefined)  → throws (fail-closed)
 *
 * Also verifies:
 *   - getNodeCount is scoped vs ALL_SOURCES (regression lock for #15 fix)
 *
 * Uses the createTestDb() harness (same pattern as
 * messages.distinctChannels.perSource.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { NodesRepository } from './nodes.js';
import { ALL_SOURCES } from './base.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('NodesRepository — withSourceScope isolation (Task 1.1)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: NodesRepository;

  const now = Date.now();

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new NodesRepository(drizzleDb, 'sqlite');

    // Seed two nodes — one per source
    db.prepare(
      'INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
    ).run(1001, '!000003e9', 'mqtt-1', now, now);

    db.prepare(
      'INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
    ).run(2002, '!000007d2', 'mqtt-2', now, now);
  });

  afterEach(() => db.close());

  // -------------------------------------------------------------------------
  // Isolation
  // -------------------------------------------------------------------------

  it('getAllNodes(sourceId) returns only that source\'s rows', async () => {
    const rows1 = await repo.getAllNodes('mqtt-1');
    expect(rows1.map((r) => String(r.nodeId))).toEqual(['!000003e9']);

    const rows2 = await repo.getAllNodes('mqtt-2');
    expect(rows2.map((r) => String(r.nodeId))).toEqual(['!000007d2']);
  });

  it('getAllNodes(ALL_SOURCES) returns rows from all sources', async () => {
    const rows = await repo.getAllNodes(ALL_SOURCES);
    const nodeIds = rows.map((r) => String(r.nodeId)).sort();
    expect(nodeIds).toEqual(['!000003e9', '!000007d2']);
  });

  // @ts-expect-error -- Tier-2 required param: omitting sourceId must be a compile error
  it('getAllNodes(undefined) rejects with fail-closed error', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(repo.getAllNodes(undefined as any)).rejects.toThrow(
      /sourceId is required/,
    );
  });

  // -------------------------------------------------------------------------
  // getNodeCount regression lock (spec §7.3 — fixing the #15 server.ts leak)
  // -------------------------------------------------------------------------

  it('getNodeCount per-source is less than getNodeCount(ALL_SOURCES) when both populated', async () => {
    const countSrc1 = await repo.getNodeCount('mqtt-1');
    const countSrc2 = await repo.getNodeCount('mqtt-2');
    const countAll = await repo.getNodeCount(ALL_SOURCES);

    expect(countSrc1).toBe(1);
    expect(countSrc2).toBe(1);
    expect(countAll).toBe(2);
    expect(countAll).toBeGreaterThan(countSrc1);
    expect(countAll).toBeGreaterThan(countSrc2);
  });

  it('getNodeCount(undefined) rejects with fail-closed error', async () => {
    // @ts-expect-error -- Tier-2 required param: must be a compile error
    await expect(repo.getNodeCount(undefined as any)).rejects.toThrow(
      /sourceId is required/,
    );
  });
});
