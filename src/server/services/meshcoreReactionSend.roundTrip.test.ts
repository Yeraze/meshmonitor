/**
 * Outbound wire text read back by the inbound resolver (#5762): what we build,
 * a second MeshMonitor source resolves to the same target.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import databaseService from '../../services/database.js';
import { planOutboundReaction } from './meshcoreReactionSend.js';
import { resolveInboundReaction } from './meshcoreReactionIngest.js';
import { parseMeshCoreReaction } from '../../utils/meshcoreReactions.js';
import { mc1HashForDm, mc1HashForOwnChannelText } from '../../utils/meshcoreReactionTarget.js';
import type { DbMeshCoreMessage } from '../../db/repositories/meshcore.js';

const SEC = 1_704_067_200;
const A_KEY = 'ee'.repeat(32);
const B_KEY = 'ab'.repeat(32);
const THUMBS = '\u{1F44D}';
let n = 0;
const src = () => `rt-src-${Date.now().toString(36)}-${++n}`;

const ctxFor = (selfKey: string, selfName: string, peer: string) => ({
  selfKey,
  selfName,
  resolvePeerKey: (p: string) => (peer.startsWith(p) ? peer : null),
  isRoomPeer: () => false,
});

async function seed(sourceId: string, over: Partial<DbMeshCoreMessage>): Promise<DbMeshCoreMessage> {
  const m = {
    id: `${sourceId}-m`,
    fromPublicKey: 'channel-0',
    fromName: 'Bob',
    toPublicKey: null,
    text: 'Hello',
    timestamp: SEC * 1000 + 3,
    senderTimestamp: SEC,
    sourceId,
    createdAt: Date.now(),
    ...over,
  } as DbMeshCoreMessage;
  await databaseService.meshcore.insertMessage(m, sourceId);
  return m;
}

describe('outbound reaction round trip', () => {
  beforeAll(async () => {
    await databaseService.waitForReady();
  });

  it('channel: parse returns emoji, hash, sender; a second source resolves it', async () => {
    const s = src();
    const target = await seed(s, { mc1Hash: mc1HashForOwnChannelText('Hello', SEC) });
    const plan = planOutboundReaction(target, THUMBS, ctxFor(A_KEY, 'Me', B_KEY));
    const parsed = parseMeshCoreReaction(plan.wireText, 'channel');
    expect(parsed).toMatchObject({ format: 'mc1-channel', emoji: THUMBS, hash: plan.meta.targetHash, targetSender: 'Bob' });
    const res = await resolveInboundReaction({
      sourceId: s, scope: 'channel', body: plan.wireText, channelIdx: 0,
      reactorName: 'Me', reactorKey: null, selfName: 'Other', selfKey: B_KEY, now: Date.now(),
    });
    expect(res.kind).toBe('reaction');
    if (res.kind === 'reaction') expect(res.fields.reactionTargetId).toBe(target.id);
  });

  it('channel: target is the second source\'s own message, matched by selfName', async () => {
    const s = src();
    const target = await seed(s, {
      id: 'sent-x', fromPublicKey: B_KEY, fromName: 'Other', toPublicKey: 'channel-0',
      mc1Hash: mc1HashForOwnChannelText('Hello', SEC),
    });
    const plan = planOutboundReaction(
      { ...target, fromPublicKey: 'channel-0', fromName: 'Other', toPublicKey: null } as DbMeshCoreMessage,
      THUMBS, ctxFor(A_KEY, 'Me', B_KEY),
    );
    const res = await resolveInboundReaction({
      sourceId: s, scope: 'channel', body: plan.wireText, channelIdx: 0,
      reactorName: 'Me', reactorKey: null, selfName: 'Other', selfKey: B_KEY, now: Date.now(),
    });
    expect(res.kind).toBe('reaction');
    if (res.kind === 'reaction') expect(res.fields.reactionTargetId).toBe('sent-x');
  });

  it('dm: wire text round-trips and resolves', async () => {
    const s = src();
    const target = await seed(s, {
      fromPublicKey: A_KEY, fromName: null, toPublicKey: B_KEY, mc1Hash: mc1HashForDm('Hello', SEC),
    });
    // Source A reacts to a DM it received from B; on B the target is B's own send.
    const plan = planOutboundReaction(
      { ...target, fromPublicKey: B_KEY.slice(0, 12), toPublicKey: null } as DbMeshCoreMessage,
      THUMBS, ctxFor(A_KEY, 'Me', B_KEY),
    );
    const parsed = parseMeshCoreReaction(plan.wireText, 'dm');
    expect(parsed).toMatchObject({ format: 'mc1-dm', emoji: THUMBS, hash: plan.meta.targetHash });
    const res = await resolveInboundReaction({
      sourceId: s, scope: 'dm', body: plan.wireText, peerKey: A_KEY,
      reactorName: null, reactorKey: A_KEY, selfName: 'Other', selfKey: B_KEY, now: Date.now(),
    });
    expect(res.kind).toBe('reaction');
    if (res.kind === 'reaction') expect(res.fields.reactionTargetId).toBe(target.id);
  });
});
