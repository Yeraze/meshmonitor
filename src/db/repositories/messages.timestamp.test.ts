/**
 * Messages Repository - updateMessageTimestamps Tests
 *
 * Tests for updating message rxTime and timestamp on ACK receipt.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('MessagesRepository.updateMessageTimestamps', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MessagesRepository;

  const NODE1_NUM = 0xaabbccdd;
  const NODE1_ID = '!aabbccdd';
  const NODE2_NUM = 0x11223344;
  const NODE2_ID = '!11223344';

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

    repo = new MessagesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  const insertMessage = (id: string, requestId: number, timestamp: number, rxTime: number | null = null) => {
    db.prepare(`
      INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, channel, requestId, timestamp, rxTime, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, NODE1_NUM, NODE2_NUM, NODE1_ID, NODE2_ID, 'test message', 0, requestId, timestamp, rxTime, Date.now());
  };

  const getMessage = (id: string) => {
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
  };

  it('should update both rxTime and timestamp for existing message', async () => {
    const serverTime = Date.now();
    const nodeTime = serverTime - 5000; // Node clock is 5s behind

    insertMessage('msg-1', 12345, serverTime, serverTime);

    const result = await repo.updateMessageTimestamps(12345, nodeTime);

    expect(result).toBe(true);
    const msg = getMessage('msg-1');
    expect(msg.rxTime).toBe(nodeTime);
    expect(msg.timestamp).toBe(nodeTime);
  });

  it('should return false for non-existent requestId', async () => {
    insertMessage('msg-1', 12345, Date.now());

    const result = await repo.updateMessageTimestamps(99999, Date.now());

    expect(result).toBe(false);
  });

  it('should update message with null rxTime', async () => {
    const serverTime = Date.now();
    const nodeTime = serverTime - 3000;

    insertMessage('msg-1', 12345, serverTime, null);

    const result = await repo.updateMessageTimestamps(12345, nodeTime);

    expect(result).toBe(true);
    const msg = getMessage('msg-1');
    expect(msg.rxTime).toBe(nodeTime);
    expect(msg.timestamp).toBe(nodeTime);
  });

  it('should only update the message matching the requestId', async () => {
    const serverTime = Date.now();
    const nodeTime = serverTime - 5000;

    insertMessage('msg-1', 11111, serverTime, serverTime);
    insertMessage('msg-2', 22222, serverTime, serverTime);

    await repo.updateMessageTimestamps(11111, nodeTime);

    const msg1 = getMessage('msg-1');
    const msg2 = getMessage('msg-2');
    expect(msg1.rxTime).toBe(nodeTime);
    expect(msg1.timestamp).toBe(nodeTime);
    expect(msg2.rxTime).toBe(serverTime);
    expect(msg2.timestamp).toBe(serverTime);
  });
});
