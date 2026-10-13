/**
 * Pure rules that tie a MeshCore reaction to the message it names (#5759).
 *
 * Built on the Phase 1 codec (meshcoreReactions.ts). No I/O, no clock, and no
 * Node-only imports: the server ingest path and the client share these rules.
 *
 * Mesh impact: none. Nothing here sends a packet or arms a timer.
 */

import {
  dartStringHash,
  mc1ChannelBody,
  mc1ReactionHash,
  meshcoreOpenV3Hash,
  parseMeshCoreReaction,
  type MeshCoreReaction,
} from './meshcoreReactions.js';

const U32_MAX = 0xffffffff;
const I32_MIN = -0x80000000;

/**
 * A wire sender_timestamp we can hash with: an integer in 1..0xffffffff.
 * A negative int32 (the decoder can hand one back) is read as unsigned first.
 * Anything else gives null.
 */
export function meshcoreWireSecond(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value > U32_MAX || value < I32_MIN) return null;
  const sec = value >>> 0;
  return sec >= 1 ? sec : null;
}

/**
 * Wire second of a STORED row: `senderTimestamp` when > 0. Else, for a row
 * whose id does not start with `sent-`, `timestamp / 1000` when the timestamp
 * is whole seconds. No plausibility gate: MC1 hashes with whatever the sender
 * stamped.
 */
export function storedWireSecond(row: {
  id: string;
  timestamp: number;
  senderTimestamp?: number | null;
}): number | null {
  if (typeof row.senderTimestamp === 'number' && row.senderTimestamp > 0) {
    return row.senderTimestamp;
  }
  if (
    !row.id.startsWith('sent-') &&
    Number.isFinite(row.timestamp) &&
    row.timestamp > 0 &&
    row.timestamp % 1000 === 0
  ) {
    return row.timestamp / 1000;
  }
  return null;
}

/** `Name: body` as it went on air, rebuilt from a split pair. No name: the body alone. */
export function meshcoreWireChannelText(senderName: string | null | undefined, body: string): string {
  return senderName ? `${senderName}: ${body}` : body;
}

/** MC1 hash of a received channel message. `wireText` is the full "Name: body". */
export function mc1HashForChannelWire(wireText: string, sec: number | null): string | null {
  if (sec === null) return null;
  return mc1ReactionHash(mc1ChannelBody(wireText), sec);
}

/** MC1 hash of OUR channel send. `text` has no name prefix; spaces and tabs are trimmed. */
export function mc1HashForOwnChannelText(text: string, sec: number | null): string | null {
  if (sec === null) return null;
  return mc1ReactionHash(mc1ChannelBody(':' + text), sec);
}

/** MC1 hash of a DM, either direction. Text verbatim. */
export function mc1HashForDm(text: string, sec: number | null): string | null {
  if (sec === null) return null;
  return mc1ReactionHash(text, sec);
}

/** Dedupe and grouping key for an emoji: strip U+FE0F, so a heart with and without VS16 is one reaction. */
export function foldReactionEmoji(emoji: string): string {
  return emoji.replace(/️/g, '');
}

/** The single place the outbound default lives. Flip here. */
export const MESHCORE_REACTIONS_OUTBOUND_DEFAULT: boolean = true;

/** true/'true'/'1' -> on; false/'false'/'0' -> off; anything else -> the default. */
export function resolveReactionsOutbound(value: unknown): boolean {
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return MESHCORE_REACTIONS_OUTBOUND_DEFAULT;
}

export interface ReactionCandidate {
  id: string;
  fromPublicKey: string;
  toPublicKey?: string | null;
  fromName?: string | null;
  text: string;
  timestamp: number;
  senderTimestamp?: number | null;
  mc1Hash?: string | null;
}

export interface ReactionMatchContext {
  scope: 'channel' | 'dm';
  /** Local node name, when the source has one. */
  selfName?: string | null;
  /** Local node public key. */
  selfKey?: string | null;
}

function isOwnRow(c: ReactionCandidate, ctx: ReactionMatchContext): boolean {
  return c.fromPublicKey === 'local' || (!!ctx.selfKey && c.fromPublicKey === ctx.selfKey);
}

/**
 * The MC1 hash of a stored row: the stored value, else rebuilt from the stored
 * fields. The sender (outbound reactions) and the matcher share this one rule.
 */
export function storedMc1Hash(
  c: Pick<ReactionCandidate, 'id' | 'text' | 'timestamp' | 'senderTimestamp' | 'mc1Hash'>,
  scope: 'channel' | 'dm',
): string | null {
  if (c.mc1Hash) return c.mc1Hash;
  const sec = storedWireSecond(c);
  if (sec === null) return null;
  return scope === 'channel' ? mc1HashForOwnChannelText(c.text, sec) : mc1HashForDm(c.text, sec);
}

