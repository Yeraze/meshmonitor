/**
 * Messages Repository - insertMessage duplicate detection tests
 *
 * Verifies that insertMessage returns true on actual insert, false on duplicate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('MessagesRepository.insertMessage duplicate detection', () => {
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

    // Seed referenced nodes (messages enrich with node data). Include the
    // full schema's NOT NULL columns.
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
