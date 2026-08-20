/**
 * MessagesRepository.updateMessageDeliveryState — routingErrorCode persistence
 * (#4816 Phase 2, Delivery Diagnostics).
 *
 * Verifies the optional 3rd argument writes the exact numeric Meshtastic
 * RoutingError reason on a failed delivery, that success call sites which
 * omit the argument leave the column untouched (NULL), and that the update
 * is correctly scoped per-source via the (source-unique) requestId.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('MessagesRepository.updateMessageDeliveryState — routingErrorCode', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MessagesRepository;

  const NODE_NUM = 0xaabbccdd;
  const NODE_ID = '!aabbccdd';

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    const now = Date.now();
    for (const src of ['src-a', 'src-b']) {
      db.prepare(
        'INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
      ).run(NODE_NUM, NODE_ID, src, now, now);
    }
    repo = new MessagesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => db.close());

  const insert = async (id: string, requestId: number, sourceId: string) =>
    repo.insertMessage(
      {
        id,
        fromNodeNum: NODE_NUM,
        toNodeNum: NODE_NUM,
        fromNodeId: NODE_ID,
        toNodeId: NODE_ID,
        text: 'hi',
        channel: 0,
        portnum: 1,
        requestId,
        timestamp: 1000,
        createdAt: 1000,
      } as any,
      sourceId,
    );

  it('writes routingErrorCode when the 3rd arg is passed on a failed delivery', async () => {
    await insert('msg-1', 111, 'src-a');

    const updated = await repo.updateMessageDeliveryState(111, 'failed', 5);
    expect(updated).toBe(true);

    const msg = await repo.getMessage('msg-1');
    expect(msg?.deliveryState).toBe('failed');
    expect(msg?.routingErrorCode).toBe(5);
  });

  it('leaves routingErrorCode NULL when a delivered/confirmed call omits the 3rd arg', async () => {
    await insert('msg-2', 222, 'src-a');

    const updated = await repo.updateMessageDeliveryState(222, 'delivered');
    expect(updated).toBe(true);

    const msg = await repo.getMessage('msg-2');
    expect(msg?.deliveryState).toBe('delivered');
    expect(msg?.routingErrorCode ?? null).toBeNull();
  });

  it('does not clobber an existing routingErrorCode when a later call omits the 3rd arg', async () => {
    await insert('msg-3', 333, 'src-a');

    await repo.updateMessageDeliveryState(333, 'failed', 7);
    let msg = await repo.getMessage('msg-3');
    expect(msg?.routingErrorCode).toBe(7);

    // A hypothetical follow-up call without the 3rd arg must not wipe it out.
    await repo.updateMessageDeliveryState(333, 'failed');
    msg = await repo.getMessage('msg-3');
    expect(msg?.routingErrorCode).toBe(7);
  });

  it('is scoped per-source — updating source A does not affect source B', async () => {
    await insert('msg-a', 444, 'src-a');
    await insert('msg-b', 555, 'src-b');

    await repo.updateMessageDeliveryState(444, 'failed', 3);

    const msgA = await repo.getMessage('msg-a');
    const msgB = await repo.getMessage('msg-b');
    expect(msgA?.routingErrorCode).toBe(3);
    expect(msgB?.routingErrorCode ?? null).toBeNull();
  });
});
