/**
 * groupMeshCoreReactions (#5759): reaction rows fold into chips under their
 * target; an unmatched one stays as a row.
 */
import { describe, it, expect } from 'vitest';
import { groupMeshCoreReactions, isReactionRow } from './meshcoreReactionGroups';
import type { MeshCoreMessage } from './hooks/useMeshCore';

const SELF = 'a'.repeat(64);
const PEER = 'b'.repeat(64);

function msg(id: string, extra: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return { id, fromPublicKey: 'channel-1', fromName: 'Alice', text: 'hello', timestamp: 1000, ...extra };
}
function reaction(id: string, emoji: string, target: string | null, extra: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return msg(id, { fromName: 'Bob', text: emoji, reactionEmoji: emoji, reactionTargetId: target, ...extra });
}
const opts = { youLabel: 'You' };

describe('groupMeshCoreReactions', () => {
  it('returns the same list when there are no reactions', () => {
    const list = [msg('m1'), msg('m2')];
    const out = groupMeshCoreReactions(list, opts);
    expect(out.rows).toBe(list);
    expect(out.chipsByTarget.size).toBe(0);
  });

  it('turns a resolved reaction into a chip and drops its row', () => {
    const out = groupMeshCoreReactions([msg('m1'), reaction('r1', '👍', 'm1')], opts);
    expect(out.rows.map(m => m.id)).toEqual(['m1']);
    expect(out.chipsByTarget.get('m1')).toEqual([{ emoji: '👍', count: 1, reactors: ['Bob'] }]);
  });

  it('counts each reactor once per emoji and keeps emoji in first-seen order', () => {
    const out = groupMeshCoreReactions([
      msg('m1'),
      reaction('r1', '👍', 'm1'),
      reaction('r2', '😂', 'm1', { fromName: 'Carol' }),
      reaction('r3', '👍', 'm1', { fromName: 'Carol' }),
      reaction('r4', '👍', 'm1'),
    ], opts);
    expect(out.chipsByTarget.get('m1')).toEqual([
      { emoji: '👍', count: 2, reactors: ['Bob', 'Carol'] },
      { emoji: '😂', count: 1, reactors: ['Carol'] },
    ]);
  });

  it('treats a heart with and without the variation selector as one emoji', () => {
    const out = groupMeshCoreReactions([
      msg('m1'),
      reaction('r1', '❤️', 'm1'),
      reaction('r2', '❤', 'm1', { fromName: 'Carol' }),
    ], opts);
    expect(out.chipsByTarget.get('m1')).toEqual([{ emoji: '❤️', count: 2, reactors: ['Bob', 'Carol'] }]);
  });

  it('keeps an unmatched reaction as a row', () => {
    const r = reaction('r1', '👍', null);
    const out = groupMeshCoreReactions([msg('m1'), r], opts);
    expect(out.rows.map(m => m.id)).toEqual(['m1', 'r1']);
    expect(isReactionRow(out.rows[1])).toBe(true);
    expect(out.chipsByTarget.size).toBe(0);
  });

  it('hides a reaction whose target is not in the list', () => {
    const out = groupMeshCoreReactions([msg('m1'), reaction('r1', '👍', 'older')], opts);
    expect(out.rows.map(m => m.id)).toEqual(['m1']);
    expect(out.chipsByTarget.size).toBe(0);
  });

  it('never hangs a chip on another reaction row', () => {
    const out = groupMeshCoreReactions([reaction('r1', '👍', null), reaction('r2', '😂', 'r1')], opts);
    expect(out.rows.map(m => m.id)).toEqual(['r1']);
    expect(out.chipsByTarget.size).toBe(0);
  });

  it('drops a reaction from an ignored sender, matched or not', () => {
    const out = groupMeshCoreReactions([
      msg('m1'),
      reaction('r1', '👍', 'm1', { filtered: 'ignore' }),
      reaction('r2', '👍', null, { filtered: 'ignore' }),
    ], opts);
    expect(out.rows.map(m => m.id)).toEqual(['m1']);
    expect(out.chipsByTarget.size).toBe(0);
  });

  it('lets the resolutions map supply a target the row lacks', () => {
    const list = [msg('m1'), reaction('r1', '👍', null)];
    const out = groupMeshCoreReactions(list, { ...opts, resolutions: { r1: 'm1' } });
    expect(out.rows.map(m => m.id)).toEqual(['m1']);
    expect(out.chipsByTarget.get('m1')?.[0].count).toBe(1);
  });

  it('labels our own reaction "You" and a DM reactor by contact name', () => {
    const out = groupMeshCoreReactions([
      msg('m1', { fromPublicKey: SELF, toPublicKey: PEER, fromName: undefined }),
      reaction('r1', '👍', 'm1', { fromPublicKey: PEER.slice(0, 12), toPublicKey: SELF, fromName: undefined }),
      reaction('r2', '👍', 'm1', { fromPublicKey: PEER, toPublicKey: SELF, fromName: undefined }),
      reaction('r3', '👍', 'm1', { fromPublicKey: SELF, toPublicKey: PEER, fromName: undefined }),
    ], { youLabel: 'You', selfPublicKey: SELF, nameForKey: () => 'Peer' });
    // The 6-byte prefix and the full key are one reactor.
    expect(out.chipsByTarget.get('m1')).toEqual([{ emoji: '👍', count: 2, reactors: ['Peer', 'You'] }]);
  });
});
