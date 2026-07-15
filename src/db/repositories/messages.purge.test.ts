/**
 * Messages Repository - purge sync helpers tests (SQLite-only)
 *
 * Regression coverage for issue #2631: the facade's SQLite branch previously
 * used raw SQL with `source_id`, but the schema column is `sourceId` — any
 * call with a sourceId parameter crashed. The sync helpers added to the repo
 * use Drizzle query builders so column names come from the schema.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import { ALL_SOURCES } from './base.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('MessagesRepository sync purge helpers', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MessagesRepository;

  const NODE1_NUM = 0xaabbccdd;
  const NODE1_ID = '!aabbccdd';
  const NODE2_NUM = 0x11223344;
  const NODE2_ID = '!11223344';
  const NODE3_NUM = 0x55667788;
  const NODE3_ID = '!55667788';

  beforeEach(() => {
    // Full production schema from the migration registry — see testDb.ts.
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;

    // Seed referenced nodes (full schema NOT NULL/PK columns: sourceId, timestamps).
    const now = Date.now();
    const insertNode = db.prepare(
      "INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, 'default', ?, ?)",
    );
    insertNode.run(NODE1_NUM, NODE1_ID, now, now);
    insertNode.run(NODE2_NUM, NODE2_ID, now, now);
    insertNode.run(NODE3_NUM, NODE3_ID, now, now);
    // Broadcast target node, referenced by messages whose toNodeId is '!ffffffff'.
    db.prepare(
      "INSERT OR IGNORE INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, 'default', ?, ?)",
    ).run(0xffffffff, '!ffffffff', now, now);

    repo = new MessagesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  const insertMsg = async (
    id: string,
    fromNum: number,
    fromId: string,
    toNum: number,
    toId: string,
    channel: number,
    sourceId?: string
  ) => {
    await repo.insertMessage(
      {
        id,
        fromNodeNum: fromNum,
        toNodeNum: toNum,
        fromNodeId: fromId,
        toNodeId: toId,
        text: 'msg',
        channel,
        portnum: 1,
        timestamp: Date.now(),
        rxTime: Date.now(),
        createdAt: Date.now(),
      } as any,
      sourceId
    );
  };

  describe('purgeChannelMessagesSqlite', () => {
    it('does not throw when called with a sourceId (issue #2631 regression)', async () => {
      await insertMsg('m1', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-a');
      await expect(repo.purgeChannelMessages(0, 'src-a')).resolves.not.toThrow();
    });

    it('purges only messages on the given channel and source', async () => {
      await insertMsg('m1', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-a');
      await insertMsg('m2', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-b');
      await insertMsg('m3', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 1, 'src-a');

      const deleted = await repo.purgeChannelMessages(0, 'src-a');
      expect(deleted).toBe(1);

      const remaining = db.prepare('SELECT id FROM messages ORDER BY id').all() as { id: string }[];
      expect(remaining.map(r => r.id)).toEqual(['m2', 'm3']);
    });

    it('purges all sources for the channel when sourceId is undefined', async () => {
      await insertMsg('m1', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-a');
      await insertMsg('m2', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-b');
      await insertMsg('m3', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 1, 'src-a');

      const deleted = await repo.purgeChannelMessages(0, ALL_SOURCES as unknown as string);
      expect(deleted).toBe(2);

      const remaining = db.prepare('SELECT id FROM messages').all() as { id: string }[];
      expect(remaining.map(r => r.id)).toEqual(['m3']);
    });
  });

  describe('purgeDirectMessagesSqlite', () => {
    it('does not throw when called with a sourceId (issue #2631 regression)', async () => {
      await insertMsg('m1', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-a');
      await expect(repo.purgeDirectMessages(NODE1_NUM, 'src-a')).resolves.not.toThrow();
    });

    it('purges only DMs involving the node on the given source', async () => {
      // DM src-a: m1
      await insertMsg('m1', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-a');
      // DM src-b: m2
      await insertMsg('m2', NODE2_NUM, NODE2_ID, NODE1_NUM, NODE1_ID, 0, 'src-b');
      // Unrelated DM on src-a between NODE3 ↔ NODE2: m3
      await insertMsg('m3', NODE3_NUM, NODE3_ID, NODE2_NUM, NODE2_ID, 0, 'src-a');

      const deleted = await repo.purgeDirectMessages(NODE1_NUM, 'src-a');
      expect(deleted).toBe(1);

      const remaining = db.prepare('SELECT id FROM messages ORDER BY id').all() as { id: string }[];
      expect(remaining.map(r => r.id)).toEqual(['m2', 'm3']);
    });

    it('excludes broadcast messages (!ffffffff)', async () => {
      // Add the broadcast target node so the foreign key holds. Must supply the
      // full schema's NOT NULL/PK columns — OR IGNORE would otherwise silently
      // swallow the constraint violation and never insert the row.
      const now = Date.now();
      db.prepare(
        "INSERT OR IGNORE INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, 'default', ?, ?)",
      ).run(0xffffffff, '!ffffffff', now, now);

      // Broadcast looks like a DM by fromNode, but toNodeId is !ffffffff
      await insertMsg('bcast', NODE1_NUM, NODE1_ID, 0xffffffff, '!ffffffff', 0, 'src-a');
      await insertMsg('dm', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-a');

      const deleted = await repo.purgeDirectMessages(NODE1_NUM, 'src-a');
      expect(deleted).toBe(1); // only the DM

      const remaining = db.prepare('SELECT id FROM messages ORDER BY id').all() as { id: string }[];
      expect(remaining.map(r => r.id)).toEqual(['bcast']);
    });
  });

  describe('purgeMessagesFromNode', () => {
    it('deletes broadcasts and DMs originated by the node, scoped to source', async () => {
      // NODE1's own broadcast on src-a — purgeDirectMessages excludes this
      // (toNodeId is the broadcast address), but purgeMessagesFromNode should
      // catch it because fromNodeNum matches.
      await insertMsg('bcast-n1-a', NODE1_NUM, NODE1_ID, 0xffffffff, '!ffffffff', 0, 'src-a');
      // DM originated by NODE1 on src-a
      await insertMsg('dm-n1-to-n2', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-a');
      // DM addressed TO NODE1 (not originated by it) — must survive
      await insertMsg('dm-n3-to-n1', NODE3_NUM, NODE3_ID, NODE1_NUM, NODE1_ID, 0, 'src-a');
      // Other nodes' broadcasts on src-a — must survive
      await insertMsg('bcast-n2-a', NODE2_NUM, NODE2_ID, 0xffffffff, '!ffffffff', 0, 'src-a');
      await insertMsg('bcast-n3-a', NODE3_NUM, NODE3_ID, 0xffffffff, '!ffffffff', 0, 'src-a');
      // NODE1's broadcast on a second source — must survive (source scoping)
      await insertMsg('bcast-n1-b', NODE1_NUM, NODE1_ID, 0xffffffff, '!ffffffff', 0, 'src-b');

      const deleted = await repo.purgeMessagesFromNode(NODE1_NUM, 'src-a');
      expect(deleted).toBe(2); // bcast-n1-a + dm-n1-to-n2

      const remaining = db.prepare('SELECT id FROM messages ORDER BY id').all() as { id: string }[];
      expect(remaining.map(r => r.id)).toEqual(
        ['bcast-n1-b', 'bcast-n2-a', 'bcast-n3-a', 'dm-n3-to-n1'].sort()
      );
    });

    it('does not throw when called with a sourceId (regression parity with sibling purge helpers)', async () => {
      await insertMsg('m1', NODE1_NUM, NODE1_ID, 0xffffffff, '!ffffffff', 0, 'src-a');
      await expect(repo.purgeMessagesFromNode(NODE1_NUM, 'src-a')).resolves.not.toThrow();
    });
  });
});
