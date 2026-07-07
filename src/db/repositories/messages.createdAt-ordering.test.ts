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
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import { ALL_SOURCES } from './base.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

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
    // Full production schema from the migration registry — see testDb.ts.
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;

    // Seed referenced nodes (full schema NOT NULL/PK columns: sourceId, timestamps).
    const now = Date.now();
    const insertNode = db.prepare(
      "INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, 'default', ?, ?)",
    );
    insertNode.run(LOCAL, LOCAL_ID, now, now);
    insertNode.run(PEER, PEER_ID, now, now);

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

    const rows = await repo.getMessages(10, 0, ALL_SOURCES);
    expect(rows.map((r: any) => r.id)).toEqual(['real-newer-2', 'real-newer-1', 'future-but-old']);
  });

  it('getMessagesByChannel orders newest-first by createdAt and filters channel', async () => {
    insert('skewed', { channel: 0, rxTime: FAR_FUTURE, createdAt: 100 });
    insert('actual-new', { channel: 0, rxTime: 500, createdAt: 200 });
    insert('other-channel', { channel: 5, rxTime: 999, createdAt: 999 });

    const rows = await repo.getMessagesByChannel(0, 10, 0, ALL_SOURCES);
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
    const rows = await repo.getMessagesBeforeInChannel(0, 250, 10, ALL_SOURCES);
    expect(rows.map((r: any) => r.id)).toEqual(['b', 'skewed', 'a']);
  });

  it('getMessagesSqlite (sync variant) orders by createdAt', () => {
    insert('skewed', { rxTime: FAR_FUTURE, createdAt: 100 });
    insert('newer', { rxTime: 50, createdAt: 200 });

    const rows = repo.getMessagesSqlite(10, 0, ALL_SOURCES);
    expect(rows.map((r: any) => r.id)).toEqual(['newer', 'skewed']);
  });

  it('getMessagesByChannelSqlite (sync variant) orders by createdAt', () => {
    insert('skewed', { channel: 2, rxTime: FAR_FUTURE, createdAt: 100 });
    insert('newer', { channel: 2, rxTime: 50, createdAt: 200 });

    const rows = repo.getMessagesByChannelSqlite(2, 10, 0, ALL_SOURCES);
    expect(rows.map((r: any) => r.id)).toEqual(['newer', 'skewed']);
  });
});
