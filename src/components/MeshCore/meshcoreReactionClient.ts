/**
 * Client helpers for sending MeshCore reactions (#5762). Pure: no I/O, no clock.
 */
import type { MeshCoreMessage } from './hooks/useMeshCore';
import { DEFAULT_TAPBACK_EMOJIS, type TapbackEmoji } from '../EmojiPickerModal/EmojiPickerModal';
import { isReactionEmoji } from '../../utils/meshcoreReactions';
import { foldReactionEmoji, reactionTargetBlocker } from '../../utils/meshcoreReactionTarget';

/** `MeshCoreMessage` plus the client-only flag the optimistic row carries. */
export type MeshCoreMessageWithPending = MeshCoreMessage & { reactionPending?: boolean };

/** Picker options: the configured list, else the defaults, minus anything MeshCore cannot send. */
export function reactionEmojiOptions(configured: TapbackEmoji[] | undefined): TapbackEmoji[] {
  const usable = (list: TapbackEmoji[]) => list.filter(e => isReactionEmoji(e.emoji));
  const fromConfig = configured ? usable(configured) : [];
  return fromConfig.length > 0 ? fromConfig : usable(DEFAULT_TAPBACK_EMOJIS);
}

/** Id of the optimistic row; the same emoji folds to the same id. */
export function pendingReactionId(targetId: string, emoji: string): string {
  return `pending-reaction-${targetId}-${foldReactionEmoji(emoji)}`;
}

const isChannelKey = (key: string | undefined | null): key is string => !!key && key.startsWith('channel-');

function scopeOf(m: Pick<MeshCoreMessage, 'fromPublicKey' | 'toPublicKey'>): 'channel' | 'dm' {
  return isChannelKey(m.fromPublicKey) || isChannelKey(m.toPublicKey) ? 'channel' : 'dm';
}

/** The row we show at once while the server sends the reaction. */
export function buildOptimisticReaction(
  target: MeshCoreMessage,
  emoji: string,
  self: { publicKey: string; name?: string },
  now: number,
): MeshCoreMessageWithPending {
  const scope = scopeOf(target);
  let toPublicKey: string | undefined;
  if (scope === 'channel') {
    toPublicKey = isChannelKey(target.toPublicKey) ? target.toPublicKey : target.fromPublicKey;
  } else {
    toPublicKey = target.fromPublicKey === self.publicKey ? target.toPublicKey : target.fromPublicKey;
  }
  return {
    id: pendingReactionId(target.id, emoji),
    fromPublicKey: self.publicKey,
    fromName: self.name,
    toPublicKey,
    text: emoji,
    timestamp: now,
    reactionEmoji: emoji,
    reactionTargetId: target.id,
    reactionFormat: scope === 'channel' ? 'mc1-channel' : 'mc1-dm',
    reactionPending: true,
  };
}

/** True when the react button and clickable chips may show on this row. */
export function isReactableRow(m: MeshCoreMessage, selfPublicKey: string | undefined): boolean {
  if (m.filtered) return false;
  return reactionTargetBlocker(m, { scope: scopeOf(m), selfKey: selfPublicKey }) === null;
}
