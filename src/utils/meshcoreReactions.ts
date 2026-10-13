/**
 * MeshCore reaction codec: parse, build and hash the reaction texts that
 * MeshCore One (MC1) and meshcore-open send as plain chat messages.
 *
 * Written from the format description in
 * docs/internal/dev-notes/MESHCORE_REACTIONS_EPIC.md and the Phase 1 spec.
 * - MC1 (Avi0n/MeshCoreOne) is GPL-3.0. Its source must NOT be read or copied
 *   here. Only its observable behaviour (input -> output) is used.
 * - meshcore-open (zjs81) is MIT. Only its emoji table is vendored, in
 *   meshcoreOpenEmojiTable.ts. The hash and parsers below are written fresh.
 *
 * Pure functions. No I/O, no clock, no wiring: nothing imports this yet.
 */

import { sha256PureJS } from './meshcoreHelpers.js';
import { splitGraphemes } from './statusMessage.js';
import { MESHCORE_OPEN_REACTION_EMOJIS } from './meshcoreOpenEmojiTable.js';

/** Bump when what we SEND changes. Phase 1 value: 1 (MC1 >= 1.4.1 formats). */
export const MC_REACTION_FORMAT_VERSION = 1;

export type MeshCoreReactionScope = 'channel' | 'dm';

export interface Mc1ChannelReaction {
  format: 'mc1-channel' | 'mc1-channel-legacy';
  emoji: string;
  /** Verbatim text between `@[` and `]`. Never trimmed, never case-folded. */
  targetSender: string;
  /** 8 chars, normalized (lowercase, o->0, i/l->1). */
  hash: string;
}

export interface Mc1DmReaction {
  format: 'mc1-dm';
  emoji: string;
  hash: string;
}

export interface MeshCoreOpenV3Reaction {
  format: 'mco-v3';
  /** Table entry at `emojiIndex`. */
  emoji: string;
  /** 0..183 */
  emojiIndex: number;
  /** 4 lowercase hex. */
  hash: string;
}

export interface MeshCoreOpenV1Reaction {
  format: 'mco-v1';
  emoji: string;
  timestampMs: number;
  /** Channel shape only; else null. */
  senderNameHash: number | null;
  textHash: number | null;
  /** DM shape only: 8 lowercase hex, first 4 bytes of the target sender's key. */
  senderKeyPrefix: string | null;
}

export type MeshCoreOpenReaction = MeshCoreOpenV3Reaction | MeshCoreOpenV1Reaction;
export type MeshCoreReaction = Mc1ChannelReaction | Mc1DmReaction | MeshCoreOpenReaction;
export type MeshCoreReactionFormat = MeshCoreReaction['format'];

// Crockford-style base32 alphabet (no i, l, o, u).
const MC1_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const MC1_HASH_INPUT = /^[0-9A-TV-Za-tv-z]{8}$/;
const EMOJI_START = /^\p{Emoji}/u;

const V3_RE = /^r:([0-9a-f]{4}):([0-9a-f]{2})$/;
const V1_CHANNEL_RE = /^r:(\d{1,15})_(\d{1,10})_(\d{1,10}):(.+)$/;
const V1_DM_RE = /^r:(\d{1,15})_([0-9a-f]{8}):(.+)$/;

/**
 * One grapheme whose first code point is an emoji. A bare text symbol such
 * as (c) or the watch needs a trailing VS16 or ZWJ part to count.
 */
export function isReactionEmoji(value: string): boolean {
  if (value.length === 0) return false;
  if (splitGraphemes(value).length !== 1) return false;
  if (!EMOJI_START.test(value)) return false;
  const cp = value.codePointAt(0) as number;
  if (cp > 0x238c) return true;
  return value.length > (cp > 0xffff ? 2 : 1);
}

/** Fold an MC1 hash to canonical form, or null if it is not 8 valid chars. */
export function normalizeMc1ReactionHash(value: string): string | null {
  if (!MC1_HASH_INPUT.test(value)) return null;
  return value.toLowerCase().replace(/o/g, '0').replace(/[il]/g, '1');
}

/**
 * MC1 reaction hash: SHA-256 of utf8(text) + u32le(sender second), first
 * 40 bits as 8 base32 chars.
 */
