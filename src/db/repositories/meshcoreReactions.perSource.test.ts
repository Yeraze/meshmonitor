/**
 * Source isolation for the MeshCore reaction repository methods (#5759).
 * Same hash / target id on two sources must never cross.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { MeshCoreRepository } from './meshcore.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const A = 'rx-src-a';
const B = 'rx-src-b';
const NOW = 1_760_000_000_000;

describe('MeshCore reactions - per source (SQLite)', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let repo: MeshCoreRepository;
  beforeEach(() => {
    testDb?.close();
    testDb = createTestDb();
    repo = new MeshCoreRepository(testDb.db as any, 'sqlite');
  });
  afterAll(() => testDb?.close());

  const base = { fromPublicKey: 'channel-1', toPublicKey: 'channel-1', fromName: 'Alice', timestamp: NOW, createdAt: NOW };

  it('every method ignores the other source and refuses an empty one', async () => {
    // Same ids can not repeat (primary key), so mirror them with a source prefix.
    await repo.insertMessage({ ...base, id: 'a-m', text: 'hi', mc1Hash: 'same0001' }, A);
    await repo.insertMessage({ ...base, id: 'b-m', text: 'hi', mc1Hash: 'same0001' }, B);
    await repo.insertMessage({
      ...base, id: 'a-r', text: 'x', reactionEmoji: 'x', reactionFormat: 'mc1-channel',
      reactionTargetHash: 'same0001', reactionTargetId: null,
    }, A);
    await repo.insertMessage({
      ...base, id: 'b-r', text: 'x', reactionEmoji: 'x', reactionFormat: 'mc1-channel',
      reactionTargetHash: 'same0001', reactionTargetId: 'b-m',
    }, B);

    expect((await repo.findMessagesByMc1Hash(A, 'same0001')).map(r => r.id)).toEqual(['a-m']);
    expect((await repo.getReactionCandidates(B, { channelIdx: 1, sinceCreatedAt: 0, limit: 9 })).map(r => r.id)).toEqual(['b-m']);
    expect((await repo.findReactionRows(A, { targetId: 'b-m' }))).toEqual([]);
    expect((await repo.findReactionRows(A, { targetHash: 'same0001' })).map(r => r.id)).toEqual(['a-r']);
    expect((await repo.getUnresolvedReactions(B, 0, 9))).toEqual([]);

    // wrong source refused, row untouched
    expect(await repo.setReactionTarget('a-r', B, 'b-m')).toBe(false);
    expect((await repo.getMessageForSource('a-r', A))!.reactionTargetId).toBeNull();
    expect(await repo.setReactionTarget('a-r', A, 'a-m')).toBe(true);

    // delete on A leaves B alone even when the target id is B's
    expect(await repo.deleteReactionsForTargets(['b-m'], A)).toEqual([]);
    expect(await repo.getMessageForSource('b-r', B)).not.toBeNull();
    expect(await repo.deleteReactionsForTargets(['b-m'], B)).toEqual(['b-r']);

    for (const call of [
      () => repo.findMessagesByMc1Hash('', 'h'),
      () => repo.getReactionCandidates('', { dm: true, sinceCreatedAt: 0, limit: 1 }),
      () => repo.findReactionRows('', { targetId: 'x' }),
      () => repo.getUnresolvedReactions('', 0, 1),
      () => repo.setReactionTarget('x', '', 'y'),
      () => repo.deleteReactionsForTargets(['x'], ''),
    ]) {
      await expect(call()).rejects.toThrow(/sourceId/);
    }
  });

  it('counts and latest timestamps skip reactions per source', async () => {
    await repo.insertMessage({ ...base, id: 'a-m', text: 'hi' }, A);
    await repo.insertMessage({ ...base, id: 'a-r', text: 'x', timestamp: NOW + 50, reactionEmoji: 'x' }, A);
    await repo.insertMessage({ ...base, id: 'b-m', text: 'hi', timestamp: NOW + 9 }, B);
    expect(await repo.getChannelMessageCounts([1], A)).toEqual({ 1: 1 });
    expect(await repo.getChannelLatestTimestamps([1], A)).toEqual({ 1: NOW });
    expect(await repo.getChannelLatestTimestamps([1], B)).toEqual({ 1: NOW + 9 });
  });
});
