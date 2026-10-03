/**
 * Byte-budgeted text splitting for radio sends (#5564).
 *
 * A mesh text payload is capped in UTF-8 BYTES, so a reply is measured and cut
 * in bytes, never in JS string length. Every cut lands on a character
 * boundary: a multi-byte character is never halved, and a multi-code-point
 * character (a flag, a ZWJ emoji, a letter with combining marks) stays whole
 * unless it alone is larger than the whole budget.
 *
 * Pure: no IO, no timers. The caller owns the sends and the wait between them.
 */

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Smallest body budget that can hold any single code point. */
const MIN_BODY_BYTES = 4;

export function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * The longest prefix of `s` whose UTF-8 encoding fits in `maxBytes`, cut on a
 * character boundary. Returns `s` unchanged when it already fits.
 */
export function truncateUtf8Bytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8ByteLength(s) <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const { segment } of graphemes.segment(s)) {
    const segmentBytes = utf8ByteLength(segment);
    if (bytes + segmentBytes > maxBytes) {
      if (out === '') {
        // One character larger than the whole budget: cut it by code point
        // so the result is still valid UTF-8 and the caller makes progress.
        for (const codePoint of segment) {
          const codePointBytes = utf8ByteLength(codePoint);
          if (bytes + codePointBytes > maxBytes) break;
          out += codePoint;
          bytes += codePointBytes;
        }
      }
      break;
    }
    out += segment;
    bytes += segmentBytes;
  }
  return out;
}

/** The part marker put in front of each part of a split message. */
export function partMarker(index: number, total: number): string {
  return `(${index}/${total}) `;
}

/**
 * Where to cut `window` (the longest prefix that fits), as a string index.
 * Prefers, in order: a line break, a sentence end, other punctuation, a space,
 * a hyphen. A break point only counts if it leaves the part reasonably full,
 * so one early comma cannot produce a near-empty part. Falls back to the whole
 * window (a hard cut on a character boundary).
 */
function findBreakIndex(window: string, nextChar: string | undefined): number {
  // The window already ends on a word boundary.
  if (nextChar !== undefined && /\s/.test(nextChar)) return window.length;

  const half = window.length * 0.5;
  const third = window.length * 0.3;
  const lastOf = (tokens: string[]): number => {
    let best = -1;
    for (const token of tokens) {
      const at = window.lastIndexOf(token);
      if (at !== -1 && at + token.length > best) best = at + token.length;
    }
    return best;
  };

  const newline = lastOf(['\n']);
  if (newline > half) return newline;
  const sentence = lastOf(['. ', '! ', '? ']);
  if (sentence > half) return sentence;
  const punctuation = lastOf([', ', '; ', ': ', ' - ']);
  if (punctuation > half) return punctuation;
  const space = lastOf([' ']);
  if (space > third) return space;
  const hyphen = lastOf(['-']);
  if (hyphen > third) return hyphen;
  return window.length;
}

export interface SplitUtf8Options {
  /** Byte cap for ONE send, marker included. */
  maxBytes: number;
  /** Most parts to produce. 1 means "truncate, never split". */
  maxParts: number;
}

export interface SplitUtf8Result {
  /** The texts to send, in order. Each fits in `maxBytes`. */
  parts: string[];
  /** True when some of the input did not fit and was dropped. */
  truncated: boolean;
}

/**
 * Split `text` into at most `maxParts` sends of at most `maxBytes` each.
 *
 * - Text that fits in one send comes back unchanged, with no marker.
 * - Otherwise each part gets a `(1/3) ` style marker. The marker is counted in
 *   the byte budget, and its size is reserved for the worst case (`maxParts`)
 *   up front, so the total is known before the first part is cut.
 * - The last allowed part is truncated to fit; `truncated` reports the loss.
 * - With `maxParts` 1 (or a budget too small for a marker) the text is
 *   truncated to `maxBytes` and sent as one part with no marker.
 */
export function splitUtf8Message(text: string, options: SplitUtf8Options): SplitUtf8Result {
  const { maxBytes } = options;
  if (utf8ByteLength(text) <= maxBytes) return { parts: [text], truncated: false };

  const maxParts = Math.max(1, Math.floor(options.maxParts) || 1);
  const bodyBudget = maxBytes - utf8ByteLength(partMarker(maxParts, maxParts));
  if (maxParts === 1 || bodyBudget < MIN_BODY_BYTES) {
    return { parts: [truncateUtf8Bytes(text, maxBytes)], truncated: true };
  }

  const bodies: string[] = [];
  let truncated = false;
  let remaining = text;
  while (remaining.length > 0) {
    if (utf8ByteLength(remaining) <= bodyBudget) {
      const tail = remaining.trimEnd();
      if (tail) bodies.push(tail);
      break;
    }
    const window = truncateUtf8Bytes(remaining, bodyBudget);
    if (window === '') break; // cannot happen with bodyBudget >= 4; guards the loop
    if (bodies.length === maxParts - 1) {
      // Last allowed part: keep as much as fits and drop the rest.
      const last = window.trimEnd();
      if (last) bodies.push(last);
      truncated = remaining.slice(window.length).trim().length > 0;
      break;
    }
    const cut = findBreakIndex(window, remaining[window.length]);
    const body = remaining.slice(0, cut).trimEnd();
    if (body) bodies.push(body);
    remaining = remaining.slice(cut).trimStart();
  }

  if (bodies.length === 0) return { parts: [truncateUtf8Bytes(text, maxBytes)], truncated: true };
  // Only whitespace overflowed: one part, sent bare.
  if (bodies.length === 1) return { parts: bodies, truncated };
  return {
    parts: bodies.map((body, i) => partMarker(i + 1, bodies.length) + body),
    truncated,
  };
}
