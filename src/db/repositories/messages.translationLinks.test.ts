/**
 * Every MessagesRepository delete path drops the deleted messages'
 * `message_translations` links and recounts `messageRefCount` (#5520).
 * Runs on the full production SQLite schema (`createTestDb`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { MessagesRepository } from './messages.js';
import { TranslationsRepository } from './translations.js';
import { ALL_SOURCES } from './base.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const N1 = 0xaabbccdd;
const N2 = 0x11223344;
const DAY = 24 * 60 * 60 * 1000;

describe('MessagesRepository — translation link cleanup on delete', () => {
  let db: Database.Database;
  let messages: MessagesRepository;
  let translations: TranslationsRepository;

  beforeEach(async () => {
    const t = createTestDb();
    db = t.sqlite;
    const now = Date.now();
    const insertNode = db.prepare(
      'INSERT OR IGNORE INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
    );
    for (const src of ['src-a', 'src-b']) {
      insertNode.run(N1, '!aabbccdd', src, now, now);
      insertNode.run(N2, '!11223344', src, now, now);
    }
    messages = new MessagesRepository(t.db, 'sqlite');
    translations = new TranslationsRepository(t.db, 'sqlite');
    await translations.insertCacheEntry({ cacheKey: 'hi', targetLang: 'en', translatedText: 'Hi', provider: 'deepl' });
  });

  afterEach(() => db.close());

  async function addTranslatedMessage(
    id: string,
    sourceId: string,
    opts: { channel?: number; from?: number; to?: number; ageDays?: number } = {},
  ) {
    const ts = Date.now() - (opts.ageDays ?? 0) * DAY;
    const to = opts.to ?? 0xffffffff;
    await messages.insertMessage({
      id,
      fromNodeNum: opts.from ?? N1,
      toNodeNum: to,
      fromNodeId: '!aabbccdd',
      toNodeId: to === 0xffffffff ? '!ffffffff' : '!11223344',
      text: 'こんにちは',
      channel: opts.channel ?? 0,
      portnum: 1,
      timestamp: ts,
      rxTime: ts,
      createdAt: ts,
    } as any, sourceId);
    await translations.linkMessage(sourceId, id, 'en', 'hi');
  }

  const refCount = async () => (await translations.getCacheEntry('hi'))?.messageRefCount;
  const linkCount = () => (db.prepare('SELECT COUNT(*) AS c FROM message_translations').get() as { c: number }).c;

  it('deleteMessage', async () => {
    await addTranslatedMessage('m1', 'src-a');
    await addTranslatedMessage('m2', 'src-a');
    expect(await refCount()).toBe(2);
    await messages.deleteMessage('m1');
    expect(linkCount()).toBe(1);
    expect(await refCount()).toBe(1);
  });

  it('purgeChannelMessages is source-scoped', async () => {
    await addTranslatedMessage('a1', 'src-a', { channel: 0 });
    await addTranslatedMessage('b1', 'src-b', { channel: 0 });
    await messages.purgeChannelMessages(0, 'src-a');
    expect(await translations.getLinksForMessage('src-a', 'a1')).toEqual([]);
    expect(await translations.getLinksForMessage('src-b', 'b1')).toHaveLength(1);
    expect(await refCount()).toBe(1);
  });

  it('purgeDirectMessages and purgeMessagesFromNode', async () => {
    db.prepare("INSERT OR IGNORE INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, '!ffffffff', 'src-a', 1, 1)").run(0xffffffff);
    await addTranslatedMessage('dm', 'src-a', { channel: -1, to: N2 });
    await addTranslatedMessage('bc', 'src-a', { channel: 0 });
    await messages.purgeDirectMessages(N1, 'src-a');
    expect(linkCount()).toBe(1);
    await messages.purgeMessagesFromNode(N1, 'src-a');
    expect(linkCount()).toBe(0);
    expect(await refCount()).toBe(0);
  });

  it('retention: cleanupOldMessagesForSource, cleanupOldMessages and the sync SQLite path', async () => {
    await addTranslatedMessage('old-a', 'src-a', { ageDays: 40 });
    await addTranslatedMessage('old-b', 'src-b', { ageDays: 40 });
    await addTranslatedMessage('old-c', 'src-b', { ageDays: 40 });
    await addTranslatedMessage('new', 'src-a');
    await messages.cleanupOldMessagesForSource(30, 'src-a');
    expect(await translations.getLinksForMessage('src-a', 'old-a')).toEqual([]);
    expect(linkCount()).toBe(3);

    messages.cleanupOldMessagesSqlite(35, 'src-b');
    expect(linkCount()).toBe(1);
    expect(await refCount()).toBe(1);

    await addTranslatedMessage('old-d', 'src-b', { ageDays: 40 });
    await messages.cleanupOldMessages(30);
    expect(linkCount()).toBe(1);
  });

  it('deleteAllMessages (source delete / purge) and deleteAllMessagesSqlite', async () => {
    await addTranslatedMessage('a1', 'src-a');
    await addTranslatedMessage('b1', 'src-b');
    await messages.deleteAllMessages('src-a');
    expect(await translations.getLinksForMessage('src-a', 'a1')).toEqual([]);
    expect(await refCount()).toBe(1);

    messages.deleteAllMessagesSqlite(ALL_SOURCES);
    expect(linkCount()).toBe(0);
    expect(await refCount()).toBe(0);
  });

  it('a delete that bypasses the repository (FK cascade from a node delete) is caught by the prune', async () => {
    await addTranslatedMessage('m1', 'src-a');
    db.prepare("DELETE FROM nodes WHERE nodeNum = ? AND sourceId = 'src-a'").run(N1);
    const remaining = (db.prepare("SELECT COUNT(*) AS c FROM messages WHERE id = 'm1'").get() as { c: number }).c;
    if (remaining === 0) {
      // Cascade fired; the link is orphaned until the sweep.
      const result = await translations.pruneCache({ now: Date.now(), ttlMs: 30 * DAY, maxUnpinned: 10_000 });
      expect(result.orphanedLinksRemoved).toBe(1);
      expect(await refCount()).toBe(0);
    } else {
      // Composite-key schema without a cascade: nothing to sweep.
      expect(linkCount()).toBe(1);
    }
  });
});
