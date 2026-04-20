/**
 * MessagesRepository.getMessages — excludePortnums filter.
 *
 * Regression coverage for issue #2741: traceroute responses (portnum 70) were
 * stored in the `messages` table alongside text DMs and consumed slots in the
 * capped fetch window, so a successful traceroute would evict a real DM from
 * the 100-row window the UI pulls from. The fix adds an `excludePortnums`
 * argument; UI-facing callers pass `[70]` so traceroutes do not displace DMs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import * as schema from '../schema/index.js';

describe('MessagesRepository.getMessages excludePortnums', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MessagesRepository;

  const LOCAL_NUM = 0x12345678;
  const LOCAL_ID = '!12345678';
  const PEER_NUM = 0x87654321;
  const PEER_ID = '!87654321';

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
      INSERT INTO nodes (nodeNum, nodeId) VALUES (${LOCAL_NUM}, '${LOCAL_ID}');
      INSERT INTO nodes (nodeNum, nodeId) VALUES (${PEER_NUM}, '${PEER_ID}');
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

  const insert = (id: string, portnum: number | null, rxTime: number, text = 'x') => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, channel, portnum, timestamp, rxTime, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, -1, ?, ?, ?, ?)`
    ).run(id, LOCAL_NUM, PEER_NUM, LOCAL_ID, PEER_ID, text, portnum, rxTime, rxTime, now);
  };

  it('drops traceroute rows (portnum 70) when excluded', async () => {
    insert('text-1', 1, 1000);
    insert('trace-1', 70, 2000);
    insert('text-2', 1, 3000);

    const all = await repo.getMessages(100);
    expect(all).toHaveLength(3);

    const filtered = await repo.getMessages(100, 0, undefined, [70]);
    expect(filtered.map(m => m.id).sort()).toEqual(['text-1', 'text-2']);
  });

  it('keeps rows whose portnum is NULL (legacy data predates the column)', async () => {
    insert('legacy', null, 1000);
    insert('trace', 70, 2000);

    const filtered = await repo.getMessages(100, 0, undefined, [70]);
    expect(filtered.map(m => m.id)).toEqual(['legacy']);
  });

  it('does not evict real DMs when a traceroute is inserted (issue #2741)', async () => {
    // Simulate a tight cap: 3 DMs in the table, then a traceroute arrives.
    insert('dm-old', 1, 1000);
    insert('dm-mid', 1, 2000);
    insert('dm-recent', 1, 3000);
    insert('trace', 70, 4000);

    // Without the filter, limit=3 returns the 3 newest — which now includes
    // the traceroute and drops dm-old. This is the bug.
    const unfiltered = await repo.getMessages(3);
    expect(unfiltered.map(m => m.id)).toContain('trace');
    expect(unfiltered.map(m => m.id)).not.toContain('dm-old');

    // With the filter, all 3 DMs survive the same capped window.
    const filtered = await repo.getMessages(3, 0, undefined, [70]);
    expect(filtered.map(m => m.id).sort()).toEqual(['dm-mid', 'dm-old', 'dm-recent']);
  });

  it('is a no-op when excludePortnums is empty or omitted', async () => {
    insert('a', 1, 1000);
    insert('b', 70, 2000);

    const omitted = await repo.getMessages(100);
    const empty = await repo.getMessages(100, 0, undefined, []);

    expect(omitted.map(m => m.id).sort()).toEqual(['a', 'b']);
    expect(empty.map(m => m.id).sort()).toEqual(['a', 'b']);
  });
});
