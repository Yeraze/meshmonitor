/**
 * Messages BIGINT Round-Trip Tests
 *
 * Regression tests for BIGINT overflow bugs (#1967, #1973).
 * Verifies that nodeNum values > 2^31 (signed 32-bit max) round-trip correctly
 * through SQLite. While SQLite natively supports 64-bit integers, these tests
 * ensure the Drizzle schema and repository code don't truncate or wrap values.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { messagesSqlite } from '../schema/messages.js';
import { nodesSqlite } from '../schema/nodes.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const HIGH_NODE_NUM = 3_000_000_000; // > 2,147,483,647 (signed 32-bit max)
const NORMAL_NODE_NUM = 100_000;
const BROADCAST_NODE_NUM = 4294967295; // 0xFFFFFFFF - max unsigned 32-bit

describe('Messages BIGINT round-trip (SQLite)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
  });

  afterEach(() => {
    db.close();
  });

  // Helper: insert a node with the given nodeNum
  const insertNode = (nodeNum: number, nodeId: string) => {
    const now = Date.now();
    drizzleDb.insert(nodesSqlite).values({
      nodeNum,
      nodeId,
      sourceId: 'default',
      createdAt: now,
      updatedAt: now,
    }).run();
  };

  // Helper: insert a message and return its id
  const insertMessage = (overrides: Partial<typeof messagesSqlite.$inferInsert> = {}) => {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    drizzleDb.insert(messagesSqlite).values({
      id,
      fromNodeNum: NORMAL_NODE_NUM,
      toNodeNum: BROADCAST_NODE_NUM,
      fromNodeId: '!aabbccdd',
      toNodeId: '!ffffffff',
      text: 'test message',
      channel: 0,
      timestamp: now,
      createdAt: now,
      ...overrides,
    }).run();
    return id;
  };

  // Setup: insert required nodes for FK constraints
  beforeEach(() => {
    insertNode(NORMAL_NODE_NUM, '!aabbccdd');
    insertNode(BROADCAST_NODE_NUM, '!ffffffff');
    insertNode(HIGH_NODE_NUM, '!b2d05e00');
  });

  it('stores and retrieves relayNode > 2^31', () => {
    const id = insertMessage({ relayNode: HIGH_NODE_NUM });

    const rows = drizzleDb
      .select()
      .from(messagesSqlite)
      .where(eq(messagesSqlite.id, id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].relayNode).toBe(HIGH_NODE_NUM);
    // Ensure no sign truncation (would be negative if treated as signed 32-bit)
    expect(rows[0].relayNode).toBeGreaterThan(2_147_483_647);
  });

  it('stores and retrieves ackFromNode > 2^31', () => {
    const id = insertMessage({ ackFromNode: HIGH_NODE_NUM });

    const rows = drizzleDb
      .select()
      .from(messagesSqlite)
      .where(eq(messagesSqlite.id, id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].ackFromNode).toBe(HIGH_NODE_NUM);
    expect(rows[0].ackFromNode).toBeGreaterThan(2_147_483_647);
  });

  it('stores and retrieves max unsigned 32-bit relayNode (0xFFFFFFFF)', () => {
    const id = insertMessage({ relayNode: BROADCAST_NODE_NUM });

    const rows = drizzleDb
      .select()
      .from(messagesSqlite)
      .where(eq(messagesSqlite.id, id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].relayNode).toBe(BROADCAST_NODE_NUM);
  });

  it('stores and retrieves max unsigned 32-bit ackFromNode (0xFFFFFFFF)', () => {
    const id = insertMessage({ ackFromNode: BROADCAST_NODE_NUM });

    const rows = drizzleDb
      .select()
      .from(messagesSqlite)
      .where(eq(messagesSqlite.id, id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].ackFromNode).toBe(BROADCAST_NODE_NUM);
  });

  it('stores null relayNode and ackFromNode correctly', () => {
    const id = insertMessage({ relayNode: null, ackFromNode: null });

    const rows = drizzleDb
      .select()
      .from(messagesSqlite)
      .where(eq(messagesSqlite.id, id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].relayNode).toBeNull();
    expect(rows[0].ackFromNode).toBeNull();
  });

  it('stores both relayNode and ackFromNode > 2^31 in same row', () => {
    const id = insertMessage({
      relayNode: HIGH_NODE_NUM,
      ackFromNode: 2_500_000_000,
    });

    const rows = drizzleDb
      .select()
      .from(messagesSqlite)
      .where(eq(messagesSqlite.id, id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].relayNode).toBe(HIGH_NODE_NUM);
    expect(rows[0].ackFromNode).toBe(2_500_000_000);
  });

  it('fromNodeNum and toNodeNum handle high node numbers', () => {
    const id = insertMessage({
      fromNodeNum: HIGH_NODE_NUM,
      fromNodeId: '!b2d05e00',
      toNodeNum: BROADCAST_NODE_NUM,
      toNodeId: '!ffffffff',
    });

    const rows = drizzleDb
      .select()
      .from(messagesSqlite)
      .where(eq(messagesSqlite.id, id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].fromNodeNum).toBe(HIGH_NODE_NUM);
    expect(rows[0].toNodeNum).toBe(BROADCAST_NODE_NUM);
  });
});
