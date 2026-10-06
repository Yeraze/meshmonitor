/**
 * Limits and helpers for the Meshtastic Status Message module
 * (`ModuleConfig.StatusMessageConfig.node_status`, firmware 2.7.20+).
 *
 * Shared by the browser (the header quick-status pill and both config forms)
 * and the server (route validation), so every surface agrees on one limit.
 */

/**
 * Longest `node_status` the firmware accepts, in UTF-8 BYTES.
 *
 * `protobufs/meshtastic/module_config.options` declares
 * `*StatusMessageConfig.node_status max_size:80`. nanopb's `max_size` is the
 * size of the C buffer (`char node_status[80]`), and that buffer holds the NUL
 * terminator, so 79 bytes of text fit. An 80-byte string fails nanopb's decode
 * ("string overflow"); the node then drops the whole admin message with no
 * error, and the status never saves.
 *
 * Bytes, not characters: one emoji is 4 bytes or more, so a character count
 * lets a status with emoji overflow the buffer.
 */
export const NODE_STATUS_MAX_BYTES = 79;

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Split text into user-perceived characters, so a flag, a skin-tone emoji or a
 * ZWJ family stays one unit. Falls back to code points where `Intl.Segmenter`
 * is missing: that can split a ZWJ sequence between its parts, but never
 * inside one code point.
 */
const graphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

export function splitGraphemes(text: string): string[] {
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), part => part.segment);
  }
  return Array.from(text);
}

/** A keycap: digit, `#` or `*`, an optional variation selector, then U+20E3. */
const KEYCAP = /^[0-9#*]\uFE0F?\u20E3$/u;
/** A flag: exactly two regional indicators. One alone is half a flag. */
const FLAG = /^\p{Regional_Indicator}{2}$/u;
const STARTS_WITH_REGIONAL_INDICATOR = /^\p{Regional_Indicator}/u;
/**
 * A grapheme that draws as an emoji: it starts with a code point that is an
 * emoji by default, or with a pictograph forced to emoji style by U+FE0F, or
 * with a base that carries a skin tone.
 *
 * `\p{Emoji}` is not used: it matches the digits, `#` and `*` (keycap bases),
 * so "1-800" would pass. `\p{Extended_Pictographic}` alone is not used either:
 * it misses flags, and it matches text symbols such as (c) and (tm) that draw
 * as plain glyphs unless U+FE0F follows.
 */
const STARTS_AS_EMOJI = /^(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\p{Emoji_Modifier_Base}\p{Emoji_Modifier})/u;

function isEmojiGrapheme(grapheme: string): boolean {
  if (KEYCAP.test(grapheme)) return true;
  if (STARTS_WITH_REGIONAL_INDICATOR.test(grapheme)) return FLAG.test(grapheme);
  return STARTS_AS_EMOJI.test(grapheme);
}

/**
 * `getLeadingEmoji` with the segmenter passed in, so tests can cover a runtime
 * that has no `Intl.Segmenter`.
 *
 * Without a segmenter there is no safe way to find where the first grapheme
 * ends: a code-point split would cut a flag or a ZWJ family in half and show a
 * broken glyph. So that runtime gets no badge at all.
 */
export function leadingEmojiWith(
  status: string | null | undefined,
  segmenter: Intl.Segmenter | null,
): string | null {
  if (!status || !segmenter) return null;
  const first = segmenter.segment(status)[Symbol.iterator]().next();
  if (first.done) return null;
  const grapheme = first.value.segment;
  return isEmojiGrapheme(grapheme) ? grapheme : null;
}

/**
 * The first grapheme of a status message when it is an emoji, else null
 * (#5645). The rule is literal: leading whitespace, a letter, a digit or
 * punctuation all mean "no emoji", with no trimming or searching ahead.
 *
 * A flag, a ZWJ family, a skin-tone emoji and a keycap each come back whole.
 * The result is text for React to render: never parse it as HTML.
 */
export function getLeadingEmoji(status: string | null | undefined): string | null {
  return leadingEmojiWith(status, graphemeSegmenter);
}

/**
 * Cut text to at most `maxBytes` UTF-8 bytes without splitting a character.
 * Drops whole graphemes from the end, so an emoji is kept or removed entire.
 */
export function truncateToUtf8Bytes(text: string, maxBytes: number = NODE_STATUS_MAX_BYTES): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  let result = '';
  let used = 0;
  for (const grapheme of splitGraphemes(text)) {
    const size = utf8ByteLength(grapheme);
    if (used + size > maxBytes) break;
    result += grapheme;
    used += size;
  }
  return result;
}

/**
 * Validate a `statusmessage` module-config payload. Returns an error message,
 * or null when the payload is acceptable. An absent `nodeStatus` is left to the
 * caller: the protobuf builder treats it as an empty status.
 */
export function validateStatusMessageConfigPayload(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const nodeStatus = (config as Record<string, unknown>).nodeStatus;
  if (nodeStatus === undefined || nodeStatus === null) return null;
  if (typeof nodeStatus !== 'string') {
    return 'nodeStatus must be a string';
  }
  if (utf8ByteLength(nodeStatus) > NODE_STATUS_MAX_BYTES) {
    return `nodeStatus exceeds ${NODE_STATUS_MAX_BYTES} bytes (firmware limit)`;
  }
  return null;
}