/**
 * True when `c` is the message `r` points at. Does not check the
 * conversation; the caller scopes the rows.
 */
export function candidateMatchesReaction(
  r: MeshCoreReaction,
  c: ReactionCandidate,
  ctx: ReactionMatchContext,
): boolean {
  switch (r.format) {
    case 'mc1-channel':
    case 'mc1-channel-legacy': {
      if (storedMc1Hash(c, ctx.scope) !== r.hash) return false;
      const name = c.fromName ?? '';
      if (name === r.targetSender || name === r.targetSender.trim()) return true;
      return isOwnRow(c, ctx) && !!ctx.selfName && r.targetSender === ctx.selfName;
    }
    case 'mc1-dm':
      return storedMc1Hash(c, ctx.scope) === r.hash;
    case 'mco-v3': {
      const sec = storedWireSecond(c);
      if (sec === null) return false;
      const name = ctx.scope === 'channel' ? (c.fromName ?? '') : null;
      return meshcoreOpenV3Hash(sec, name, c.text) === r.hash;
    }
    case 'mco-v1': {
      const sec = storedWireSecond(c);
      if (sec === null) return false;
      if (r.senderNameHash !== null) {
        return (
          r.timestampMs === sec * 1000 &&
          dartStringHash(c.fromName ?? '') === r.senderNameHash &&
          dartStringHash(c.text) === r.textHash
        );
      }
      if (r.senderKeyPrefix === null || Math.floor(r.timestampMs / 1000) !== sec) return false;
      const key = isOwnRow(c, ctx) ? (ctx.selfKey ?? '') : c.fromPublicKey;
      return key.toLowerCase().startsWith(r.senderKeyPrefix);
    }
  }
}

/** The key a pending (unmatched) reaction waits under: `mc1:<h>`, `mco:<h>` or `v1:<ms>`. */
export function pendingKeyOfReaction(r: { reactionFormat: string; reactionTargetHash: string }): string {
  if (r.reactionFormat === 'mco-v3') return 'mco:' + r.reactionTargetHash;
  if (r.reactionFormat === 'mco-v1') return 'v1:' + r.reactionTargetHash;
  return 'mc1:' + r.reactionTargetHash;
}

/** The keys a new message offers. Same strings as `pendingKeyOfReaction`. */
export function pendingKeysOfMessage(c: ReactionCandidate, ctx: ReactionMatchContext): string[] {
  const keys: string[] = [];
  if (c.mc1Hash) keys.push('mc1:' + c.mc1Hash);
  const sec = storedWireSecond(c);
  if (sec !== null) {
    const v3 = meshcoreOpenV3Hash(sec, ctx.scope === 'channel' ? (c.fromName ?? '') : null, c.text);
    if (v3 !== null) keys.push('mco:' + v3);
    keys.push('v1:' + sec * 1000);
  }
  return keys;
}

export type ReactionTargetBlocker =
  | 'TARGET_IS_REACTION'
  | 'TARGET_IS_ROOM_POST'
  | 'TARGET_NOT_REACTABLE'
  | 'TARGET_NO_HASH';

export interface ReactionTargetRow {
  id: string;
  text: string;
  timestamp: number;
  fromPublicKey: string;
  toPublicKey?: string | null;
  fromName?: string | null;
  senderTimestamp?: number | null;
  mc1Hash?: string | null;
  messageType?: string | null;
  reactionEmoji?: string | null;
  keyFingerprint?: string | null;
}

/**
 * Why a row cannot take an outbound reaction, or null when it can. Shared by
 * the server (authority) and the client (hides the button). Checks in order.
 */
export function reactionTargetBlocker(
  row: ReactionTargetRow,
  ctx: { scope: 'channel' | 'dm'; selfKey?: string | null; selfName?: string | null },
): ReactionTargetBlocker | null {
  if (row.reactionEmoji || parseMeshCoreReaction(row.text, ctx.scope) !== null) return 'TARGET_IS_REACTION';
  if (row.messageType === 'room_post') return 'TARGET_IS_ROOM_POST';
  if (row.keyFingerprint) return 'TARGET_NOT_REACTABLE';
  if (ctx.scope === 'channel') {
    const own = row.fromPublicKey === 'local' || (!!ctx.selfKey && row.fromPublicKey === ctx.selfKey);
    const sender = row.fromName || (own ? ctx.selfName : null);
    if (!sender || sender.includes(']') || sender.includes('\n')) return 'TARGET_NOT_REACTABLE';
  }
  if (storedMc1Hash(row, ctx.scope) === null) return 'TARGET_NO_HASH';
  return null;
}
