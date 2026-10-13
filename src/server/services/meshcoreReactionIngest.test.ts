/**
 * Reaction ingest (#5759 Phase 2) against a REAL in-memory SQLite repository.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { MeshCoreRepository, type DbMeshCoreMessage } from '../../db/repositories/meshcore.js';
import { createTestDb } from '../test-helpers/testDb.js';
import {
  buildMc1ChannelReaction,
  buildMc1DmReaction,
  meshcoreOpenV3Hash,
  dartStringHash,
} from '../../utils/meshcoreReactions.js';
import { mc1HashForChannelWire, mc1HashForDm } from '../../utils/meshcoreReactionTarget.js';

const holder = vi.hoisted(() => ({
  repo: null as unknown,
  settings: new Map<string, string>(),
  failLookups: false,
}));

vi.mock('../../services/database.js', () => ({
  default: {
    get meshcore() {
      return holder.repo;
    },
    settings: {
      getSettingForSource: async (_s: string, k: string) => holder.settings.get(k) ?? null,
    },
  },
}));

const emitted: Array<[string, unknown]> = [];
vi.mock('./dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreMessagesDeleted: (d: unknown) => emitted.push(['deleted', d]),
    emitMeshCoreReactionResolved: (d: unknown) => emitted.push(['resolved', d]),
  },
}));

import {
  resolveInboundReaction,
  resolvePendingReactionsFor,
  notePendingReaction,
  invalidatePendingReactions,
  isReactionsInboundEnabled,
  emitReactionResolutions,
  getReactionIngestStats,
  REACTION_CANDIDATE_LIMIT,
  type InboundReactionInput,
} from './meshcoreReactionIngest.js';

const A = 'src-a';
const B = 'src-b';
const SEC = 1_704_067_200;
const SELF = 'ee'.repeat(32);
const PEER = 'ab'.repeat(32);
let NOW = Date.now();
let n = 0;

describe('meshcoreReactionIngest (SQLite)', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    testDb?.close();
    testDb = createTestDb();
    repo = new MeshCoreRepository(testDb.db as any, 'sqlite');
    holder.repo = repo;
    holder.settings.clear();
    emitted.length = 0;
    invalidatePendingReactions();
    NOW = Date.now();
  });
  afterAll(() => testDb?.close());

  async function chanMsg(o: Partial<DbMeshCoreMessage> & { name?: string; body?: string; sec?: number | null; ch?: number; src?: string; hash?: boolean } = {}) {
    const name = o.name ?? 'Bob';
    const body = o.body ?? 'Hello';
    const sec = o.sec === undefined ? SEC : o.sec;
    const row: DbMeshCoreMessage = {
      id: o.id ?? `c${++n}`,
      fromPublicKey: `channel-${o.ch ?? 1}`,
      toPublicKey: `channel-${o.ch ?? 1}`,
      fromName: name,
      text: body,
      timestamp: sec ? sec * 1000 : NOW,
      createdAt: o.createdAt ?? NOW,
      senderTimestamp: sec ?? null,
      messageType: 'text',
      mc1Hash: o.hash === false || sec === null ? null : mc1HashForChannelWire(`${name}: ${body}`, sec),
      ...o,
    } as DbMeshCoreMessage;
    delete (row as any).name; delete (row as any).body; delete (row as any).sec; delete (row as any).ch; delete (row as any).src; delete (row as any).hash;
    await repo.insertMessage(row, o.src ?? A);
    return row;
  }

  async function dmMsg(o: { id?: string; from: string; to: string; text?: string; sec?: number; hash?: boolean; src?: string }) {
    const text = o.text ?? 'Hello';
    const sec = o.sec ?? SEC;
    const row: DbMeshCoreMessage = {
      id: o.id ?? `d${++n}`, fromPublicKey: o.from, toPublicKey: o.to, text,
      timestamp: sec * 1000, createdAt: NOW, senderTimestamp: sec, messageType: 'text',
      mc1Hash: o.hash === false ? null : mc1HashForDm(text, sec),
    } as DbMeshCoreMessage;
    await repo.insertMessage(row, o.src ?? A);
    return row;
  }

  const chanInput = (body: string, extra: Partial<InboundReactionInput> = {}): InboundReactionInput => ({
    sourceId: A, scope: 'channel', channelIdx: 1, body, reactorName: 'Carol', reactorKey: null, now: NOW, ...extra,
  });
  const dmInput = (body: string, extra: Partial<InboundReactionInput> = {}): InboundReactionInput => ({
    sourceId: A, scope: 'dm', peerKey: PEER, body, reactorName: 'Peer', reactorKey: PEER, selfKey: SELF, now: NOW, ...extra,
  });
  const chanReact = (sender: string, hash: string, emoji = '👍') => buildMc1ChannelReaction(sender, emoji, hash)!;
  const HELLO = mc1HashForDm('Hello', SEC)!;

  async function storeReaction(res: Awaited<ReturnType<typeof resolveInboundReaction>>, o: { id: string; from: string; name?: string | null; to: string; src?: string }) {
    if (res.kind !== 'reaction') throw new Error('expected reaction ' + res.kind);
    await repo.insertMessage({
      id: o.id, fromPublicKey: o.from, fromName: o.name ?? null, toPublicKey: o.to,
      text: res.fields.reactionEmoji, timestamp: NOW, createdAt: NOW, messageType: 'text', ...res.fields,
    } as DbMeshCoreMessage, o.src ?? A);
    return res.fields;
  }

  it('mc1 channel: resolves to the target', async () => {
    const t = await chanMsg();
    const res = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO)));
    expect(res.kind).toBe('reaction');
    if (res.kind !== 'reaction') return;
    expect(res.fields).toMatchObject({
      reactionEmoji: '👍', reactionFormat: 'mc1-channel', reactionTargetHash: HELLO,
      reactionTargetSender: 'Bob', reactionTargetId: t.id,
    });
    expect(res.fields.reactionRawText).toBe(chanReact('Bob', HELLO));
    expect(getReactionIngestStats(A).resolved).toBe(1);
  });

  it('wrong sender stays unmatched', async () => {
    await chanMsg();
    const res = await resolveInboundReaction(chanInput(chanReact('bob', HELLO)));
    expect(res.kind === 'reaction' && res.fields.reactionTargetId).toBeNull();
  });

  it('other channel and other source never match', async () => {
    await chanMsg({ ch: 2 });
    await chanMsg({ id: 'other-src', src: B });
    const res = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO)));
    expect(res.kind === 'reaction' && res.fields.reactionTargetId).toBeNull();
  });

  it('legacy order (hash line first) still resolves', async () => {
    const t = await chanMsg();
    const res = await resolveInboundReaction(chanInput(`👍@[Bob]\n${HELLO}`));
    expect(res.kind === 'reaction' && res.fields.reactionFormat).toBe('mc1-channel-legacy');
    expect(res.kind === 'reaction' && res.fields.reactionTargetId).toBe(t.id);
  });

  it('dm: their message and our message', async () => {
    const theirs = await dmMsg({ from: PEER, to: SELF, text: 'Hello' });
    const r1 = await resolveInboundReaction(dmInput(buildMc1DmReaction('❤️', HELLO)!));
    expect(r1.kind === 'reaction' && r1.fields.reactionTargetId).toBe(theirs.id);

    const ours = await dmMsg({ from: SELF, to: PEER, text: 'Mine', sec: SEC + 5 });
    const h2 = mc1HashForDm('Mine', SEC + 5)!;
    const r2 = await resolveInboundReaction(dmInput(buildMc1DmReaction('👍', h2)!));
    expect(r2.kind === 'reaction' && r2.fields.reactionTargetId).toBe(ours.id);
  });

  it('dm: a 12-hex prefix key matches the full key', async () => {
    const t = await dmMsg({ from: PEER, to: SELF });
    const res = await resolveInboundReaction(dmInput(buildMc1DmReaction('👍', HELLO)!, { peerKey: PEER.slice(0, 12), reactorKey: PEER.slice(0, 12) }));
    expect(res.kind === 'reaction' && res.fields.reactionTargetId).toBe(t.id);
  });

  it('dm: another conversation does not match', async () => {
    await dmMsg({ from: 'cd'.repeat(32), to: SELF });
    const res = await resolveInboundReaction(dmInput(buildMc1DmReaction('👍', HELLO)!));
    expect(res.kind === 'reaction' && res.fields.reactionTargetId).toBeNull();
  });

  it('reaction to our own channel message by self name', async () => {
    const t = await chanMsg({ id: 'sent-1', fromPublicKey: 'local', fromName: null, body: 'Hello', hash: true } as any);
    const h = mc1HashForChannelWire(': Hello', SEC)!;
    const res = await resolveInboundReaction(chanInput(chanReact('Me', h), { selfName: 'Me', selfKey: SELF }));
    expect(res.kind === 'reaction' && res.fields.reactionTargetId).toBe(t.id);
  });

  it('old target with mc1Hash null is found by the lazy scan', async () => {
    const t = await chanMsg({ hash: false });
    expect(t.mc1Hash).toBeNull();
    const res = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO)));
    expect(res.kind === 'reaction' && res.fields.reactionTargetId).toBe(t.id);
  });

  it('mco-v3 channel and DM', async () => {
    const t = await chanMsg({ name: 'Bob', body: 'Hello there' });
    const h = meshcoreOpenV3Hash(SEC, 'Bob', 'Hello there')!;
    const r = await resolveInboundReaction(chanInput(`r:${h}:00`));
    expect(r.kind === 'reaction' && r.fields).toMatchObject({ reactionFormat: 'mco-v3', reactionTargetId: t.id });

    const d = await dmMsg({ from: PEER, to: SELF, text: 'Yo yo yo', sec: SEC + 9, hash: false });
    const hd = meshcoreOpenV3Hash(SEC + 9, null, 'Yo yo yo')!;
    const rd = await resolveInboundReaction(dmInput(`r:${hd}:00`));
    expect(rd.kind === 'reaction' && rd.fields.reactionTargetId).toBe(d.id);
  });

  it('mco-v1 channel shape', async () => {
    const t = await chanMsg({ name: 'Bob', body: 'Hello' });
    const body = `r:${SEC * 1000}_${dartStringHash('Bob')}_${dartStringHash('Hello')}:👍`;
    const res = await resolveInboundReaction(chanInput(body));
    expect(res.kind === 'reaction' && res.fields).toMatchObject({
      reactionFormat: 'mco-v1', reactionTargetHash: String(SEC * 1000), reactionTargetId: t.id,
    });
  });

  it('duplicate: same reactor and emoji, with or without VS16', async () => {
    const t = await chanMsg();
    const first = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO, '❤️')));
    await storeReaction(first, { id: 'r1', from: 'channel-1', name: 'Carol', to: 'channel-1' });
    const again = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO, '❤')));
    expect(again).toEqual({ kind: 'duplicate', existingId: 'r1' });
    // different emoji: a second reaction
    const other = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO, '👍')));
    expect(other.kind).toBe('reaction');
    // different reactor: a second reaction
    const other2 = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO, '❤'), { reactorName: 'Dave' }));
    expect(other2.kind).toBe('reaction');
    expect(t.id).toBeTruthy();
  });

  it('duplicate of an unmatched reaction (same conversation only)', async () => {
    const first = await resolveInboundReaction(chanInput(chanReact('Bob', 'zzzzzzzz')));
    await storeReaction(first, { id: 'u1', from: 'channel-1', name: 'Carol', to: 'channel-1' });
    expect((await resolveInboundReaction(chanInput(chanReact('Bob', 'zzzzzzzz')))).kind).toBe('duplicate');
    expect((await resolveInboundReaction(chanInput(chanReact('Bob', 'zzzzzzzz'), { channelIdx: 2 }))).kind).toBe('reaction');
  });

  it('newest of two matching targets wins', async () => {
    await chanMsg({ id: 'old', createdAt: NOW - 5000 });
    await chanMsg({ id: 'new', createdAt: NOW });
    const res = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO)));
    expect(res.kind === 'reaction' && res.fields.reactionTargetId).toBe('new');
  });

  it('candidate cap and window bound the old-row scan', async () => {
    await chanMsg({ id: 'stale', hash: false, createdAt: NOW - 8 * 24 * 3600 * 1000 });
    const res = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO)));
    expect(res.kind === 'reaction' && res.fields.reactionTargetId).toBeNull();

    await chanMsg({ id: 'deep', hash: false, createdAt: NOW - 100000 });
    for (let i = 0; i < REACTION_CANDIDATE_LIMIT; i++) {
      await chanMsg({ id: `f${i}`, body: `filler ${i}`, sec: SEC + 1000 + i, hash: false, createdAt: NOW - i });
    }
    const res2 = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO)));
    expect(res2.kind === 'reaction' && res2.fields.reactionTargetId).toBeNull();
  });

  it('pending reaction resolves when its target arrives; index hydrates once', async () => {
    const spy = vi.spyOn(repo, 'getUnresolvedReactions');
    const res = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO)));
    await storeReaction(res, { id: 'p1', from: 'channel-1', name: 'Carol', to: 'channel-1' });
    notePendingReaction(A, { id: 'p1', reactionFormat: 'mc1-channel', reactionTargetHash: HELLO });

    const t = await chanMsg({ id: 'late' });
    const out = await resolvePendingReactionsFor(A, { ...t, mc1Hash: t.mc1Hash }, {});
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ reactionId: 'p1', targetId: 'late', droppedDuplicate: false });
    expect((await repo.getMessageForSource('p1', A))!.reactionTargetId).toBe('late');

    // unrelated message: no DB read of reactions, hydrate not repeated
    const other = await chanMsg({ id: 'other', body: 'zzz' });
    expect(await resolvePendingReactionsFor(A, other, {})).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);

    emitReactionResolutions(A, out);
    expect(emitted[0]).toEqual(['resolved', expect.objectContaining({ id: 'p1', reactionTargetId: 'late' })]);
  });

  it('hydrates pending reactions stored before this process', async () => {
    const res = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO)));
    await storeReaction(res, { id: 'h1', from: 'channel-1', name: 'Carol', to: 'channel-1' });
    invalidatePendingReactions();
    const t = await chanMsg({ id: 'tgt' });
    const out = await resolvePendingReactionsFor(A, t, {});
    expect(out.map(o => o.reactionId)).toEqual(['h1']);
  });

  it('a pending duplicate is dropped on resolve', async () => {
    const r1 = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO)));
    await storeReaction(r1, { id: 'k1', from: 'channel-1', name: 'Carol', to: 'channel-1' });
    const t = await chanMsg({ id: 'tt' });
    await repo.setReactionTarget('k1', A, t.id);
    // second copy stored unmatched (e.g. raced), same reactor and emoji
    await repo.insertMessage({
      id: 'k2', fromPublicKey: 'channel-1', fromName: 'Carol', toPublicKey: 'channel-1', text: '👍', timestamp: NOW, createdAt: NOW,
      reactionEmoji: '👍', reactionFormat: 'mc1-channel', reactionTargetHash: HELLO, reactionTargetSender: 'Bob',
      reactionTargetId: null, reactionRawText: chanReact('Bob', HELLO),
    } as DbMeshCoreMessage, A);
    notePendingReaction(A, { id: 'k2', reactionFormat: 'mc1-channel', reactionTargetHash: HELLO });
    const out = await resolvePendingReactionsFor(A, t, {});
    expect(out).toHaveLength(1);
    expect(out[0].droppedDuplicate).toBe(true);
    expect(await repo.getMessageForSource('k2', A)).toBeNull();
    emitReactionResolutions(A, out);
    expect(emitted[0]).toEqual(['deleted', { ids: ['k2'] }]);
  });

  it('pending never crosses sources', async () => {
    const res = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO)));
    await storeReaction(res, { id: 'x1', from: 'channel-1', name: 'Carol', to: 'channel-1' });
    notePendingReaction(A, { id: 'x1', reactionFormat: 'mc1-channel', reactionTargetHash: HELLO });
    const t = await chanMsg({ id: 'b-tgt', src: B });
    expect(await resolvePendingReactionsFor(B, t, {})).toEqual([]);
    expect((await repo.getMessageForSource('x1', A))!.reactionTargetId).toBeNull();
  });

  it('not_reaction cases', async () => {
    expect((await resolveInboundReaction(chanInput('@[x]hello\nworld!'))).kind).toBe('not_reaction');
    expect((await resolveInboundReaction(chanInput('plain chat'))).kind).toBe('not_reaction');
  });

  it('false positive stays an unmatched reaction with the raw text kept', async () => {
    const body = '@[Alice]👍\nreceived';
    const res = await resolveInboundReaction(chanInput(body));
    expect(res.kind).toBe('reaction');
    if (res.kind === 'reaction') {
      expect(res.fields.reactionTargetId).toBeNull();
      expect(res.fields.reactionRawText).toBe(body);
    }
  });

  it('a database error returns the reaction unmatched and never throws', async () => {
    vi.spyOn(repo, 'findMessagesByMc1Hash').mockRejectedValue(new Error('boom'));
    vi.spyOn(repo, 'findReactionRows').mockRejectedValue(new Error('boom'));
    const res = await resolveInboundReaction(chanInput(chanReact('Bob', HELLO)));
    expect(res.kind === 'reaction' && res.fields.reactionTargetId).toBeNull();
  });

  it('inbound setting: unset and anything but false is on', async () => {
    expect(await isReactionsInboundEnabled(A)).toBe(true);
    holder.settings.set('meshcoreReactionsInboundEnabled', 'true');
    expect(await isReactionsInboundEnabled(A)).toBe(true);
    holder.settings.set('meshcoreReactionsInboundEnabled', 'false');
    expect(await isReactionsInboundEnabled(A)).toBe(false);
  });
});
