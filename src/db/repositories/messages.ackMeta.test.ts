/**
 * MessagesRepository.updateMessageDeliveryState — ack metadata persistence
 * (#4851: Delivery Details popup showed every field but delivery state as
 * "Unknown" because the destination ACK's ackFromNode/relayNode/rxSnr/rxRssi
 * were never written back to the message row).
 *
 * Mirrors messages.routingErrorCode.perSource.test.ts: verifies the optional
 * 4th argument writes the ack metadata, that call sites which omit it leave
 * the columns untouched (NULL), and that a later omitted call doesn't clobber
 * previously-written values.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('MessagesRepository.updateMessageDeliveryState — ack metadata', () => {
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
    db.prepare(
      'INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
    ).run(NODE_NUM, NODE_ID, 'src-a', now, now);
    repo = new MessagesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => db.close());

  const insert = async (id: string, requestId: number) =>
    repo.insertMessage(
      {
        id,
        fromNodeNum: NODE_NUM,
        toNodeNum: NODE_NUM,
        fromNodeId: NODE_ID,
        toNodeId: NODE_ID,
        text: 'hi',
        channel: -1,
        portnum: 1,
        requestId,
        timestamp: 1000,
        createdAt: 1000,
      } as any,
      'src-a',
    );

  it('writes ackFromNode/relayNode/rxSnr/rxRssi when the 4th arg is passed on a destination ACK', async () => {
    await insert('msg-1', 111);

    const updated = await repo.updateMessageDeliveryState(111, 'confirmed', undefined, {
      ackFromNode: 0x22222222,
      relayNode: 0x4a,
      rxSnr: 7.25,
      rxRssi: -91,
    });
    expect(updated).toBe(true);

    const msg = await repo.getMessage('msg-1');
    expect(msg?.deliveryState).toBe('confirmed');
    expect(msg?.ackFromNode).toBe(0x22222222);
    expect(msg?.relayNode).toBe(0x4a);
    expect(msg?.rxSnr).toBe(7.25);
    expect(msg?.rxRssi).toBe(-91);
  });

  it('leaves ack metadata NULL when a call omits the 4th arg', async () => {
    await insert('msg-2', 222);

    const updated = await repo.updateMessageDeliveryState(222, 'delivered');
    expect(updated).toBe(true);

    const msg = await repo.getMessage('msg-2');
    expect(msg?.deliveryState).toBe('delivered');
    expect(msg?.ackFromNode ?? null).toBeNull();
    expect(msg?.relayNode ?? null).toBeNull();
    expect(msg?.rxSnr ?? null).toBeNull();
    expect(msg?.rxRssi ?? null).toBeNull();
  });

  it('does not clobber existing ack metadata when a later call omits the 4th arg', async () => {
    await insert('msg-3', 333);

    await repo.updateMessageDeliveryState(333, 'confirmed', undefined, {
      ackFromNode: 0x33333333,
      relayNode: 0x7f,
      rxSnr: 3.5,
      rxRssi: -100,
    });

    // A hypothetical follow-up call (e.g. a duplicate/retried ack) without
    // the 4th arg must not wipe out what was already recorded.
    await repo.updateMessageDeliveryState(333, 'confirmed');

    const msg = await repo.getMessage('msg-3');
    expect(msg?.ackFromNode).toBe(0x33333333);
    expect(msg?.relayNode).toBe(0x7f);
    expect(msg?.rxSnr).toBe(3.5);
    expect(msg?.rxRssi).toBe(-100);
  });

  it('writes only the ack metadata fields explicitly provided, leaving the rest untouched', async () => {
    await insert('msg-4', 444);

    await repo.updateMessageDeliveryState(444, 'confirmed', undefined, {
      ackFromNode: 0x44444444,
    });

    const msg = await repo.getMessage('msg-4');
    expect(msg?.ackFromNode).toBe(0x44444444);
    expect(msg?.relayNode ?? null).toBeNull();
    expect(msg?.rxSnr ?? null).toBeNull();
    expect(msg?.rxRssi ?? null).toBeNull();
  });
});
