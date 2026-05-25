/**
 * Helpers for importing channel configurations decoded from a Meshtastic
 * channel URL (`https://meshtastic.org/e/#<base64>`) into the Channel
 * Database.
 *
 * The server's `channelUrlService.decodeUrl` returns each channel's PSK in
 * one of several forms — see `DecodedChannelSettings.psk`:
 *   - `"none"`            — no-crypto channel (shorthand 0)
 *   - `"default"`         — Meshtastic default key (shorthand 1)
 *   - `"simple1"`–`"simple9"` — default key + N (shorthand 2–10)
 *   - any base64 string   — a real 16- or 32-byte AES key
 *
 * Channel Database rows store the PSK as a base64 string + an explicit
 * `pskLength` byte count. The decryption service (`expandShorthandPsk`)
 * already understands 1-byte shorthand values, so we keep shorthand keys
 * intact rather than expanding them client-side — this matches what the
 * MQTT default-channel bootstrap inserts for `AQ==`.
 *
 * A return of `null` signals "skip this channel" — i.e. the input was a
 * no-crypto channel or an unparseable value that has no place in the
 * decryption-key store.
 */

/**
 * Browser-safe base64 byte count via `atob`. `atob` decodes a base64
 * string into a binary string whose `.length` is the byte count. Returns
 * 0 on invalid input rather than throwing so callers can treat unparseable
 * PSKs as "no key" without try/catch boilerplate.
 *
 * Note: the implementation deliberately avoids `Buffer` — the helper is
 * imported by `ChannelDatabaseSection.tsx` which ships to the browser
 * bundle where `Buffer` is undefined (issue #3187 follow-up). `atob` is
 * available in Node 16+ and every supported browser.
 */
function safeBase64ByteLength(base64: string): number {
  try {
    return atob(base64).length;
  } catch {
    return 0;
  }
}

/**
 * Browser-safe base64 encode of a single byte value. Used to convert
 * Meshtastic shorthand PSKs (`'simple1'`..`'simple9'`) back to their
 * 1-byte representation.
 */
function byteToBase64(byteValue: number): string {
  return btoa(String.fromCharCode(byteValue));
}

/**
 * Convert the PSK form produced by `channelUrlService.decodeUrl` into a
 * Channel Database-compatible base64 string. Returns `null` for inputs
 * that don't correspond to a stored key (no-crypto, empty, malformed).
 */
export function normalizeChannelUrlPskToBase64(psk: string | undefined | null): string | null {
  if (psk == null || psk === '') return null;
  if (psk === 'none') return null;
  if (psk === 'default') {
    // 1-byte shorthand for value 1 — base64 of `[0x01]`.
    return 'AQ==';
  }
  const simpleMatch = /^simple([1-9])$/.exec(psk);
  if (simpleMatch) {
    // simpleN encodes the byte (N+1), i.e. simple1 → 0x02, simple9 → 0x0a.
    return byteToBase64(Number(simpleMatch[1]) + 1);
  }
  // Otherwise treat as a raw base64 key — validate by round-trip decode.
  return safeBase64ByteLength(psk) > 0 ? psk : null;
}

/**
 * Returns the byte length of a base64-encoded PSK. Used by the import
 * flow to set the explicit `pskLength` column on the Channel Database
 * row. Returns `0` for empty/invalid input.
 */
export function getPskBase64ByteLength(base64: string | null | undefined): number {
  if (!base64) return 0;
  return safeBase64ByteLength(base64);
}
