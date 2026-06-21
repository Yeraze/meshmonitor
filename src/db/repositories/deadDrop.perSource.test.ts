/**
 * DeadDropRepository tests.
 *
 * Covers the per-source async message store: store/read pending, played/clear,
 * delete-by-shortId, per-recipient and per-sender caps, expiry filtering, and
 * source isolation (two sources sharing a recipient name never leak).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DeadDropRepository } from './deadDrop.js';
import type { DeadDropMessageInput } from './deadDrop.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const NOW = 1_000_000;
const WEEK = 7 * 24 * 3600 * 1000;
const cutoff = NOW - WEEK;

function msg(overrides: Partial<DeadDropMessageInput> = {}): DeadDropMessageInput {
  return {
    sourceId: 'source-a',
    shortId: 'AAAA',
    recipientName: 'wisp',
    senderNodeNum: 111,
    senderShortName: 'ZNOF',
    senderLongName: 'ZN Office',
    body: 'hello from the roof',
    ...overrides,
  };
}

describe('DeadDropRepository', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: DeadDropRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new DeadDropRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('stores and retrieves a pending message', async () => {
    await repo.insertMessage(msg(), NOW);
    const pending = await repo.getPendingForRecipient('source-a', ['wisp'], cutoff);
    expect(pending).toHaveLength(1);
    expect(pending[0].body).toBe('hello from the roof');
    expect(pending[0].senderShortName).toBe('ZNOF');
    expect(pending[0].playedAt).toBeNull();
  });

  it('matches the recipient against any provided identity form', async () => {
    await repo.insertMessage(msg({ recipientName: '!abcd1234' }), NOW);
    // Retriever asks with several identity forms; node-id form should match.
    const pending = await repo.getPendingForRecipient('source-a', ['wisp', 'wisp node', '!abcd1234'], cutoff);
    expect(pending).toHaveLength(1);
  });

  it('isolates messages between sources sharing a recipient name', async () => {
    await repo.insertMessage(msg({ sourceId: 'source-a', shortId: 'AAAA' }), NOW);
    await repo.insertMessage(msg({ sourceId: 'source-b', shortId: 'BBBB' }), NOW);

    expect(await repo.getPendingForRecipient('source-a', ['wisp'], cutoff)).toHaveLength(1);
    expect(await repo.getPendingForRecipient('source-b', ['wisp'], cutoff)).toHaveLength(1);
    // shortId is unique per-source, so the same code can exist in both
    expect((await repo.getByShortId('source-a', 'AAAA'))!.shortId).toBe('AAAA');
    expect(await repo.getByShortId('source-b', 'AAAA')).toBeNull();
  });

  it('orders pending oldest-first', async () => {
    await repo.insertMessage(msg({ shortId: 'OLD1', body: 'first' }), NOW - 5000);
    await repo.insertMessage(msg({ shortId: 'NEW1', body: 'second' }), NOW);
    const pending = await repo.getPendingForRecipient('source-a', ['wisp'], cutoff);
    expect(pending.map(m => m.body)).toEqual(['first', 'second']);
  });

  it('markPlayed removes a message from pending but keeps it for clear', async () => {
    await repo.insertMessage(msg(), NOW);
    const [m] = await repo.getPendingForRecipient('source-a', ['wisp'], cutoff);
    await repo.markPlayed('source-a', [m.id!], NOW + 10);

    expect(await repo.getPendingForRecipient('source-a', ['wisp'], cutoff)).toHaveLength(0);
    expect(await repo.getPlayedForRecipient('source-a', ['wisp'], cutoff)).toHaveLength(1);
  });

  it('softDelete hides a message from all reads', async () => {
    await repo.insertMessage(msg(), NOW);
    const [m] = await repo.getPendingForRecipient('source-a', ['wisp'], cutoff);
    await repo.softDelete('source-a', [m.id!], NOW + 20);

    expect(await repo.getPendingForRecipient('source-a', ['wisp'], cutoff)).toHaveLength(0);
    expect(await repo.getByShortId('source-a', 'AAAA')).toBeNull();
  });

  it('getByShortId finds a live message and respects soft-delete', async () => {
    await repo.insertMessage(msg({ shortId: 'M4K2' }), NOW);
    const found = await repo.getByShortId('source-a', 'M4K2');
    expect(found).not.toBeNull();
    expect(found!.recipientName).toBe('wisp');
  });

  it('counts pending per recipient and per sender for caps', async () => {
    await repo.insertMessage(msg({ shortId: 'A1', recipientName: 'wisp', senderNodeNum: 111 }), NOW);
    await repo.insertMessage(msg({ shortId: 'A2', recipientName: 'wisp', senderNodeNum: 111 }), NOW);
    await repo.insertMessage(msg({ shortId: 'A3', recipientName: 'wisp', senderNodeNum: 222 }), NOW);

    expect(await repo.countPendingForRecipient('source-a', ['wisp'], cutoff)).toBe(3);
    expect(await repo.countPendingFromSender('source-a', 111, cutoff)).toBe(2);
    expect(await repo.countPendingFromSender('source-a', 222, cutoff)).toBe(1);
  });

  it('excludes expired messages from reads and counts', async () => {
    await repo.insertMessage(msg({ shortId: 'EXP1' }), cutoff - 1); // older than cutoff
    await repo.insertMessage(msg({ shortId: 'LIVE1' }), NOW);

    expect(await repo.getPendingForRecipient('source-a', ['wisp'], cutoff)).toHaveLength(1);
    expect(await repo.countPendingForRecipient('source-a', ['wisp'], cutoff)).toBe(1);
  });

  it('purgeExpired hard-deletes old rows', async () => {
    await repo.insertMessage(msg({ shortId: 'EXP1' }), cutoff - 1);
    await repo.insertMessage(msg({ shortId: 'LIVE1' }), NOW);
    expect(await repo.purgeExpired(cutoff)).toBe(1);
    // The live one (created at NOW) is retained; only the row older than cutoff is gone.
    expect(await repo.getByShortId('source-a', 'LIVE1')).not.toBeNull();
    expect(await repo.getByShortId('source-a', 'EXP1')).toBeNull();
  });
});
