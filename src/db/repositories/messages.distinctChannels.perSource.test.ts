/**
 * MessagesRepository.getDistinctChannelsForSource — verifies the Channels-tab
 * helper enumerates distinct message channels per source (with counts and the
 * latest timestamp), source-scoped, ordered most-active first.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('MessagesRepository.getDistinctChannelsForSource', () => {
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
    for (const src of ['mqtt-1', 'mqtt-2']) {
      db.prepare(
        'INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
      ).run(NODE_NUM, NODE_ID, src, now, now);
    }
    repo = new MessagesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => db.close());

  const insert = async (id: string, channel: number, sourceId: string, timestamp: number) =>
    repo.insertMessage(
      {
        id,
        fromNodeNum: NODE_NUM,
        toNodeNum: NODE_NUM,
        fromNodeId: NODE_ID,
        toNodeId: NODE_ID,
        text: 'hi',
        channel,
        portnum: 1,
        timestamp,
        rxTime: timestamp,
        createdAt: timestamp,
      } as any,
      sourceId,
    );

  it('returns distinct channels with counts and last timestamp, ordered most-active first', async () => {
    // mqtt-1: channel 101 x3 (latest ts 300), channel 102 x1.
    await insert('a', 101, 'mqtt-1', 100);
    await insert('b', 101, 'mqtt-1', 300);
    await insert('c', 101, 'mqtt-1', 200);
    await insert('d', 102, 'mqtt-1', 150);

    const rows = await repo.getDistinctChannelsForSource('mqtt-1');
    expect(rows).toEqual([
      { channel: 101, messageCount: 3, lastTimestamp: 300 },
      { channel: 102, messageCount: 1, lastTimestamp: 150 },
    ]);
  });

  it('is source-scoped — does not leak channels from other sources', async () => {
    await insert('a', 101, 'mqtt-1', 100);
    await insert('b', 200, 'mqtt-2', 100);

    const rows1 = await repo.getDistinctChannelsForSource('mqtt-1');
    expect(rows1.map((r) => r.channel)).toEqual([101]);

    const rows2 = await repo.getDistinctChannelsForSource('mqtt-2');
    expect(rows2.map((r) => r.channel)).toEqual([200]);
  });

  it('returns [] for a source with no messages', async () => {
    const rows = await repo.getDistinctChannelsForSource('mqtt-1');
    expect(rows).toEqual([]);
  });
});
