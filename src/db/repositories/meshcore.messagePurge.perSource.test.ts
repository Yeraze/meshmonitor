/**
 * MeshCore message-deletion / purge — per-source isolation tests (#3981).
 *
 * The `meshcore_messages` table carries a `sourceId` on every row. The delete
 * helpers added for the message-purge feature MUST scope every operation to a
 * single source so one source's purge can never remove another's history.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MeshCoreRepository, type DbMeshCoreMessage } from './meshcore.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

let idSeq = 0;
function makeMessage(sourceId: string, overrides: Partial<DbMeshCoreMessage> = {}): DbMeshCoreMessage {
  const now = 1_700_000_000_000;
  return {
    id: `msg-${++idSeq}`,
    fromPublicKey: 'aa'.repeat(32),
    toPublicKey: 'bb'.repeat(32),
    text: 'hello',
    timestamp: now,
    messageType: 'text',
    sourceId,
    createdAt: now,
    ...overrides,
  };
}

describe('MeshCoreRepository — message purge per-source isolation (#3981)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    idSeq = 0;
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MeshCoreRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('every delete helper rejects a missing sourceId', async () => {
    await expect(repo.deleteMessageForSource('x', '')).rejects.toThrow(/sourceId/);
    await expect(repo.deleteMessagesByIds(['x'], '')).rejects.toThrow(/sourceId/);
    await expect(repo.getMessageEndpointsForSource('')).rejects.toThrow(/sourceId/);
    await expect(repo.deleteChannelMessagesForSource(0, '')).rejects.toThrow(/sourceId/);
    await expect(repo.deleteAllMessagesForSource('')).rejects.toThrow(/sourceId/);
  });

  it('deleteMessageForSource refuses to delete another source\'s message', async () => {
    // `id` is the global primary key, so an id belongs to exactly one source.
    // Deleting under the wrong source id must be a no-op (defends against a
    // client guessing an id owned by a different source).
    await repo.insertMessage(makeMessage('src-a', { id: 'a-id' }), 'src-a');
    await repo.insertMessage(makeMessage('src-b', { id: 'b-id' }), 'src-b');

    // Scoped to src-a but targeting src-b's message → no-op, row survives.
    expect(await repo.deleteMessageForSource('b-id', 'src-a')).toBe(false);
    expect(await repo.getMessageCount()).toBe(2);

    // Correct source → deletes, leaving the other source untouched.
    expect(await repo.deleteMessageForSource('a-id', 'src-a')).toBe(true);
    const survivors = await repo.getRecentMessages(10, 'src-b');
    expect(survivors).toHaveLength(1);
    expect(survivors[0].sourceId).toBe('src-b');

    // Deleting a non-existent row returns false.
    expect(await repo.deleteMessageForSource('missing', 'src-a')).toBe(false);
  });

  it('deleteMessagesByIds ignores ids that belong to a different source', async () => {
    await repo.insertMessage(makeMessage('src-a', { id: 'a1' }), 'src-a');
    await repo.insertMessage(makeMessage('src-a', { id: 'a2' }), 'src-a');
    await repo.insertMessage(makeMessage('src-b', { id: 'b1' }), 'src-b');

    // Ask to delete one src-a id and one src-b id, but scoped to src-a.
    const removed = await repo.deleteMessagesByIds(['a1', 'b1'], 'src-a');
    expect(removed).toBe(1);
    expect(await repo.getMessageCount()).toBe(2); // a2 + b1 remain
    expect(await repo.getRecentMessages(10, 'src-b')).toHaveLength(1);
  });

  it('deleteMessagesByIds chunks large id lists without leaking across sources', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 1200; i++) {
      const id = `bulk-${i}`;
      ids.push(id);
      await repo.insertMessage(makeMessage('src-a', { id }), 'src-a');
    }
    await repo.insertMessage(makeMessage('src-b', { id: 'keep' }), 'src-b');

    const removed = await repo.deleteMessagesByIds(ids, 'src-a');
    expect(removed).toBe(1200);
    expect(await repo.getRecentMessages(10, 'src-a')).toHaveLength(0);
    expect(await repo.getRecentMessages(10, 'src-b')).toHaveLength(1);
  });

  it('deleteChannelMessagesForSource clears one channel in one source only', async () => {
    // Channel 3 messages use the synthetic `channel-3` key.
    await repo.insertMessage(makeMessage('src-a', { id: 'a-c3', fromPublicKey: 'channel-3', toPublicKey: null }), 'src-a');
    await repo.insertMessage(makeMessage('src-a', { id: 'a-c4', fromPublicKey: 'channel-4', toPublicKey: null }), 'src-a');
    await repo.insertMessage(makeMessage('src-b', { id: 'b-c3', fromPublicKey: 'channel-3', toPublicKey: null }), 'src-b');

    const removed = await repo.deleteChannelMessagesForSource(3, 'src-a');
    expect(removed).toBe(1);
    // src-a channel 4 untouched, src-b channel 3 untouched.
    expect(await repo.getMessageCount()).toBe(2);
    const bRows = await repo.getRecentMessages(10, 'src-b');
    expect(bRows.map(m => m.id)).toEqual(['b-c3']);
  });

  it('deleteAllMessagesForSource wipes one source and leaves the other intact', async () => {
    await repo.insertMessage(makeMessage('src-a', { id: 'a1' }), 'src-a');
    await repo.insertMessage(makeMessage('src-a', { id: 'a2' }), 'src-a');
    await repo.insertMessage(makeMessage('src-b', { id: 'b1' }), 'src-b');

    const removed = await repo.deleteAllMessagesForSource('src-a');
    expect(removed).toBe(2);
    expect(await repo.getRecentMessages(10, 'src-a')).toHaveLength(0);
    expect(await repo.getRecentMessages(10, 'src-b')).toHaveLength(1);
  });

  it('getMessageEndpointsForSource returns only the source rows needed for DM matching', async () => {
    await repo.insertMessage(makeMessage('src-a', { id: 'a1', fromPublicKey: 'cc'.repeat(6), toPublicKey: 'aa'.repeat(32) }), 'src-a');
    await repo.insertMessage(makeMessage('src-b', { id: 'b1' }), 'src-b');

    const rows = await repo.getMessageEndpointsForSource('src-a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'a1', fromPublicKey: 'cc'.repeat(6) });
  });
});
