import type { MeshCoreMapNode } from '../contexts/MapContext';

// Small offset to prevent exact overlap on map when local node is at same location as contacts
export const LOCAL_NODE_OFFSET = 0.0005; // ~55m

export interface MeshCoreContact {
  publicKey: string;
  advName?: string;
  name?: string;
  lastSeen?: number;
  rssi?: number;
  snr?: number;
  advType?: number;
  latitude?: number;
  longitude?: number;
  lastAdvert?: number;
  /** Hop count of the cached forwarding route. `null` / undefined = unknown
   *  (next send floods). */
  pathLen?: number | null;
  /** Comma-separated hex chain of hop hashes, e.g. "a3,7f,02". `null` /
   *  undefined = OUT_PATH_UNKNOWN. */
  outPath?: string | null;
}

/**
 * Transform MeshCore contacts into map node objects.
 * Filters to only contacts with valid coordinates and applies
 * a small offset for the local node to prevent marker overlap.
 */
export function mapContactsToNodes(contacts: MeshCoreContact[]): MeshCoreMapNode[] {
  if (!Array.isArray(contacts)) return [];
  return contacts
    .filter(c => c.publicKey && typeof c.latitude === 'number' && isFinite(c.latitude)
      && typeof c.longitude === 'number' && isFinite(c.longitude))
    .map(c => {
      const isLocalNode = c.advName?.includes('(local)');
      return {
        publicKey: String(c.publicKey),
        name: c.advName || c.name || 'Unknown',
        latitude: c.latitude! + (isLocalNode ? LOCAL_NODE_OFFSET : 0),
        longitude: c.longitude! + (isLocalNode ? LOCAL_NODE_OFFSET : 0),
        rssi: typeof c.rssi === 'number' ? c.rssi : undefined,
        snr: typeof c.snr === 'number' ? c.snr : undefined,
        lastSeen: c.lastSeen,
        advType: c.advType,
      };
    });
}

// --- MeshCore channels -----------------------------------------------------

/** Number of bytes in a MeshCore channel secret (AES-128). */
export const MESHCORE_SECRET_BYTES = 16;

/**
 * A MeshCore "hashtag channel" is a public topic channel (`#general`, `#test`)
 * whose secret is deterministically derived from its name, so anyone using the
 * same `#name` shares the key with no key exchange. MeshCore classifies a
 * channel as a hashtag channel precisely when its name starts with `#`.
 */
export function isHashtagChannelName(name: string | null | undefined): boolean {
  return (name ?? '').trim().startsWith('#');
}

// --- SHA-256 fallback (FIPS 180-4) -----------------------------------------
//
// `crypto.subtle` is only available in secure contexts (HTTPS or localhost).
// When MeshMonitor is served over plain HTTP via an IP address — the typical
// Docker-on-a-separate-host deployment — `crypto.subtle` is undefined and
// calling `.digest()` on it throws a TypeError that the caller catches and
// silently discards, leaving the random seed in place (issue #3606).
//
// This fallback is used automatically when `crypto.subtle` is unavailable so
// that hashtag channel key derivation works in ALL deployment contexts.

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Pure-JS SHA-256. Exported for direct testing of the non-secure-context path. */
export function sha256PureJS(data: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const bitLen = data.length * 8;
  const paddedLen = Math.ceil((data.length + 9) / 64) * 64;
  const msg = new Uint8Array(paddedLen);
  msg.set(data);
  msg[data.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const W = new Uint32Array(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(W[i - 15], 7) ^ rotr32(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr32(W[i - 2], 17) ^ rotr32(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const result = new Uint8Array(32);
  const rv = new DataView(result.buffer);
  rv.setUint32(0, h0, false); rv.setUint32(4, h1, false);
  rv.setUint32(8, h2, false); rv.setUint32(12, h3, false);
  rv.setUint32(16, h4, false); rv.setUint32(20, h5, false);
  rv.setUint32(24, h6, false); rv.setUint32(28, h7, false);
  return result;
}

/**
 * Format a MeshCore channel name for display.
 *
 * Names are shown with a leading `# ` as a decorative convention. Hashtag
 * channels already store the `#` as part of the name (e.g. `#general`), so we
 * must NOT prepend another one or they render as `# #general`. Empty names fall
 * back to the supplied label (e.g. "Channel 0").
 */
export function formatMeshCoreChannelName(name: string | null | undefined, fallback: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return `# ${fallback}`;
  if (trimmed.startsWith('#')) return trimmed;
  return `# ${trimmed}`;
}

/**
 * Derive the 16-byte AES-128 secret for a MeshCore hashtag channel.
 *
 * Matches the official MeshCore app: `SHA-256("#" + room)[0:16]`, where the
 * literal name string — INCLUDING the leading `#` — is hashed verbatim (the
 * derivation is case-sensitive). Pass the channel name exactly as it will be
 * stored (`#general`); a missing leading `#` is added before hashing.
 *
 * Uses `crypto.subtle` when available (secure context: HTTPS or localhost);
 * falls back to the pure-JS SHA-256 implementation for plain-HTTP deployments
 * where `crypto.subtle` is undefined.
 *
 * Returns the secret as a lowercase hex string (32 chars).
 */
export async function deriveHashtagSecretHex(name: string): Promise<string> {
  const normalized = name.trim().startsWith('#') ? name.trim() : `#${name.trim()}`;
  const encoded = new TextEncoder().encode(normalized);
  let full: Uint8Array;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    full = new Uint8Array(digest);
  } else {
    full = sha256PureJS(encoded);
  }
  let hex = '';
  for (let i = 0; i < MESHCORE_SECRET_BYTES; i++) hex += full[i].toString(16).padStart(2, '0');
  return hex;
}
