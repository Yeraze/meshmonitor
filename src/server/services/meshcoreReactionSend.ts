/**
 * Plan an outbound MeshCore reaction (#5762).
 *
 * `planOutboundReaction` is pure: it turns a stored target row and an emoji
 * into the exact wire text, the destination and the metadata the send path
 * stores. It sends nothing and arms no timer. Format: MeshCore One only.
 *
 * Mesh impact: one packet per reaction; the caller (MeshCoreManager.sendReaction)
 * owns dedupe, serialisation and the no-retry rule.
 */
import type { DbMeshCoreMessage } from '../../db/repositories/meshcore.js';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { buildMc1ChannelReaction, buildMc1DmReaction } from '../../utils/meshcoreReactions.js';
import {
  reactionTargetBlocker,
  resolveReactionsOutbound,
  storedMc1Hash,
} from '../../utils/meshcoreReactionTarget.js';
import { meshcoreChannelIndexOf } from '../utils/meshcoreMessageMerge.js';
import {
  MESHCORE_MAX_MESSAGE_BYTES_CHANNEL_SCOPED,
  MESHCORE_MAX_MESSAGE_BYTES_DM,
} from '../constants/meshcoreMessageLimits.js';
import { MeshCoreReactionError } from '../errors/meshcoreReactionError.js';

/** Per-source switch. A read error means off: this gates a transmit. */
export async function isReactionsOutboundEnabled(sourceId: string): Promise<boolean> {
  try {
    const v = await databaseService.settings.getSettingForSource(sourceId, 'meshcoreReactionsOutboundEnabled');
    return resolveReactionsOutbound(v);
  } catch (err) {
    logger.warn('[MeshCore] reaction outbound setting read failed; treating as off:', err);
    return false;
  }
}

export interface OutboundReactionMeta {
  emoji: string;
  format: 'mc1-channel' | 'mc1-dm';
  targetHash: string;
  targetSender: string | null;
  targetId: string;
}

export interface OutboundReactionPlan {
  scope: 'channel' | 'dm';
  /** Channel scope. */
  channelIdx?: number;
  /** DM scope: full 64-hex key of the peer. */
  toPublicKey?: string;
  wireText: string;
  meta: OutboundReactionMeta;
}

const FULL_KEY = /^[0-9a-fA-F]{64}$/;

/** Pure. Throws MeshCoreReactionError. */
export function planOutboundReaction(
  target: DbMeshCoreMessage,
  emoji: string,
  ctx: {
    selfKey: string | null;
    selfName: string | null;
    resolvePeerKey: (prefix: string) => string | null;
    isRoomPeer: (fullKey: string) => boolean;
  },
): OutboundReactionPlan {
  const channelIdx = meshcoreChannelIndexOf(target);
  const scope: 'channel' | 'dm' = channelIdx !== null ? 'channel' : 'dm';

  const blocker = reactionTargetBlocker(
    { ...target, timestamp: Number(target.timestamp) },
    { scope, selfKey: ctx.selfKey, selfName: ctx.selfName },
  );
  if (blocker) throw new MeshCoreReactionError(blocker, blockerMessage(blocker));

  const hash = storedMc1Hash({ ...target, timestamp: Number(target.timestamp) }, scope);
  if (hash === null) throw new MeshCoreReactionError('TARGET_NO_HASH', blockerMessage('TARGET_NO_HASH'));

  if (scope === 'channel') {
    const own = target.fromPublicKey === 'local' || (!!ctx.selfKey && target.fromPublicKey === ctx.selfKey);
    const targetSender = target.fromName || (own ? ctx.selfName : null);
    const wireText = targetSender ? buildMc1ChannelReaction(targetSender, emoji, hash) : null;
    if (!targetSender || wireText === null) {
      throw new MeshCoreReactionError('TARGET_NOT_REACTABLE', blockerMessage('TARGET_NOT_REACTABLE'));
    }
    if (Buffer.byteLength(wireText, 'utf8') > MESHCORE_MAX_MESSAGE_BYTES_CHANNEL_SCOPED) {
      throw new MeshCoreReactionError('MESSAGE_TOO_LONG', 'Reaction is too long for a channel message');
    }
    return {
      scope,
      channelIdx: channelIdx as number,
      wireText,
      meta: { emoji, format: 'mc1-channel', targetHash: hash, targetSender, targetId: target.id },
    };
  }

  const own = target.fromPublicKey === 'local' || (!!ctx.selfKey && target.fromPublicKey === ctx.selfKey);
  const peer = own ? (target.toPublicKey ?? null) : ctx.resolvePeerKey(target.fromPublicKey);
  if (!peer || !FULL_KEY.test(peer)) {
    throw new MeshCoreReactionError('TARGET_NOT_REACTABLE', 'The other side of this conversation is unknown');
  }
  if (ctx.isRoomPeer(peer)) {
    throw new MeshCoreReactionError('TARGET_IS_ROOM_POST', blockerMessage('TARGET_IS_ROOM_POST'));
  }
  const wireText = buildMc1DmReaction(emoji, hash);
  if (wireText === null) throw new MeshCoreReactionError('INVALID_EMOJI', 'Not a reaction emoji');
  if (Buffer.byteLength(wireText, 'utf8') > MESHCORE_MAX_MESSAGE_BYTES_DM) {
    throw new MeshCoreReactionError('MESSAGE_TOO_LONG', 'Reaction is too long for a direct message');
  }
  return {
    scope,
    toPublicKey: peer,
    wireText,
    meta: { emoji, format: 'mc1-dm', targetHash: hash, targetSender: null, targetId: target.id },
  };
}

function blockerMessage(code: string): string {
  switch (code) {
    case 'TARGET_IS_REACTION': return 'A reaction cannot be reacted to';
    case 'TARGET_IS_ROOM_POST': return 'Room posts cannot be reacted to';
    case 'TARGET_NO_HASH': return 'This message is too old to react to';
    default: return 'This message cannot be reacted to';
  }
}
