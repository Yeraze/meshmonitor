/**
 * MeshCoreRepository.getMessagesForExport + searchMessages (#5517).
 *
 * MeshCore channel identity rides on synthesised `channel-N` keys (and, for
 * legacy channel 0, a null recipient); DMs are everything else. Both queries
 * must stay inside their source and treat an empty scope as zero rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MeshCoreRepository, type DbMeshCoreMessage } from './meshcore.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const T0 = 1_760_000_000_000;
const ME = 'aa'.repeat(32);
const PEER = 'bb'.repeat(32);

describe('MeshCoreRepository — export + search per source (#5517)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MeshCoreRepository;
  let seq = 0;

  const insert = async (sourceId: string, overrides: Partial<DbMeshCoreMessage> = {}) => {
    seq++;
    const msg: DbMeshCoreMessage = {
      id: `mc-${seq}`,
      fromPublicKey: 'channel-0',
      fromName: 'Alice',
      toPublicKey: null,
      text: `message ${seq}`,
      timestamp: T0 + seq * 1000,
      messageType: 'text',
      sourceId,
      createdAt: T0 + seq * 1000,
      ...overrides,
    };
    await repo.insertMessage(msg, sourceId);
  };

  beforeEach(() => {
    seq = 0;
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MeshCoreRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => db.close());

  describe('getMessagesForExport', () => {
    it('requires a sourceId', async () => {
      await expect(repo.getMessagesForExport({ sourceId: '', channels: 'all', includeDms: true })).rejects.toThrow(/sourceId/);
    });

    it('never returns another source’s rows', async () => {
      await insert('src-a', { text: 'alpha' });
      await insert('src-b', { text: 'bravo' });
      const rows = await repo.getMessagesForExport({ sourceId: 'src-a', channels: 'all', includeDms: true });
      expect(rows.map((r) => r.text)).toEqual(['alpha']);
    });

    it('returns nothing for no channels and no DMs', async () => {
      await insert('src-a');
      expect(await repo.getMessagesForExport({ sourceId: 'src-a', channels: [], includeDms: false })).toEqual([]);
    });

    it('splits channel traffic (incl. legacy channel 0) from DMs', async () => {
      await insert('src-a', { text: 'rx ch0', fromPublicKey: 'channel-0' });
      await insert('src-a', { text: 'tx ch1', fromPublicKey: ME, fromName: null, toPublicKey: 'channel-1' });
      await insert('src-a', { text: 'legacy ch0', fromPublicKey: ME, fromName: null, toPublicKey: null });
      await insert('src-a', { text: 'dm in', fromPublicKey: PEER, fromName: null, toPublicKey: ME });

      const ch0 = await repo.getMessagesForExport({ sourceId: 'src-a', channels: [0], includeDms: false });
      expect(ch0.map((r) => r.text)).toEqual(['rx ch0', 'legacy ch0']);
      const ch1 = await repo.getMessagesForExport({ sourceId: 'src-a', channels: [1], includeDms: false });
      expect(ch1.map((r) => r.text)).toEqual(['tx ch1']);
      const dms = await repo.getMessagesForExport({ sourceId: 'src-a', channels: [], includeDms: true });
      expect(dms.map((r) => r.text)).toEqual(['dm in']);
      const allChannels = await repo.getMessagesForExport({ sourceId: 'src-a', channels: 'all', includeDms: false });
      expect(allChannels.map((r) => r.text)).toEqual(['rx ch0', 'tx ch1', 'legacy ch0']);
    });

    it('applies include (any), exclude, sender and date filters', async () => {
      await insert('src-a', { text: 'NET roll call', fromName: 'Alice' });
      await insert('src-a', { text: 'net traffic, ignore', fromName: 'Alice' });
      await insert('src-a', { text: 'shelter status 100%', fromName: 'Bob' });
      await insert('src-a', { text: 'shelter status 100 percent', fromName: 'Bob' });
      await insert('src-a', { text: 'dm net', fromPublicKey: PEER, fromName: null, toPublicKey: ME });

      const rows = await repo.getMessagesForExport({
        sourceId: 'src-a', channels: 'all', includeDms: true,
        includeTerms: ['net', '100%'], excludeTerms: ['IGNORE'],
      });
      expect(rows.map((r) => r.text)).toEqual(['NET roll call', 'shelter status 100%', 'dm net']);

      const byName = await repo.getMessagesForExport({ sourceId: 'src-a', channels: 'all', includeDms: true, sender: 'bob' });
      expect(byName).toHaveLength(2);
      const byKey = await repo.getMessagesForExport({ sourceId: 'src-a', channels: 'all', includeDms: true, sender: PEER.slice(0, 6).toUpperCase() });
      expect(byKey.map((r) => r.text)).toEqual(['dm net']);

      const ranged = await repo.getMessagesForExport({
        sourceId: 'src-a', channels: 'all', includeDms: true, startMs: T0 + 2000, endMs: T0 + 3000,
      });
      expect(ranged.map((r) => r.text)).toEqual(['net traffic, ignore', 'shelter status 100%']);
    });

    it('pages by keyset across equal timestamps', async () => {
      for (let i = 0; i < 5; i++) await insert('src-a', { text: `same ${i}`, timestamp: T0 });
      const seen: string[] = [];
      let after: { time: number; id: string } | undefined;
      for (;;) {
        const page = await repo.getMessagesForExport({ sourceId: 'src-a', channels: 'all', includeDms: true, after, limit: 2 });
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.text));
        const last = page[page.length - 1];
        after = { time: Number(last.timestamp), id: last.id };
      }
      expect(new Set(seen).size).toBe(5);
    });
  });

  describe('searchMessages', () => {
    it('searches stored rows, scoped per source and channel', async () => {
      await insert('src-a', { text: 'hello ch0', fromPublicKey: 'channel-0' });
      await insert('src-a', { text: 'hello ch3', fromPublicKey: 'channel-3' });
      await insert('src-a', { text: 'hello dm', fromPublicKey: PEER, fromName: null, toPublicKey: ME });
      await insert('src-b', { text: 'hello b' });

      const res = await repo.searchMessages({
        query: 'HELLO',
        scopes: [{ sourceId: 'src-a', channels: [0], includeDms: false }],
      });
      expect(res.total).toBe(1);
      expect(res.messages[0].text).toBe('hello ch0');

      const all = await repo.searchMessages({
        query: 'hello',
        scopes: [{ sourceId: 'src-a', channels: 'all', includeDms: true }],
      });
      expect(all.total).toBe(3);
    });

    it('returns nothing for an empty or unreadable scope', async () => {
      await insert('src-a', { text: 'hello' });
      expect((await repo.searchMessages({ query: 'hello', scopes: [] })).total).toBe(0);
      expect((await repo.searchMessages({
        query: 'hello', scopes: [{ sourceId: 'src-a', channels: [], includeDms: false }],
      })).total).toBe(0);
    });

    it('filters dates in ms and still reports the total when no rows are wanted', async () => {
      await insert('src-a', { text: 'hello', timestamp: T0 });
      const res = await repo.searchMessages({
        query: 'hello',
        scopes: [{ sourceId: 'src-a', channels: 'all', includeDms: true }],
        startDate: T0 - 1, endDate: T0 + 1, limit: 0,
      });
      expect(res).toEqual({ messages: [], total: 1 });
    });
  });
});
