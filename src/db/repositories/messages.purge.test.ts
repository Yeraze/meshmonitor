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
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import * as schema from '../schema/index.js';

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
    db = new Database(':memory:');

    db.exec(`
      CREATE TABLE nodes (
        nodeNum INTEGER PRIMARY KEY,
        nodeId TEXT NOT NULL UNIQUE,
        longName TEXT,
        shortName TEXT
      )
    `);

    db.exec(`
      INSERT INTO nodes (nodeNum, nodeId) VALUES (${NODE1_NUM}, '${NODE1_ID}');
      INSERT INTO nodes (nodeNum, nodeId) VALUES (${NODE2_NUM}, '${NODE2_ID}');
      INSERT INTO nodes (nodeNum, nodeId) VALUES (${NODE3_NUM}, '${NODE3_ID}');
    `);

    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        fromNodeNum INTEGER NOT NULL REFERENCES nodes(nodeNum) ON DELETE CASCADE,
        toNodeNum INTEGER NOT NULL REFERENCES nodes(nodeNum) ON DELETE CASCADE,
        fromNodeId TEXT NOT NULL,
        toNodeId TEXT NOT NULL,
        text TEXT NOT NULL,
        channel INTEGER NOT NULL DEFAULT 0,
        portnum INTEGER,
        requestId INTEGER,
        timestamp INTEGER NOT NULL,
        rxTime INTEGER,
        hopStart INTEGER,
        hopLimit INTEGER,
        relayNode INTEGER,
        replyId INTEGER,
        emoji INTEGER,
        viaMqtt INTEGER,
        viaStoreForward INTEGER DEFAULT 0,
        rxSnr REAL,
        rxRssi REAL,
        ackFailed INTEGER,
        routingErrorReceived INTEGER,
        deliveryState TEXT,
        wantAck INTEGER,
        ackFromNode INTEGER,
        createdAt INTEGER NOT NULL,
        decrypted_by TEXT,
        sourceId TEXT
      )
    `);

    drizzleDb = drizzle(db, { schema });
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
      expect(() => repo.purgeChannelMessagesSqlite(0, 'src-a')).not.toThrow();
    });

    it('purges only messages on the given channel and source', async () => {
      await insertMsg('m1', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-a');
      await insertMsg('m2', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-b');
      await insertMsg('m3', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 1, 'src-a');

      const deleted = repo.purgeChannelMessagesSqlite(0, 'src-a');
      expect(deleted).toBe(1);

      const remaining = db.prepare('SELECT id FROM messages ORDER BY id').all() as { id: string }[];
      expect(remaining.map(r => r.id)).toEqual(['m2', 'm3']);
    });

    it('purges all sources for the channel when sourceId is undefined', async () => {
      await insertMsg('m1', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-a');
      await insertMsg('m2', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-b');
      await insertMsg('m3', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 1, 'src-a');

      const deleted = repo.purgeChannelMessagesSqlite(0);
      expect(deleted).toBe(2);

      const remaining = db.prepare('SELECT id FROM messages').all() as { id: string }[];
      expect(remaining.map(r => r.id)).toEqual(['m3']);
    });
  });

  describe('purgeDirectMessagesSqlite', () => {
    it('does not throw when called with a sourceId (issue #2631 regression)', async () => {
      await insertMsg('m1', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-a');
      expect(() => repo.purgeDirectMessagesSqlite(NODE1_NUM, 'src-a')).not.toThrow();
    });

    it('purges only DMs involving the node on the given source', async () => {
      // DM src-a: m1
      await insertMsg('m1', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-a');
      // DM src-b: m2
      await insertMsg('m2', NODE2_NUM, NODE2_ID, NODE1_NUM, NODE1_ID, 0, 'src-b');
      // Unrelated DM on src-a between NODE3 ↔ NODE2: m3
      await insertMsg('m3', NODE3_NUM, NODE3_ID, NODE2_NUM, NODE2_ID, 0, 'src-a');

      const deleted = repo.purgeDirectMessagesSqlite(NODE1_NUM, 'src-a');
      expect(deleted).toBe(1);

      const remaining = db.prepare('SELECT id FROM messages ORDER BY id').all() as { id: string }[];
      expect(remaining.map(r => r.id)).toEqual(['m2', 'm3']);
    });

    it('excludes broadcast messages (!ffffffff)', async () => {
      // Add the broadcast target node so the foreign key holds
      db.exec(`INSERT OR IGNORE INTO nodes (nodeNum, nodeId) VALUES (${0xffffffff}, '!ffffffff')`);

      // Broadcast looks like a DM by fromNode, but toNodeId is !ffffffff
      await insertMsg('bcast', NODE1_NUM, NODE1_ID, 0xffffffff, '!ffffffff', 0, 'src-a');
      await insertMsg('dm', NODE1_NUM, NODE1_ID, NODE2_NUM, NODE2_ID, 0, 'src-a');

      const deleted = repo.purgeDirectMessagesSqlite(NODE1_NUM, 'src-a');
      expect(deleted).toBe(1); // only the DM

      const remaining = db.prepare('SELECT id FROM messages ORDER BY id').all() as { id: string }[];
      expect(remaining.map(r => r.id)).toEqual(['bcast']);
    });
  });
});
