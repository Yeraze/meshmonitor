import { describe, it, expect, vi, afterEach } from 'vitest';
import databaseService from '../../services/database.js';
import { planOutboundReaction, isReactionsOutboundEnabled } from './meshcoreReactionSend.js';
import { isMeshCoreReactionError } from '../errors/meshcoreReactionError.js';
import type { DbMeshCoreMessage } from '../../db/repositories/meshcore.js';
import {
  MESHCORE_REACTIONS_OUTBOUND_DEFAULT,
  mc1HashForDm,
  mc1HashForOwnChannelText,
} from '../../utils/meshcoreReactionTarget.js';

const SEC = 1_704_067_200;
const SELF_KEY = 'ee'.repeat(32);
const PEER = 'ab'.repeat(32);
const THUMBS = '\u{1F44D}';

const ctx = (over: Record<string, unknown> = {}) => ({
  selfKey: SELF_KEY,
  selfName: 'Me',
  resolvePeerKey: (p: string) => (PEER.startsWith(p) ? PEER : null),
  isRoomPeer: () => false,
  ...over,
});

function row(over: Partial<DbMeshCoreMessage> = {}): DbMeshCoreMessage {
  return {
    id: 'm1',
    fromPublicKey: 'channel-2',
    fromName: 'Bob',
    toPublicKey: null,
    text: 'Hello',
    timestamp: SEC * 1000 + 5,
    senderTimestamp: SEC,
    ...over,
  } as DbMeshCoreMessage;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(isMeshCoreReactionError(e)).toBe(true);
    return (e as { code: string }).code;
  }
  throw new Error('expected a refusal');
}

afterEach(() => vi.restoreAllMocks());

describe('planOutboundReaction', () => {
  const h = mc1HashForOwnChannelText('Hello', SEC)!;

  it('received channel target', () => {
    const p = planOutboundReaction(row(), THUMBS, ctx());
    expect(p.scope).toBe('channel');
    expect(p.channelIdx).toBe(2);
    expect(p.wireText).toBe(`@[Bob]${THUMBS}\n${h}`);
    expect(p.meta).toEqual({ emoji: THUMBS, format: 'mc1-channel', targetHash: h, targetSender: 'Bob', targetId: 'm1' });
  });

  it('own channel target uses the stored hash and our name', () => {
    const p = planOutboundReaction(
      row({ id: 'sent-1', fromPublicKey: SELF_KEY, fromName: null, toPublicKey: 'channel-2', mc1Hash: 'abcdefgh' }),
      THUMBS,
      ctx(),
    );
    expect(p.wireText).toBe(`@[Me]${THUMBS}\nabcdefgh`);
  });

  it('received DM target', () => {
    const p = planOutboundReaction(row({ fromPublicKey: PEER.slice(0, 12), fromName: null }), THUMBS, ctx());
    expect(p.scope).toBe('dm');
    expect(p.toPublicKey).toBe(PEER);
    expect(p.wireText).toBe(`${THUMBS}\n${mc1HashForDm('Hello', SEC)}`);
    expect(p.meta.format).toBe('mc1-dm');
    expect(p.meta.targetSender).toBeNull();
  });

  it('own DM target goes to the stored peer key', () => {
    const p = planOutboundReaction(
      row({ id: 'sent-2', fromPublicKey: SELF_KEY, fromName: 'Me', toPublicKey: PEER }),
      THUMBS,
      ctx(),
    );
    expect(p.toPublicKey).toBe(PEER);
  });

  it('old received row with whole-second timestamp rebuilds the hash', () => {
    const p = planOutboundReaction(row({ senderTimestamp: null, timestamp: SEC * 1000 }), THUMBS, ctx());
    expect(p.wireText.endsWith(`\n${h}`)).toBe(true);
  });

  it('refuses a sent- row with no wire second', () => {
    expect(codeOf(() => planOutboundReaction(
      row({ id: 'sent-3', fromPublicKey: SELF_KEY, toPublicKey: 'channel-2', senderTimestamp: null }), THUMBS, ctx(),
    ))).toBe('TARGET_NO_HASH');
  });

  it('refuses names with ], an unknown DM peer, a room peer, reactions', () => {
    expect(codeOf(() => planOutboundReaction(row({ fromName: 'a]b' }), THUMBS, ctx()))).toBe('TARGET_NOT_REACTABLE');
    expect(codeOf(() => planOutboundReaction(
      row({ fromPublicKey: 'cd'.repeat(6), fromName: null }), THUMBS, ctx(),
    ))).toBe('TARGET_NOT_REACTABLE');
    expect(codeOf(() => planOutboundReaction(
      row({ fromPublicKey: PEER.slice(0, 12), fromName: null }), THUMBS, ctx({ isRoomPeer: () => true }),
    ))).toBe('TARGET_IS_ROOM_POST');
    expect(codeOf(() => planOutboundReaction(row({ reactionEmoji: THUMBS }), THUMBS, ctx()))).toBe('TARGET_IS_REACTION');
  });

  it('enforces the byte caps', () => {
    const long = 'N'.repeat(115);
    expect(codeOf(() => planOutboundReaction(row({ fromName: long }), THUMBS, ctx()))).toBe('MESSAGE_TOO_LONG');
  });
});

describe('isReactionsOutboundEnabled', () => {
  const stub = (impl: () => Promise<unknown>) =>
    vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({ getSettingForSource: vi.fn(impl) } as never);

  it('unset gives the default; true/false are honoured', async () => {
    stub(async () => null);
    expect(await isReactionsOutboundEnabled('s')).toBe(MESHCORE_REACTIONS_OUTBOUND_DEFAULT);
    vi.restoreAllMocks();
    stub(async () => 'true');
    expect(await isReactionsOutboundEnabled('s')).toBe(true);
    vi.restoreAllMocks();
    stub(async () => 'false');
    expect(await isReactionsOutboundEnabled('s')).toBe(false);
  });

  it('a read error fails closed', async () => {
    stub(async () => { throw new Error('db down'); });
    expect(await isReactionsOutboundEnabled('s')).toBe(false);
  });
});
