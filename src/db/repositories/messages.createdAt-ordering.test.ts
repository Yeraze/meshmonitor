/**
 * MessagesRepository — server-side createdAt ordering (#3122).
 *
 * Regression for the channel-chat ordering bug where a node with a future-skewed
 * device clock could pin its message at the "newest" slot of the visible feed,
 * hiding subsequent real traffic until the user scrolled. The repository now
 * orders by server DB arrival time (createdAt) instead of device rxTime.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import * as schema from '../schema/index.js';

describe('MessagesRepository — createdAt ordering (#3122)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MessagesRepository;

  const LOCAL = 0x12345678;
  const PEER = 0x87654321;
  const LOCAL_ID = '!12345678';
  const PEER_ID = '!87654321';

  // Far-future device timestamp — would dominate an rxTime sort but should
  // lose a createdAt sort because the row arrived in MeshMonitor first.
  const FAR_FUTURE = 4_000_000_000_000; // ~2096

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
      INSERT INTO nodes (nodeNum, nodeId) VALUES (${LOCAL}, '${LOCAL_ID}');
      INSERT INTO nodes (nodeNum, nodeId) VALUES (${PEER}, '${PEER_ID}');
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
        sourceId TEXT,
        source_ip TEXT,
        source_path TEXT
      )
    `);
    drizzleDb = drizzle(db, { schema });
    repo = new MessagesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  const insert = (
    id: string,
    opts: { channel?: number; rxTime: number; createdAt: number; portnum?: number },
  ) => {
    db.prepare(
      `INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, channel, portnum, timestamp, rxTime, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      PEER,
      LOCAL,
      PEER_ID,
      LOCAL_ID,
      `msg-${id}`,
      opts.channel ?? 0,
      opts.portnum ?? 1,
      opts.rxTime,
      opts.rxTime,
      opts.createdAt,
    );
  };

  it('getMessages orders newest-first by createdAt, not rxTime', async () => {
    insert('future-but-old', { rxTime: FAR_FUTURE, createdAt: 1000 });
    insert('real-newer-1', { rxTime: 2000, createdAt: 2000 });
    insert('real-newer-2', { rxTime: 3000, createdAt: 3000 });

    const rows = await repo.getMessages(10);
    expect(rows.map((r: any) => r.id)).toEqual(['real-newer-2', 'real-newer-1', 'future-but-old']);
  });

  it('getMessagesByChannel orders newest-first by createdAt and filters channel', async () => {
    insert('skewed', { channel: 0, rxTime: FAR_FUTURE, createdAt: 100 });
    insert('actual-new', { channel: 0, rxTime: 500, createdAt: 200 });
    insert('other-channel', { channel: 5, rxTime: 999, createdAt: 999 });

    const rows = await repo.getMessagesByChannel(0, 10);
    expect(rows.map((r: any) => r.id)).toEqual(['actual-new', 'skewed']);
  });

  it('getMessagesBeforeInChannel cursor compares createdAt, not rxTime', async () => {
    insert('a', { channel: 0, rxTime: 100, createdAt: 100 });
    insert('b', { channel: 0, rxTime: 200, createdAt: 200 });
    // Future-skewed device clock but actually arrived between a and b.
    insert('skewed', { channel: 0, rxTime: FAR_FUTURE, createdAt: 150 });
    insert('c', { channel: 0, rxTime: 300, createdAt: 300 });

    // Cursor "before" = 250 should pull rows whose createdAt < 250.
    // Under the old rxTime cursor 'skewed' would be excluded (rxTime > 250).
    // Under createdAt 'skewed' is included.
    const rows = await repo.getMessagesBeforeInChannel(0, 250, 10);
    expect(rows.map((r: any) => r.id)).toEqual(['b', 'skewed', 'a']);
  });

  it('getMessagesSqlite (sync variant) orders by createdAt', () => {
    insert('skewed', { rxTime: FAR_FUTURE, createdAt: 100 });
    insert('newer', { rxTime: 50, createdAt: 200 });

    const rows = repo.getMessagesSqlite(10);
    expect(rows.map((r: any) => r.id)).toEqual(['newer', 'skewed']);
  });

  it('getMessagesByChannelSqlite (sync variant) orders by createdAt', () => {
    insert('skewed', { channel: 2, rxTime: FAR_FUTURE, createdAt: 100 });
    insert('newer', { channel: 2, rxTime: 50, createdAt: 200 });

    const rows = repo.getMessagesByChannelSqlite(2, 10);
    expect(rows.map((r: any) => r.id)).toEqual(['newer', 'skewed']);
  });
});
