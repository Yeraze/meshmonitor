/**
 * MessagesRepository.getMessageCountsByChannelAndTransport — per-source
 * isolation (#5101 WP4). Two sources with mirrored channel/transport data
 * must never leak into each other's counts, and the bare `withSourceScope`
 * guard (empty-string sourceId) must still throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import { PortNum } from '../../server/constants/meshtastic.js';

describe('MessagesRepository.getMessageCountsByChannelAndTransport — per-source isolation', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MessagesRepository;

  const NODE_NUM = 0xaabbccdd;
  const NODE_ID = '!aabbccdd';

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    const now = Date.now();
    for (const src of ['src-a', 'src-b']) {
      db.prepare(
        'INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
      ).run(NODE_NUM, NODE_ID, src, now, now);
    }
    repo = new MessagesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => db.close());

  const insert = async (
    id: string,
    sourceId: string,
    overrides: Partial<Record<string, unknown>> = {},
  ) =>
    repo.insertMessage(
      {
        id,
        fromNodeNum: NODE_NUM,
        toNodeNum: NODE_NUM,
        fromNodeId: NODE_ID,
        toNodeId: NODE_ID,
        text: 'hi',
        channel: 0,
        portnum: PortNum.TEXT_MESSAGE_APP,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ...overrides,
      } as any,
      sourceId,
    );

  it('does not leak sourceA counts into sourceB and vice versa', async () => {
    // Mirrored data: same channels, different transport mix per source.
    await insert('a1', 'src-a', { channel: 0, viaMqtt: false });
    await insert('a2', 'src-a', { channel: 0, viaMqtt: false });
    await insert('a3', 'src-a', { channel: 0, viaMqtt: true });

    await insert('b1', 'src-b', { channel: 0, viaMqtt: true });
    await insert('b2', 'src-b', { channel: 0, viaMqtt: true });

    const rowsA = await repo.getMessageCountsByChannelAndTransport('src-a');
    const totalA = rowsA.reduce((s, r) => s + r.count, 0);
    const rfA = rowsA.filter((r) => r.transportClass === 'rf').reduce((s, r) => s + r.count, 0);
    const mqttA = rowsA.filter((r) => r.transportClass === 'mqtt').reduce((s, r) => s + r.count, 0);
    expect(totalA).toBe(3);
    expect(rfA).toBe(2);
    expect(mqttA).toBe(1);

    const rowsB = await repo.getMessageCountsByChannelAndTransport('src-b');
    const totalB = rowsB.reduce((s, r) => s + r.count, 0);
    expect(totalB).toBe(2);
    expect(rowsB.every((r) => r.transportClass === 'mqtt')).toBe(true);
  });

  it('returns [] for a source with no messages, even when another source has data', async () => {
    await insert('a1', 'src-a', { channel: 0 });

    const rows = await repo.getMessageCountsByChannelAndTransport('src-b');
    expect(rows).toEqual([]);
  });

  it('throws when sourceId is an empty string (withSourceScope guard)', async () => {
    await expect(repo.getMessageCountsByChannelAndTransport('')).rejects.toThrow(
      /sourceId is required/,
    );
  });
});
