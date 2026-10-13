/**
 * Prefix → contact matching for MeshCore public keys (#5349).
 *
 * Inbound MeshCore frames often carry only a public-key PREFIX (6 bytes for
 * DMs, 1-3 bytes for route hops), while contacts are keyed by the full 32-byte
 * key. Matching must never silently pick the first of several contacts that
 * share a prefix: that attributes a message, name, or reply to the wrong node.
 *
 * `uniquePrefixMatch` returns the exact-key hit if there is one, otherwise the
 * single contact whose key starts with `key`, otherwise `undefined` (no match
 * OR ambiguous).
 */
export function uniquePrefixMatch<T extends { publicKey?: string | null }>(
  contacts: ReadonlyArray<T>,
  key: string | null | undefined,
): T | undefined {
  // startsWith('') is true for every key, so an empty key matches nothing.
  if (!key) return undefined;
  const needle = key.toLowerCase();
  let found: T | undefined;
  let count = 0;
  for (const c of contacts) {
    const pk = c.publicKey;
    if (!pk) continue;
    const lower = pk.toLowerCase();
    if (lower === needle) return c;
    if (lower.startsWith(needle)) {
      count++;
      found = c;
    }
  }
  return count === 1 ? found : undefined;
}

/**
 * `fromPublicKey` of a room post whose author could not be read (#5774).
 * Not a key: never a DM target, shown as an unknown sender.
 */
export const UNKNOWN_ROOM_AUTHOR = 'unknown';

/**
 * Rows stored before #5774 hold a room-post author prefix that went through a
 * UTF-8 decode: each byte >= 0x80 became U+FFFD and was written as the four
 * hex chars `fffd`; bytes < 0x80 stayed as two hex chars. This reads such a
 * string back into one entry per byte: the byte value when it survived, `null`
 * when it was lost. Returns null when `key` is not that shape (a clean 8-char
 * prefix, a full key, 'unknown', a non-hex string, wrong byte count).
 */
export function parseCorruptedAuthorPrefix(key: string | null | undefined): Array<number | null> | null {
  if (!key || !/^[0-9a-f]+$/i.test(key)) return null;
  const lower = key.toLowerCase();
  const out: Array<number | null> = [];
  let i = 0;
  while (i < lower.length && out.length <= 4) {
    if (lower.startsWith('fffd', i)) {
      out.push(null);
      i += 4;
    } else {
      const byte = parseInt(lower.substring(i, i + 2), 16);
      // An intact byte is always < 0x80 (higher ones were lost).
      if (i + 2 > lower.length || Number.isNaN(byte) || byte >= 0x80) return null;
      out.push(byte);
      i += 2;
    }
  }
  if (i !== lower.length || out.length !== 4 || !out.includes(null)) return null;
  return out;
}

/**
 * True when `key` can name a node: hex, not the unknown marker, and not a
 * corrupted pre-#5774 author prefix. Gate "open this sender / DM them" on it.
 */
export function isUsableSenderKey(key: string | null | undefined): boolean {
  if (!key || key === UNKNOWN_ROOM_AUTHOR) return false;
  if (!/^[0-9a-f]+$/i.test(key)) return false;
  return parseCorruptedAuthorPrefix(key) === null;
}

/**
 * Like `uniquePrefixMatch`, but a corrupted author prefix is matched by its
 * surviving bytes. Needs at least two surviving bytes (16 known bits) and
 * exactly one fitting contact; otherwise it is `undefined` (unknown sender),
 * since a wrong name is worse than none.
 */
export function resolveAuthorContact<T extends { publicKey?: string | null }>(
  contacts: ReadonlyArray<T>,
  key: string | null | undefined,
): T | undefined {
  const pattern = parseCorruptedAuthorPrefix(key);
  if (!pattern) return uniquePrefixMatch(contacts, key);
  if (pattern.filter((b) => b !== null).length < 2) return undefined;
  let found: T | undefined;
  let count = 0;
  for (const c of contacts) {
    const pk = c.publicKey?.toLowerCase();
    if (!pk || pk.length < 8 || !/^[0-9a-f]+$/.test(pk.substring(0, 8))) continue;
    const fits = pattern.every((b, idx) => b === null
      ? parseInt(pk.substring(idx * 2, idx * 2 + 2), 16) >= 0x80
      : parseInt(pk.substring(idx * 2, idx * 2 + 2), 16) === b);
    if (fits) {
      count++;
      found = c;
    }
  }
  return count === 1 ? found : undefined;
}
