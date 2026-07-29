/**
 * TraceroutesRepository.getTraceroutesInvolvingNode — per-source isolation
 * tests (phase 2 §8.3). Template: mqttPacketLog.perSource.test.ts.
 *
 * The JS participation filter runs AFTER the source-scoped WHERE clause, so
 * these tests are the ones that would catch a dropped `withSourceScope` call
 * — a query for source-a leaking source-b's hop-only participation would
 * otherwise slip past `traceroutes.participation.test.ts`, which never
 * exercises two sources at once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { TraceroutesRepository } from './traceroutes.js';
import { ALL_SOURCES } from './base.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import { DbTraceroute } from '../types.js';

function makeTraceroute(overrides: Partial<DbTraceroute> = {}): DbTraceroute {
  const now = Date.now();
  return {
    fromNodeNum: 1001,
    toNodeNum: 2002,
    fromNodeId: '!aabb1001',
    toNodeId: '!aabb2002',
    route: null,
    routeBack: null,
    snrTowards: null,
    snrBack: null,
    timestamp: now,
    createdAt: now,
    ...overrides,
  };
}

describe('TraceroutesRepository.getTraceroutesInvolvingNode — per-source isolation', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: TraceroutesRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new TraceroutesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('the same nodeNum participating on source-a and source-b is isolated per source', async () => {
    await repo.insertTraceroute(makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, packetId: 1 }), 'source-a');
    await repo.insertTraceroute(makeTraceroute({ fromNodeNum: 111, toNodeNum: 333, packetId: 2 }), 'source-b');

    const aResult = await repo.getTraceroutesInvolvingNode(111, { sourceId: 'source-a', sinceTimestamp: 0 });
    expect(aResult).toHaveLength(1);
    expect(aResult[0].packetId).toBe(1);

    const bResult = await repo.getTraceroutesInvolvingNode(111, { sourceId: 'source-b', sinceTimestamp: 0 });
    expect(bResult).toHaveLength(1);
    expect(bResult[0].packetId).toBe(2);
  });

  it('hop-only participation is source-isolated (the JS filter must not leak across the scoped WHERE)', async () => {
    await repo.insertTraceroute(
      makeTraceroute({ fromNodeNum: 500, toNodeNum: 600, route: '[111]', packetId: 10 }),
      'source-a',
    );
    await repo.insertTraceroute(
      makeTraceroute({ fromNodeNum: 700, toNodeNum: 800, route: '[111]', packetId: 20 }),
      'source-b',
    );

    const aResult = await repo.getTraceroutesInvolvingNode(111, { sourceId: 'source-a', sinceTimestamp: 0 });
    expect(aResult).toHaveLength(1);
    expect(aResult[0].packetId).toBe(10);
    expect(aResult[0].participation).toBe('hop');

    const bResult = await repo.getTraceroutesInvolvingNode(111, { sourceId: 'source-b', sinceTimestamp: 0 });
    expect(bResult).toHaveLength(1);
    expect(bResult[0].packetId).toBe(20);
    expect(bResult[0].participation).toBe('hop');
  });

  it('ALL_SOURCES returns rows from both sources (documents the explicit opt-in)', async () => {
    await repo.insertTraceroute(makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, packetId: 1 }), 'source-a');
    await repo.insertTraceroute(makeTraceroute({ fromNodeNum: 111, toNodeNum: 333, packetId: 2 }), 'source-b');

    const result = await repo.getTraceroutesInvolvingNode(111, { sourceId: ALL_SOURCES, sinceTimestamp: 0 });
    expect(result).toHaveLength(2);
    expect(result.map(r => r.packetId).sort()).toEqual([1, 2]);
  });
});
