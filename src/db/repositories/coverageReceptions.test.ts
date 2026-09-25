/**
 * CoverageReceptionsRepository — unit tests (Coverage Report epic #5277,
 * Phase 1 WP1). Runs against SQLite via `createTestDb()` (full migration
 * registry, including migration 172) — PG/MySQL DDL/behaviour is covered
 * separately by `172_create_coverage_receptions.pgmysql.test.ts` and
 * `coverageReceptions.multiBackend.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  CoverageReceptionsRepository,
  type RecordCoverageReceptionParams,
} from './coverageReceptions.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const NOW = 1_760_000_000_000;

function makeReception(overrides: Partial<RecordCoverageReceptionParams> = {}): RecordCoverageReceptionParams {
  return {
    sourceId: 'src-a',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aaaaaaaa',
    receiverNodeNum: 0xaaaaaaaa,
    receiverLatitude: 40.0,
    receiverLongitude: -105.0,
    senderId: '!bbbbbbbb',
    senderNodeNum: 0xbbbbbbbb,
    packetKey: '100',
    packetId: 100,
    pathKey: 'r0:h0',
    latitude: 40.1,
    longitude: -105.1,
    altitude: 1600,
    precisionBits: 16,
    snr: 5.5,
    rssi: -80,
    hopStart: 3,
    hopLimit: 3,
    hopsAway: 0,
    relayNode: 0,
    transportMechanism: 0,
    channel: 0,
    rxTime: Math.floor(NOW / 1000),
    receivedAt: NOW,
    ...overrides,
  };
}

describe('CoverageReceptionsRepository', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: CoverageReceptionsRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new CoverageReceptionsRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  describe('recordReception', () => {
    it('requires a sourceId', async () => {
      await expect(repo.recordReception(makeReception({ sourceId: '' }))).rejects.toThrow(/sourceId/);
    });

    it('requires a receiverId', async () => {
      await expect(repo.recordReception(makeReception({ receiverId: '' }))).rejects.toThrow(/receiverId/);
    });

    it('requires a senderId', async () => {
      await expect(repo.recordReception(makeReception({ senderId: '' }))).rejects.toThrow(/senderId/);
    });

    it('requires a packetKey', async () => {
      await expect(repo.recordReception(makeReception({ packetKey: '' }))).rejects.toThrow(/packetKey/);
    });

    it('requires a pathKey', async () => {
      await expect(repo.recordReception(makeReception({ pathKey: '' }))).rejects.toThrow(/pathKey/);
    });

    it('inserts a new row and returns true', async () => {
      const inserted = await repo.recordReception(makeReception());
      expect(inserted).toBe(true);

      const page = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ sourceId: 'src-a', senderId: '!bbbbbbbb', pathKey: 'r0:h0' });
    });

    it('a duplicate on the full unique key returns false and does not add a row', async () => {
      expect(await repo.recordReception(makeReception())).toBe(true);
      expect(await repo.recordReception(makeReception())).toBe(false);

      const page = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
      expect(page.items).toHaveLength(1);
    });

    it('a different pathKey gives a new row', async () => {
      expect(await repo.recordReception(makeReception({ pathKey: 'r0:h0' }))).toBe(true);
      expect(await repo.recordReception(makeReception({ pathKey: 'r5:h1' }))).toBe(true);

      const page = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
      expect(page.items).toHaveLength(2);
    });

    it('a different receiverId gives a new row', async () => {
      expect(await repo.recordReception(makeReception({ receiverId: '!aaaaaaaa' }))).toBe(true);
      expect(await repo.recordReception(makeReception({ receiverId: '!cccccccc' }))).toBe(true);

      const page = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
      expect(page.items).toHaveLength(2);
    });

    it('keeps explicit 0 RSSI and null SNR distinct from missing values', async () => {
      await repo.recordReception(makeReception({ snr: null, rssi: 0 }));
      const page = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
      expect(page.items[0].snr).toBeNull();
      expect(page.items[0].rssi).toBe(0);
    });
  });

  describe('getReceptions', () => {
    it('returns an empty page for an empty sourceIds array', async () => {
      await repo.recordReception(makeReception());
      const page = await repo.getReceptions({ sourceIds: [], sinceMs: 0, untilMs: NOW + 1, pageSize: 10 });
      expect(page).toEqual({ items: [], pageSize: 10, hasMore: false, nextCursor: null });
    });

    it('respects the [sinceMs, untilMs] window', async () => {
      await repo.recordReception(makeReception({ pathKey: 'r0:h0', receivedAt: NOW }));
      await repo.recordReception(makeReception({ pathKey: 'r0:h1', receivedAt: NOW + 10_000 }));
      await repo.recordReception(makeReception({ pathKey: 'r0:h2', receivedAt: NOW + 20_000 }));

      const page = await repo.getReceptions({
        sourceIds: ['src-a'], sinceMs: NOW + 5_000, untilMs: NOW + 15_000, pageSize: 10,
      });
      expect(page.items.map((r) => r.pathKey)).toEqual(['r0:h1']);
    });

    it('filters by senderId', async () => {
      await repo.recordReception(makeReception({ senderId: '!bbbbbbbb', pathKey: 'p1' }));
      await repo.recordReception(makeReception({ senderId: '!dddddddd', pathKey: 'p2' }));

      const page = await repo.getReceptions({
        sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, senderId: '!dddddddd', pageSize: 10,
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0].senderId).toBe('!dddddddd');
    });

    it('filters by an include receiverFilter entry', async () => {
      await repo.recordReception(makeReception({ receiverId: '!aaaaaaaa', pathKey: 'p1' }));
      await repo.recordReception(makeReception({ receiverId: '!cccccccc', pathKey: 'p2' }));

      const page = await repo.getReceptions({
        sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10,
        receiverFilter: [{ sourceId: 'src-a', mode: 'include', receiverIds: ['!cccccccc'] }],
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0].receiverId).toBe('!cccccccc');
    });

    it('filters by an exclude receiverFilter entry', async () => {
      await repo.recordReception(makeReception({ receiverId: '!aaaaaaaa', pathKey: 'p1' }));
      await repo.recordReception(makeReception({ receiverId: '!cccccccc', pathKey: 'p2' }));

      const page = await repo.getReceptions({
        sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10,
        receiverFilter: [{ sourceId: 'src-a', mode: 'exclude', receiverIds: ['!cccccccc'] }],
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0].receiverId).toBe('!aaaaaaaa');
    });

    it('the same receiverId on two sources: an include on A never leaks B (P1 bug fix)', async () => {
      await repo.recordReception(makeReception({ sourceId: 'src-a', receiverId: '!shared', pathKey: 'pa' }));
      await repo.recordReception(makeReception({ sourceId: 'src-b', receiverId: '!shared', pathKey: 'pb' }));

      const page = await repo.getReceptions({
        sourceIds: ['src-a', 'src-b'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10,
        receiverFilter: [{ sourceId: 'src-a', mode: 'include', receiverIds: ['!shared'] }],
      });
      // src-a is constrained to !shared (matches); src-b has no entry, so it
      // stays fully unconstrained and its !shared row also matches.
      expect(page.items.map((r) => r.sourceId).sort()).toEqual(['src-a', 'src-b']);
    });

    it('a mixed include/exclude filter across two sources applies each independently', async () => {
      await repo.recordReception(makeReception({ sourceId: 'src-a', receiverId: '!a1', pathKey: 'a1' }));
      await repo.recordReception(makeReception({ sourceId: 'src-a', receiverId: '!a2', pathKey: 'a2' }));
      await repo.recordReception(makeReception({ sourceId: 'src-b', receiverId: '!b1', pathKey: 'b1' }));
      await repo.recordReception(makeReception({ sourceId: 'src-b', receiverId: '!b2', pathKey: 'b2' }));

      const page = await repo.getReceptions({
        sourceIds: ['src-a', 'src-b'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10,
        receiverFilter: [
          { sourceId: 'src-a', mode: 'include', receiverIds: ['!a1'] },
          { sourceId: 'src-b', mode: 'exclude', receiverIds: ['!b1'] },
        ],
      });
      expect(page.items.map((r) => r.receiverId).sort()).toEqual(['!a1', '!b2']);
    });

    it('drops a receiverFilter entry whose sourceId is not in the permitted sourceIds', async () => {
      await repo.recordReception(makeReception({ sourceId: 'src-a', receiverId: '!a1', pathKey: 'a1' }));

      const page = await repo.getReceptions({
        sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10,
        // src-b isn't permitted — this entry must be dropped, not widen the query.
        receiverFilter: [{ sourceId: 'src-b', mode: 'include', receiverIds: ['!nope'] }],
      });
      // src-a has no entry of its own, so it stays fully unconstrained.
      expect(page.items.map((r) => r.receiverId)).toEqual(['!a1']);
    });

    it('an empty result when every entry is dropped and no source is unconstrained', async () => {
      await repo.recordReception(makeReception({ sourceId: 'src-a', receiverId: '!a1', pathKey: 'a1' }));

      const page = await repo.getReceptions({
        sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 10,
        receiverFilter: [{ sourceId: 'src-a', mode: 'include', receiverIds: [] }],
      });
      expect(page.items).toEqual([]);
    });

    it('hops "exact" matches only the given hop count', async () => {
      await repo.recordReception(makeReception({ pathKey: 'p0', hopsAway: 0 }));
      await repo.recordReception(makeReception({ pathKey: 'p1', hopsAway: 1 }));
      await repo.recordReception(makeReception({ pathKey: 'p2', hopsAway: 2 }));

      const page = await repo.getReceptions({
        sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, hops: 1, hopsMode: 'exact', pageSize: 10,
      });
      expect(page.items.map((r) => r.pathKey)).toEqual(['p1']);
    });

    it('hops "max" matches hopsAway <= N', async () => {
      await repo.recordReception(makeReception({ pathKey: 'p0', hopsAway: 0 }));
      await repo.recordReception(makeReception({ pathKey: 'p1', hopsAway: 1 }));
      await repo.recordReception(makeReception({ pathKey: 'p2', hopsAway: 2 }));

      const page = await repo.getReceptions({
        sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, hops: 1, hopsMode: 'max', pageSize: 10,
      });
      expect(page.items.map((r) => r.pathKey).sort()).toEqual(['p0', 'p1']);
    });

    it('excludes NULL hopsAway rows whenever a hops filter is set', async () => {
      await repo.recordReception(makeReception({ pathKey: 'p-unknown', hopsAway: null }));
      await repo.recordReception(makeReception({ pathKey: 'p0', hopsAway: 0 }));

      const page = await repo.getReceptions({
        sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, hops: 0, hopsMode: 'max', pageSize: 10,
      });
      expect(page.items.map((r) => r.pathKey)).toEqual(['p0']);
    });

    it('paginates via cursor with no skip or repeat, including equal receivedAt', async () => {
      // Two rows share the same receivedAt to exercise the (receivedAt, id) tiebreak.
      await repo.recordReception(makeReception({ pathKey: 'p1', receivedAt: NOW }));
      await repo.recordReception(makeReception({ pathKey: 'p2', receivedAt: NOW }));
      await repo.recordReception(makeReception({ pathKey: 'p3', receivedAt: NOW + 1000 }));

      const page1 = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 2000, pageSize: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await repo.getReceptions({
        sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 2000, pageSize: 2, cursor: page1.nextCursor,
      });
      expect(page2.items).toHaveLength(1);
      expect(page2.hasMore).toBe(false);
      expect(page2.nextCursor).toBeNull();

      const allPathKeys = [...page1.items, ...page2.items].map((r) => r.pathKey).sort();
      expect(allPathKeys).toEqual(['p1', 'p2', 'p3']);
    });

    it('clamps pageSize to [1, 2000]', async () => {
      await repo.recordReception(makeReception());
      const tooSmall = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 0 });
      expect(tooSmall.pageSize).toBe(1);
      const tooBig = await repo.getReceptions({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1, pageSize: 5000 });
      expect(tooBig.pageSize).toBe(2000);
    });
  });

  describe('getReceivers', () => {
    it('returns [] for an empty sourceIds array', async () => {
      await repo.recordReception(makeReception());
      expect(await repo.getReceivers({ sourceIds: [], sinceMs: 0 })).toEqual([]);
    });

    it('returns one row per distinct (sourceId, receiverKind, receiverId, receiverNodeNum)', async () => {
      await repo.recordReception(makeReception({ receiverId: '!aaaaaaaa', pathKey: 'p1' }));
      await repo.recordReception(makeReception({ receiverId: '!aaaaaaaa', pathKey: 'p2' }));
      await repo.recordReception(makeReception({ receiverId: '!cccccccc', receiverNodeNum: 0xcccccccc, pathKey: 'p3' }));

      const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0 });
      expect(receivers).toHaveLength(2);
      expect(receivers.map((r) => r.receiverId).sort()).toEqual(['!aaaaaaaa', '!cccccccc']);
    });

    it('respects sinceMs', async () => {
      await repo.recordReception(makeReception({ receiverId: '!aaaaaaaa', pathKey: 'p1', receivedAt: NOW }));
      const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: NOW + 1000 });
      expect(receivers).toEqual([]);
    });

    it('untilMs omitted is unbounded — includes a row that a bound would exclude (#5277 Phase 4b WP2)', async () => {
      await repo.recordReception(makeReception({ receiverId: '!aaaaaaaa', pathKey: 'p1', receivedAt: NOW + 100_000 }));
      const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0 });
      expect(receivers).toHaveLength(1);
    });

    it('untilMs excludes a row received after it', async () => {
      await repo.recordReception(makeReception({ receiverId: '!aaaaaaaa', pathKey: 'p1', receivedAt: NOW + 100_000 }));
      const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW });
      expect(receivers).toEqual([]);
    });

    it('untilMs is inclusive at the boundary', async () => {
      await repo.recordReception(makeReception({ receiverId: '!aaaaaaaa', pathKey: 'p1', receivedAt: NOW }));
      const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW });
      expect(receivers).toHaveLength(1);
    });

    it('with untilMs, lastReceivedAt and the snapshot both stay within the window (an old survey re-queried later)', async () => {
      await repo.recordReception(makeReception({
        pathKey: 'p1', receivedAt: NOW, receiverLatitude: 40.0, receiverLongitude: -105.0,
      }));
      // A newer reception, outside the survey's window, must not leak into
      // either lastReceivedAt or the position snapshot when untilMs is given.
      await repo.recordReception(makeReception({
        pathKey: 'p2', receivedAt: NOW + 50_000, receiverLatitude: 41.0, receiverLongitude: -106.0,
      }));

      const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 1000 });
      expect(receivers).toHaveLength(1);
      expect(receivers[0].lastReceivedAt).toBe(NOW);
      expect(receivers[0].receiverLatitude).toBe(40.0);
      expect(receivers[0].receiverLongitude).toBe(-105.0);
      expect(receivers[0].receptionCount).toBe(1);
    });

    it('lastReceivedAt is the MAX(receivedAt) across the group', async () => {
      await repo.recordReception(makeReception({ pathKey: 'p1', receivedAt: NOW }));
      await repo.recordReception(makeReception({ pathKey: 'p2', receivedAt: NOW + 5000 }));

      const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0 });
      expect(receivers).toHaveLength(1);
      expect(receivers[0].lastReceivedAt).toBe(NOW + 5000);
    });

    it('returns the latest non-null snapshot, even when the newest row has a null snapshot', async () => {
      await repo.recordReception(makeReception({
        pathKey: 'p1', receivedAt: NOW, receiverLatitude: 40.0, receiverLongitude: -105.0,
      }));
      await repo.recordReception(makeReception({
        pathKey: 'p2', receivedAt: NOW + 5000, receiverLatitude: null, receiverLongitude: null,
      }));

      const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0 });
      expect(receivers).toHaveLength(1);
      // lastReceivedAt reflects the absolute newest row...
      expect(receivers[0].lastReceivedAt).toBe(NOW + 5000);
      // ...but the snapshot falls back to the newest row that HAS one.
      expect(receivers[0].receiverLatitude).toBe(40.0);
      expect(receivers[0].receiverLongitude).toBe(-105.0);
    });

    it('a receiver with no snapshot ever recorded has null coordinates', async () => {
      await repo.recordReception(makeReception({
        pathKey: 'p1', receiverLatitude: null, receiverLongitude: null,
      }));

      const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0 });
      expect(receivers).toHaveLength(1);
      expect(receivers[0].receiverLatitude).toBeNull();
      expect(receivers[0].receiverLongitude).toBeNull();
    });

    it('receptionCount counts every row in the group, not just distinct fixes', async () => {
      await repo.recordReception(makeReception({ pathKey: 'p1' }));
      await repo.recordReception(makeReception({ pathKey: 'p2' }));
      await repo.recordReception(makeReception({ pathKey: 'p3' }));

      const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0 });
      expect(receivers).toHaveLength(1);
      expect(receivers[0].receptionCount).toBe(3);
    });

    it('handles 250+ distinct receivers, crossing the 200-chunk boundary, with the right snapshot per receiver (Decision D9)', async () => {
      const total = 250;
      for (let i = 0; i < total; i++) {
        const id = `!${i.toString(16).padStart(8, '0')}`;
        await repo.recordReception(makeReception({
          receiverId: id,
          receiverNodeNum: i,
          pathKey: `p-${i}`,
          receiverLatitude: 40 + i * 0.001,
          receiverLongitude: -105 - i * 0.001,
        }));
      }

      const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0 });
      expect(receivers).toHaveLength(total);
      for (const r of receivers) {
        const i = Number(r.receiverNodeNum);
        expect(r.receiverLatitude).toBeCloseTo(40 + i * 0.001, 6);
        expect(r.receiverLongitude).toBeCloseTo(-105 - i * 0.001, 6);
        expect(r.receptionCount).toBe(1);
      }
    });

    it('bounds the query count to 1 + ceil(N/200) for the snapshot follow-up', async () => {
      const total = 450; // ceil(450/200) = 3 follow-up chunks
      for (let i = 0; i < total; i++) {
        await repo.recordReception(makeReception({
          receiverId: `!${i.toString(16).padStart(8, '0')}`,
          receiverNodeNum: i,
          pathKey: `p-${i}`,
        }));
      }

      const selectSpy = vi.spyOn(drizzleDb, 'select');
      const receivers = await repo.getReceivers({ sourceIds: ['src-a'], sinceMs: 0 });
      expect(receivers).toHaveLength(total);
      // 1 GROUP BY query + ceil(450/200) = 3 batched snapshot queries.
      expect(selectSpy).toHaveBeenCalledTimes(4);
      selectSpy.mockRestore();
    });
  });

  describe('getSenderSummary', () => {
    it('returns [] for an empty sourceIds array', async () => {
      await repo.recordReception(makeReception());
      expect(await repo.getSenderSummary({ sourceIds: [], sinceMs: 0, untilMs: NOW + 1, limit: 10 })).toEqual([]);
    });

    it('counts DISTINCT packetKey per sender (multiple receptions of one fix count once)', async () => {
      await repo.recordReception(makeReception({ receiverId: '!aaaaaaaa', packetKey: '100', pathKey: 'p1' }));
      await repo.recordReception(makeReception({ receiverId: '!cccccccc', packetKey: '100', pathKey: 'p2' }));
      await repo.recordReception(makeReception({ receiverId: '!aaaaaaaa', packetKey: '101', pathKey: 'p3', receivedAt: NOW + 1000 }));

      const senders = await repo.getSenderSummary({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 2000, limit: 10 });
      expect(senders).toHaveLength(1);
      expect(senders[0].fixCount).toBe(2);
      expect(senders[0].lastReceivedAt).toBe(NOW + 1000);
    });

    it('orders newest-first', async () => {
      await repo.recordReception(makeReception({ senderId: '!bbbbbbbb', packetKey: '100', pathKey: 'p1', receivedAt: NOW }));
      await repo.recordReception(makeReception({ senderId: '!dddddddd', packetKey: '200', pathKey: 'p2', receivedAt: NOW + 5000 }));

      const senders = await repo.getSenderSummary({ sourceIds: ['src-a'], sinceMs: 0, untilMs: NOW + 6000, limit: 10 });
      expect(senders.map((s) => s.senderId)).toEqual(['!dddddddd', '!bbbbbbbb']);
    });
  });
});
