/**
 * MessagesRepository.getChannelTextSince (#6566): one channel's text since a
 * time, per source, oldest first, newest kept at the limit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MessagesRepository } from './messages.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('MessagesRepository.getChannelTextSince', () => {
  let db: Database.Database;
  let repo: MessagesRepository;
  const NODE_NUM = 0xaabbccdd;
  const NODE_ID = '!aabbccdd';

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    const now = Date.now();
    for (const src of ['a', 'b']) {
      db.prepare('INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
        .run(NODE_NUM, NODE_ID, src, now, now);
    }
    repo = new MessagesRepository(t.db, 'sqlite');
  });
  afterEach(() => db.close());

  const insert = (id: string, sourceId: string, createdAt: number, extra: Record<string, unknown> = {}) =>
    repo.insertMessage({
      id, fromNodeNum: NODE_NUM, toNodeNum: 0xffffffff, fromNodeId: NODE_ID, toNodeId: '!ffffffff',
      text: id, channel: 0, portnum: 1, timestamp: createdAt, rxTime: createdAt, createdAt, ...extra,
    } as any, sourceId);

  it('returns this source and channel only, at or after the cutoff, oldest first', async () => {
    await insert('old', 'a', 100);
    await insert('m1', 'a', 200);
    await insert('m2', 'a', 300);
    await insert('other-source', 'b', 250);
    await insert('other-channel', 'a', 260, { channel: 1 });
    await insert('tapback', 'a', 270, { emoji: 1 });
    await insert('telemetry', 'a', 280, { portnum: 67 });
    const rows = await repo.getChannelTextSince('a', 0, 200, 100);
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2']);
  });

  it('keeps the newest rows at the limit', async () => {
    await insert('m1', 'a', 100);
    await insert('m2', 'a', 200);
    await insert('m3', 'a', 300);
    const rows = await repo.getChannelTextSince('a', 0, 0, 2);
    expect(rows.map((r) => r.id)).toEqual(['m2', 'm3']);
  });
});
