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
 * Returns the secret as a lowercase hex string (32 chars).
 */
export async function deriveHashtagSecretHex(name: string): Promise<string> {
  const normalized = name.trim().startsWith('#') ? name.trim() : `#${name.trim()}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  const full = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < MESHCORE_SECRET_BYTES; i++) hex += full[i].toString(16).padStart(2, '0');
  return hex;
}
