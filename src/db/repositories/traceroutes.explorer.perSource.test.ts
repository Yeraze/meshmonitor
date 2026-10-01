/**
 * TraceroutesRepository.getTraceroutesForSources — source isolation (#5511).
 * Template: traceroutes.participation.perSource.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { TraceroutesRepository } from './traceroutes.js';
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
    route: '[]',
    routeBack: '[]',
    snrTowards: null,
    snrBack: null,
    timestamp: now,
    createdAt: now,
    ...overrides,
  };
}

describe('TraceroutesRepository.getTraceroutesForSources — per-source isolation', () => {
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

  it('returns only rows from the listed sources, newest first', async () => {
    const now = Date.now();
    await repo.insertTraceroute(makeTraceroute({ packetId: 1, timestamp: now - 3000 }), 'source-a');
    await repo.insertTraceroute(makeTraceroute({ fromNodeNum: 3003, packetId: 2, timestamp: now - 1000 }), 'source-b');
    await repo.insertTraceroute(makeTraceroute({ fromNodeNum: 4004, packetId: 3, timestamp: now - 2000 }), 'source-c');

    const ab = await repo.getTraceroutesForSources({ sourceIds: ['source-a', 'source-b'], limit: 10 });
    expect(ab.map(r => r.packetId)).toEqual([2, 1]);
    expect(ab.map(r => r.sourceId)).toEqual(['source-b', 'source-a']);
  });

  it('returns nothing for an empty source list instead of every source', async () => {
    await repo.insertTraceroute(makeTraceroute({ packetId: 1 }), 'source-a');
    expect(await repo.getTraceroutesForSources({ sourceIds: [], limit: 10 })).toEqual([]);
  });

  it('applies sinceTimestamp and limit', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await repo.insertTraceroute(makeTraceroute({ fromNodeNum: 5000 + i, packetId: 10 + i, timestamp: now - i * 1000 }), 'source-a');
    }
    const recent = await repo.getTraceroutesForSources({ sourceIds: ['source-a'], sinceTimestamp: now - 2500, limit: 10 });
    expect(recent.map(r => r.packetId)).toEqual([10, 11, 12]);

    const capped = await repo.getTraceroutesForSources({ sourceIds: ['source-a'], limit: 2 });
    expect(capped.map(r => r.packetId)).toEqual([10, 11]);
  });
});