export function mc1ReactionHash(text: string, senderTimestampSec: number): string | null {
  if (!Number.isInteger(senderTimestampSec) || senderTimestampSec < 0 || senderTimestampSec > 0xffffffff) {
    return null;
  }
  const textBytes = new TextEncoder().encode(text);
  const bytes = new Uint8Array(textBytes.length + 4);
  bytes.set(textBytes, 0);
  new DataView(bytes.buffer).setUint32(textBytes.length, senderTimestampSec, true);
  const digest = sha256PureJS(bytes);

  // Feed 5 bytes into a bit accumulator and emit 5 bits at a time.
  let acc = 0;
  let bits = 0;
  let out = '';
  for (let i = 0; i < 5; i++) {
    acc = (acc << 8) | digest[i];
    bits += 8;
    while (bits >= 5) {
      out += MC1_ALPHABET[(acc >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

/**
 * The text MC1 hashes for a channel message: everything after the first
 * colon, with spaces and tabs cut from both ends. Nothing else is trimmed.
 * No colon: the whole text, trimmed the same way.
 */
export function mc1ChannelBody(wireText: string): string {
  const colon = wireText.indexOf(':');
  const body = colon < 0 ? wireText : wireText.slice(colon + 1);
  return body.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Build `@[sender]emoji\nhash`. Null when any part would not round-trip. */
export function buildMc1ChannelReaction(targetSender: string, emoji: string, hash: string): string | null {
  if (targetSender.length === 0 || targetSender.includes(']') || targetSender.includes('\n')) return null;
  if (!isReactionEmoji(emoji)) return null;
  const h = normalizeMc1ReactionHash(hash);
  if (h === null) return null;
  return `@[${targetSender}]${emoji}\n${h}`;
}

/** Build `emoji\nhash`. Null when the emoji or hash is invalid. */
export function buildMc1DmReaction(emoji: string, hash: string): string | null {
  if (!isReactionEmoji(emoji)) return null;
  const h = normalizeMc1ReactionHash(hash);
  if (h === null) return null;
  return `${emoji}\n${h}`;
}

/** Split at the last newline into a head and a normalized hash. */
function splitHash(text: string): { head: string; hash: string } | null {
  const i = text.lastIndexOf('\n');
  if (i < 0) return null;
  const hash = normalizeMc1ReactionHash(text.slice(i + 1));
  if (hash === null) return null;
  return { head: text.slice(0, i), hash };
}

export function parseMc1ChannelReaction(text: string): Mc1ChannelReaction | null {
  const parts = splitHash(text);
  if (!parts) return null;
  const { head, hash } = parts;
  const at = head.indexOf('@[');
  if (at < 0) return null;

  let format: Mc1ChannelReaction['format'];
  let targetSender: string;
  let emoji: string;
  if (at === 0) {
    const close = head.indexOf(']');
    if (close < 0) return null;
    targetSender = head.slice(2, close);
    emoji = head.slice(close + 1);
    format = 'mc1-channel';
  } else {
    emoji = head.slice(0, at);
    const rest = head.slice(at + 2);
    if (!rest.endsWith(']')) return null;
    targetSender = rest.slice(0, -1);
    format = 'mc1-channel-legacy';
  }
  if (targetSender.length === 0 || !isReactionEmoji(emoji)) return null;
  return { format, emoji, targetSender, hash };
}

export function parseMc1DmReaction(text: string): Mc1DmReaction | null {
  if (text.includes('@[')) return null;
  const parts = splitHash(text);
  if (!parts || !isReactionEmoji(parts.head)) return null;
  return { format: 'mc1-dm', emoji: parts.head, hash: parts.hash };
}

/**
 * Dart VM string hash as meshcore-open uses it: one-at-a-time over UTF-16
 * code units, masked to 30 bits, 0 mapped to 1.
 */
export function dartStringHash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h + input.charCodeAt(i)) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  h = (h + (h << 15)) >>> 0;
  h &= 0x3fffffff;
  return h === 0 ? 1 : h;
}

/**
 * meshcore-open v3 hash: low 16 bits of the string hash of
 * seconds + sender name + first 5 UTF-16 units of the text, as 4 hex chars.
 * Pass a null sender for a 1:1 DM.
 */
export function meshcoreOpenV3Hash(timestampSec: number, senderName: string | null, text: string): string | null {
  if (!Number.isSafeInteger(timestampSec) || timestampSec < 0) return null;
  const input = String(timestampSec) + (senderName ?? '') + text.slice(0, 5);
  return (dartStringHash(input) & 0xffff).toString(16).padStart(4, '0');
}

function isV1Emoji(value: string): boolean {
  return MESHCORE_OPEN_REACTION_EMOJIS.includes(value) || isReactionEmoji(value);
}

export function parseMeshCoreOpenReaction(text: string): MeshCoreOpenReaction | null {
  const v3 = V3_RE.exec(text);
  if (v3) {
    const emojiIndex = parseInt(v3[2], 16);
    if (emojiIndex >= MESHCORE_OPEN_REACTION_EMOJIS.length) return null;
    return { format: 'mco-v3', emoji: MESHCORE_OPEN_REACTION_EMOJIS[emojiIndex], emojiIndex, hash: v3[1] };
  }

  const v1c = V1_CHANNEL_RE.exec(text);
  if (v1c && isV1Emoji(v1c[4])) {
    return {
      format: 'mco-v1',
      emoji: v1c[4],
      timestampMs: Number(v1c[1]),
      senderNameHash: Number(v1c[2]),
      textHash: Number(v1c[3]),
      senderKeyPrefix: null,
    };
  }

  const v1d = V1_DM_RE.exec(text);
  if (v1d && isV1Emoji(v1d[3])) {
    return {
      format: 'mco-v1',
      emoji: v1d[3],
      timestampMs: Number(v1d[1]),
      senderNameHash: null,
      textHash: null,
      senderKeyPrefix: v1d[2],
    };
  }

  return null;
}

export function parseMeshCoreReaction(text: string, scope: MeshCoreReactionScope): MeshCoreReaction | null {
  return (
    parseMeshCoreOpenReaction(text) ??
    (scope === 'channel' ? parseMc1ChannelReaction(text) : parseMc1DmReaction(text))
  );
}

/**
 * Cheap pre-check for ingest. Never false for a real reaction; a true result
 * still needs a parse.
 */
export function isReactionText(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  const n = text.length;
  if (n >= 9 && text.charCodeAt(0) === 0x72 && text.charCodeAt(1) === 0x3a) return true;
  return n >= 10 && text.charCodeAt(n - 9) === 0x0a;
}
