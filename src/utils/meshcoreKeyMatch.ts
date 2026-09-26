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
