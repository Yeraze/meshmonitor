/**
 * Messages Repository - insertMessage duplicate detection tests
 *
 * Verifies that insertMessage returns true on actual insert, false on duplicate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import * as schema from '../schema/index.js';

describe('MessagesRepository.insertMessage duplicate detection', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MessagesRepository;

  const NODE1_NUM = 0xaabbccdd;
  const NODE1_ID = '!aabbccdd';
  const NODE2_NUM = 0x11223344;
  const NODE2_ID = '!11223344';

  beforeEach(() => {
    db = new Database(':memory:');

    // Create nodes table (referenced by messages foreign keys)
    db.exec(`
      CREATE TABLE nodes (
        nodeNum INTEGER PRIMARY KEY,
        nodeId TEXT NOT NULL UNIQUE,
        longName TEXT,
        shortName TEXT
      )
    `);

    // Insert referenced nodes
    db.exec(`
      INSERT INTO nodes (nodeNum, nodeId) VALUES (${NODE1_NUM}, '${NODE1_ID}');
      INSERT INTO nodes (nodeNum, nodeId) VALUES (${NODE2_NUM}, '${NODE2_ID}');
    `);

    // Create messages table matching the SQLite schema
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

  const makeMessage = (id: string) => ({
    id,
    fromNodeNum: NODE1_NUM,
    toNodeNum: NODE2_NUM,
    fromNodeId: NODE1_ID,
    toNodeId: NODE2_ID,
    text: 'test message',
    channel: 0,
    portnum: 1,
    timestamp: Date.now(),
    rxTime: Date.now(),
    createdAt: Date.now(),
  });

  it('should return true when inserting a new message', async () => {
    const result = await repo.insertMessage(makeMessage('msg-1') as any);
    expect(result).toBe(true);
  });

  it('should return false when inserting a duplicate message', async () => {
    const message = makeMessage('msg-dup') as any;

    const first = await repo.insertMessage(message);
    const second = await repo.insertMessage(message);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('should only insert one row for duplicate messages', async () => {
    const message = makeMessage('msg-dup2') as any;

    await repo.insertMessage(message);
    await repo.insertMessage(message);

    const count = db.prepare('SELECT COUNT(*) as count FROM messages WHERE id = ?')
      .get('msg-dup2') as { count: number };
    expect(count.count).toBe(1);
  });

  it('should return true for different message IDs', async () => {
    const result1 = await repo.insertMessage(makeMessage('msg-a') as any);
    const result2 = await repo.insertMessage(makeMessage('msg-b') as any);

    expect(result1).toBe(true);
    expect(result2).toBe(true);
  });
});
