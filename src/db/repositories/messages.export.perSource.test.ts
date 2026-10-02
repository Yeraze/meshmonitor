/**
 * MessagesRepository.getMessagesForExport + scoped searchMessages (#5517).
 *
 * The export query must never leave its source, must treat an empty channel
 * list as zero rows (not "no filter"), and must page by keyset in canonical
 * time order. Search gained the same per-source scoping.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import { PortNum } from '../../server/constants/meshtastic.js';

const NODE_A = 0x11111111;
const NODE_B = 0xaabbccdd;
const T0 = 1_760_000_000_000;

describe('MessagesRepository — export + scoped search per source (#5517)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MessagesRepository;
  let seq = 0;

  const insert = async (sourceId: string, overrides: Record<string, unknown> = {}) => {
    seq++;
    await repo.insertMessage(
      {
        id: `${sourceId}_${NODE_A}_${seq}`,
        fromNodeNum: NODE_A,
        toNodeNum: 0xffffffff,
        fromNodeId: '!11111111',
        toNodeId: '!ffffffff',
        text: `message ${seq}`,
        channel: 0,
        portnum: PortNum.TEXT_MESSAGE_APP,
        timestamp: T0 + seq * 1000,
        createdAt: T0 + seq * 1000,
        ...overrides,
      } as any,
      sourceId,
    );
  };

  beforeEach(() => {
    seq = 0;
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    const now = Date.now();
    for (const src of ['src-a', 'src-b']) {
      for (const [num, id] of [[NODE_A, '!11111111'], [NODE_B, '!aabbccdd'], [0xffffffff, '!ffffffff']] as const) {
        db.prepare('INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
          .run(num, id, src, now, now);
      }
    }
    repo = new MessagesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => db.close());

  describe('getMessagesForExport', () => {
    it('requires a sourceId', async () => {
      await expect(repo.getMessagesForExport({ sourceId: '', channels: 'all' })).rejects.toThrow(/sourceId/);
    });

    it('never returns another source’s rows', async () => {
      await insert('src-a', { text: 'alpha' });
      await insert('src-b', { text: 'bravo' });
      const rows = await repo.getMessagesForExport({ sourceId: 'src-a', channels: 'all' });
      expect(rows.map((r) => r.text)).toEqual(['alpha']);
    });

    it('treats an empty channel list as zero rows, not as no filter', async () => {
      await insert('src-a');
      expect(await repo.getMessagesForExport({ sourceId: 'src-a', channels: [] })).toEqual([]);
    });

    it('limits to the listed channels and the requested type', async () => {
      await insert('src-a', { channel: 0, text: 'ch0' });
      await insert('src-a', { channel: 2, text: 'ch2' });
      await insert('src-a', { channel: -1, text: 'dm', toNodeNum: NODE_B, toNodeId: '!aabbccdd' });
      const ch0AndDm = await repo.getMessagesForExport({ sourceId: 'src-a', channels: [0, -1] });
      expect(ch0AndDm.map((r) => r.text)).toEqual(['ch0', 'dm']);
      const dmsOnly = await repo.getMessagesForExport({ sourceId: 'src-a', channels: 'all', type: 'dms' });
      expect(dmsOnly.map((r) => r.text)).toEqual(['dm']);
      const channelsOnly = await repo.getMessagesForExport({ sourceId: 'src-a', channels: 'all', type: 'channels' });
      expect(channelsOnly.map((r) => r.text)).toEqual(['ch0', 'ch2']);
    });

    it('keeps rows with ANY include term (case-insensitive) and drops exclude terms', async () => {
      await insert('src-a', { text: 'Net check-in from W1AW' });
      await insert('src-a', { text: 'ICS-213 message follows' });
      await insert('src-a', { text: 'net test, ignore' });
      await insert('src-a', { text: 'unrelated' });
      const rows = await repo.getMessagesForExport({
        sourceId: 'src-a',
        channels: 'all',
        includeTerms: ['NET', 'ics-213'],
        excludeTerms: ['IGNORE'],
      });
      expect(rows.map((r) => r.text)).toEqual(['Net check-in from W1AW', 'ICS-213 message follows']);
    });

    it('matches % and _ literally', async () => {
      await insert('src-a', { text: '100% copy' });
      await insert('src-a', { text: '100 percent copy' });
      await insert('src-a', { text: 'node_1 up' });
      await insert('src-a', { text: 'nodeX1 up' });
      const pct = await repo.getMessagesForExport({ sourceId: 'src-a', channels: 'all', includeTerms: ['100%'] });
      expect(pct.map((r) => r.text)).toEqual(['100% copy']);
      const und = await repo.getMessagesForExport({ sourceId: 'src-a', channels: 'all', includeTerms: ['node_1'] });
      expect(und.map((r) => r.text)).toEqual(['node_1 up']);
    });

    it('filters dates in ms on the canonical time, falling back past an implausible rxTime', async () => {
      // rxTime 0 (MQTT unset) → the row's time is its timestamp, not 1970.
      await insert('src-a', { text: 'mqtt', rxTime: 0, timestamp: T0 + 50_000 });
      // A real rxTime wins over the timestamp.
      await insert('src-a', { text: 'rf', rxTime: T0 + 10_000, timestamp: T0 + 90_000 });
      const rows = await repo.getMessagesForExport({
        sourceId: 'src-a',
        channels: 'all',
        startMs: T0 + 40_000,
        endMs: T0 + 60_000,
      });
      expect(rows.map((r) => r.text)).toEqual(['mqtt']);
    });

    it('excludes traceroutes always and reactions unless asked', async () => {
      await insert('src-a', { text: 'plain' });
      await insert('src-a', { text: 'route', portnum: PortNum.TRACEROUTE_APP });
      await insert('src-a', { text: '👍', emoji: 1, replyId: 5 });
      const without = await repo.getMessagesForExport({ sourceId: 'src-a', channels: 'all' });
      expect(without.map((r) => r.text)).toEqual(['plain']);
      const withReactions = await repo.getMessagesForExport({ sourceId: 'src-a', channels: 'all', includeReactions: true });
      expect(withReactions.map((r) => r.text)).toEqual(['plain', '👍']);
    });

    it('filters by sender case-insensitively', async () => {
      await insert('src-a', { text: 'from a' });
      await insert('src-a', { text: 'from b', fromNodeNum: NODE_B, fromNodeId: '!aabbccdd' });
      const rows = await repo.getMessagesForExport({ sourceId: 'src-a', channels: 'all', fromNodeId: '!AABBCCDD' });
      expect(rows.map((r) => r.text)).toEqual(['from b']);
    });

    it('pages by keyset in time order, including rows that share a timestamp', async () => {
      for (let i = 0; i < 5; i++) await insert('src-a', { text: `same ${i}`, timestamp: T0, createdAt: T0 });
      await insert('src-a', { text: 'later', timestamp: T0 + 1 });
      const seen: string[] = [];
      let after: { time: number; id: string } | undefined;
      for (;;) {
        const page = await repo.getMessagesForExport({ sourceId: 'src-a', channels: 'all', after, limit: 2 });
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.text));
        const last = page[page.length - 1];
        after = { time: Number(last.timestamp), id: last.id };
      }
      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);
      expect(seen[5]).toBe('later');
    });
  });

  describe('searchMessages with scopes', () => {
    it('returns nothing for an empty scope list', async () => {
      await insert('src-a', { text: 'hello' });
      const res = await repo.searchMessages({ query: 'hello', scopes: [] });
      expect(res).toEqual({ messages: [], total: 0 });
    });

    it('returns nothing when every scope has no channels', async () => {
      await insert('src-a', { text: 'hello' });
      const res = await repo.searchMessages({ query: 'hello', scopes: [{ sourceId: 'src-a', channels: [] }] });
      expect(res.total).toBe(0);
    });

    it('scopes in SQL, so totals and pages count only readable rows', async () => {
      await insert('src-a', { text: 'hello a0', channel: 0 });
      await insert('src-a', { text: 'hello a2', channel: 2 });
      await insert('src-b', { text: 'hello b0', channel: 0 });
      const res = await repo.searchMessages({
        query: 'hello',
        scopes: [{ sourceId: 'src-a', channels: [0] }, { sourceId: 'src-b', channels: 'all' }],
      });
      expect(res.total).toBe(2);
      expect(res.messages.map((m) => m.text).sort()).toEqual(['hello a0', 'hello b0']);
    });

    it('compares dates in milliseconds (regression: the client used to send seconds)', async () => {
      await insert('src-a', { text: 'hello', timestamp: T0, rxTime: T0 });
      const inRange = await repo.searchMessages({ query: 'hello', sourceId: 'src-a', startDate: T0 - 1000, endDate: T0 + 1000 });
      expect(inRange.total).toBe(1);
      // A seconds value is ~1000x smaller, so as an end date it excludes everything.
      const seconds = await repo.searchMessages({ query: 'hello', sourceId: 'src-a', endDate: Math.floor(T0 / 1000) });
      expect(seconds.total).toBe(0);
    });
  });
});
