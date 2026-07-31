/**
 * TraceroutesRepository.getTraceroutesInvolvingNode — SQLite tests.
 *
 * The participation filter (`tracerouteParticipationKind`) is pure JS and
 * dialect-independent, so the PG/MySQL matrices `traceroutes.test.ts` runs
 * are NOT duplicated here — `tracerouteSegments.test.ts` §8.1 already covers
 * the only backend-sensitive part (string-typed node numbers). No schema
 * change means no `nodes.test.ts` DDL edit either.
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

describe('TraceroutesRepository.getTraceroutesInvolvingNode (phase 2 §4/§8.2)', () => {
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

  it('returns a row where the node is the "from" endpoint', async () => {
    await repo.insertTraceroute(makeTraceroute({ fromNodeNum: 111, toNodeNum: 222 }), 'src-a');
    const result = await repo.getTraceroutesInvolvingNode(111, { sourceId: 'src-a', sinceTimestamp: 0 });
    expect(result).toHaveLength(1);
    expect(result[0].participation).toBe('endpoint');
  });

  it('returns a row where the node is the "to" endpoint', async () => {
    await repo.insertTraceroute(makeTraceroute({ fromNodeNum: 111, toNodeNum: 222 }), 'src-a');
    const result = await repo.getTraceroutesInvolvingNode(222, { sourceId: 'src-a', sinceTimestamp: 0 });
    expect(result).toHaveLength(1);
    expect(result[0].participation).toBe('endpoint');
  });

  it('returns a row where the node is a route hop', async () => {
    await repo.insertTraceroute(
      makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, route: '[333,444]' }),
      'src-a',
    );
    const result = await repo.getTraceroutesInvolvingNode(333, { sourceId: 'src-a', sinceTimestamp: 0 });
    expect(result).toHaveLength(1);
    expect(result[0].participation).toBe('hop');
  });

  it('returns a row where the node is a routeBack hop', async () => {
    await repo.insertTraceroute(
      makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, routeBack: '[555]' }),
      'src-a',
    );
    const result = await repo.getTraceroutesInvolvingNode(555, { sourceId: 'src-a', sinceTimestamp: 0 });
    expect(result).toHaveLength(1);
    expect(result[0].participation).toBe('hop');
  });

  it('excludes non-participants', async () => {
    await repo.insertTraceroute(
      makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, route: '[333]', routeBack: '[444]' }),
      'src-a',
    );
    const result = await repo.getTraceroutesInvolvingNode(999, { sourceId: 'src-a', sinceTimestamp: 0 });
    expect(result).toHaveLength(0);
  });

  it('excludes rows older than sinceTimestamp', async () => {
    const now = Date.now();
    await repo.insertTraceroute(
      makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, timestamp: now - 100_000 }),
      'src-a',
    );
    await repo.insertTraceroute(
      makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, timestamp: now }),
      'src-a',
    );
    const result = await repo.getTraceroutesInvolvingNode(111, {
      sourceId: 'src-a',
      sinceTimestamp: now - 1000,
    });
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(now);
  });

  it('sinceTimestamp omitted applies no time filter (picker/History-dialog parity amendment)', async () => {
    const now = Date.now();
    // Well outside the old 7-day (168h) default window.
    const veryOld = now - 30 * 24 * 60 * 60 * 1000;
    await repo.insertTraceroute(
      makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, timestamp: veryOld }),
      'src-a',
    );
    const result = await repo.getTraceroutesInvolvingNode(111, { sourceId: 'src-a' });
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(veryOld);
  });

  it('orders results newest-first', async () => {
    const now = Date.now();
    await repo.insertTraceroute(
      makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, timestamp: now, packetId: 1 }),
      'src-a',
    );
    await repo.insertTraceroute(
      makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, timestamp: now + 5000, packetId: 2 }),
      'src-a',
    );
    await repo.insertTraceroute(
      makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, timestamp: now + 2000, packetId: 3 }),
      'src-a',
    );
    const result = await repo.getTraceroutesInvolvingNode(111, { sourceId: 'src-a', sinceTimestamp: 0 });
    expect(result.map(r => r.packetId)).toEqual([2, 3, 1]);
  });

  it('limit caps the result', async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      await repo.insertTraceroute(
        makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, timestamp: now + i, packetId: i }),
        'src-a',
      );
    }
    const result = await repo.getTraceroutesInvolvingNode(111, {
      sourceId: 'src-a',
      sinceTimestamp: 0,
      limit: 3,
    });
    expect(result).toHaveLength(3);
    // Newest-first: packetIds 9, 8, 7.
    expect(result.map(r => r.packetId)).toEqual([9, 8, 7]);
  });

  it('scanLimit bounds the scan — deliberately drops older participations beyond it', async () => {
    const now = Date.now();
    const scanLimit = 20;
    // Insert scanLimit + 5 rows, newest-first by timestamp. Only the OLDEST
    // few (outside the scan window) participate; the rest are non-participant
    // filler so the scan has to walk the whole window without early-matching.
    for (let i = 0; i < scanLimit + 5; i++) {
      const isOldParticipant = i < 3; // oldest 3 rows (lowest timestamp) participate
      await repo.insertTraceroute(
        makeTraceroute({
          fromNodeNum: isOldParticipant ? 111 : 9999,
          toNodeNum: 8888,
          timestamp: now + i, // ascending — higher i = newer
          packetId: i,
        }),
        'src-a',
      );
    }
    const result = await repo.getTraceroutesInvolvingNode(111, {
      sourceId: 'src-a',
      sinceTimestamp: 0,
      scanLimit,
    });
    // The oldest 3 rows (packetId 0,1,2) fall outside the newest-`scanLimit`
    // window (rows with packetId >= 5 are the newest `scanLimit` rows), so
    // they are never scanned and the deliberate tradeoff drops them.
    expect(result).toHaveLength(0);
  });

  it('participation is "endpoint" vs "hop" correctly per row', async () => {
    await repo.insertTraceroute(
      makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, timestamp: Date.now(), packetId: 1 }),
      'src-a',
    );
    await repo.insertTraceroute(
      makeTraceroute({
        fromNodeNum: 333,
        toNodeNum: 444,
        route: '[111]',
        timestamp: Date.now() + 1,
        packetId: 2,
      }),
      'src-a',
    );
    const result = await repo.getTraceroutesInvolvingNode(111, { sourceId: 'src-a', sinceTimestamp: 0 });
    expect(result).toHaveLength(2);
    const byPacketId = new Map(result.map(r => [r.packetId, r.participation]));
    expect(byPacketId.get(1)).toBe('endpoint');
    expect(byPacketId.get(2)).toBe('hop');
  });

  it('sourceId: undefined throws (withSourceScope fail-closed)', async () => {
    await expect(
      repo.getTraceroutesInvolvingNode(111, { sourceId: undefined as any, sinceTimestamp: 0 }),
    ).rejects.toThrow(/sourceId/);
  });

  it('ALL_SOURCES returns rows regardless of source (explicit opt-in)', async () => {
    await repo.insertTraceroute(makeTraceroute({ fromNodeNum: 111, toNodeNum: 222 }), 'src-a');
    await repo.insertTraceroute(makeTraceroute({ fromNodeNum: 111, toNodeNum: 222 }), 'src-b');
    const result = await repo.getTraceroutesInvolvingNode(111, {
      sourceId: ALL_SOURCES,
      sinceTimestamp: 0,
    });
    expect(result).toHaveLength(2);
  });

  // Relayed participation is MQTT-only; a Meshtastic/MeshCore source's picker
  // must list only the routes the node is an endpoint of.
  describe('endpointOnly', () => {
    /** One endpoint row + one relayed row, both involving node 111. */
    async function seedBoth() {
      await repo.insertTraceroute(
        makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, timestamp: Date.now(), packetId: 1 }),
        'src-a',
      );
      await repo.insertTraceroute(
        makeTraceroute({
          fromNodeNum: 333,
          toNodeNum: 444,
          route: '[111]',
          timestamp: Date.now() + 1,
          packetId: 2,
        }),
        'src-a',
      );
    }

    it('drops relayed rows and keeps endpoint rows', async () => {
      await seedBoth();
      const result = await repo.getTraceroutesInvolvingNode(111, {
        sourceId: 'src-a',
        endpointOnly: true,
      });
      expect(result).toHaveLength(1);
      expect(result[0].packetId).toBe(1);
      expect(result[0].participation).toBe('endpoint');
    });

    it('keeps relayed rows when not set (the MQTT path)', async () => {
      await seedBoth();
      const result = await repo.getTraceroutesInvolvingNode(111, { sourceId: 'src-a' });
      expect(result).toHaveLength(2);
      expect(result.map(r => r.participation).sort()).toEqual(['endpoint', 'hop']);
    });

    it('matches the node on either endpoint column', async () => {
      await repo.insertTraceroute(
        makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, packetId: 1 }),
        'src-a',
      );
      await repo.insertTraceroute(
        makeTraceroute({ fromNodeNum: 222, toNodeNum: 111, packetId: 2, timestamp: Date.now() + 1 }),
        'src-a',
      );
      const result = await repo.getTraceroutesInvolvingNode(111, {
        sourceId: 'src-a',
        endpointOnly: true,
      });
      expect(result).toHaveLength(2);
    });

    it('stays source-scoped', async () => {
      await repo.insertTraceroute(makeTraceroute({ fromNodeNum: 111, toNodeNum: 222 }), 'src-a');
      await repo.insertTraceroute(makeTraceroute({ fromNodeNum: 111, toNodeNum: 222 }), 'src-b');
      const result = await repo.getTraceroutesInvolvingNode(111, {
        sourceId: 'src-a',
        endpointOnly: true,
      });
      expect(result).toHaveLength(1);
    });

    it('honours sinceTimestamp and limit, newest first', async () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        await repo.insertTraceroute(
          makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, timestamp: now + i, packetId: i }),
          'src-a',
        );
      }
      const limited = await repo.getTraceroutesInvolvingNode(111, {
        sourceId: 'src-a',
        endpointOnly: true,
        limit: 2,
      });
      expect(limited).toHaveLength(2);
      expect(limited[0].packetId).toBe(4);

      const windowed = await repo.getTraceroutesInvolvingNode(111, {
        sourceId: 'src-a',
        endpointOnly: true,
        sinceTimestamp: now + 3,
      });
      expect(windowed).toHaveLength(2);
    });

    it('is not bounded by scanLimit — an old pair survives a busy source', async () => {
      const now = Date.now();
      // The node's only route is the oldest row, behind 30 unrelated ones.
      await repo.insertTraceroute(
        makeTraceroute({ fromNodeNum: 111, toNodeNum: 222, timestamp: now, packetId: 999 }),
        'src-a',
      );
      for (let i = 1; i <= 30; i++) {
        await repo.insertTraceroute(
          makeTraceroute({ fromNodeNum: 777, toNodeNum: 888, timestamp: now + i, packetId: i }),
          'src-a',
        );
      }
      // The scan window never reaches it...
      const scanned = await repo.getTraceroutesInvolvingNode(111, {
        sourceId: 'src-a',
        scanLimit: 5,
      });
      expect(scanned).toHaveLength(0);

      // ...but the pushed-down SQL predicate finds it regardless.
      const direct = await repo.getTraceroutesInvolvingNode(111, {
        sourceId: 'src-a',
        endpointOnly: true,
        scanLimit: 5,
      });
      expect(direct).toHaveLength(1);
      expect(direct[0].packetId).toBe(999);
    });
  });
});
