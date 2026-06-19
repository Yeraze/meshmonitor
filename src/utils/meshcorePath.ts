import type { MeshCoreContact } from './meshcoreHelpers';

/**
 * Helpers for composing a MeshCore contact forwarding path ("out_path") from
 * named repeaters instead of raw hex.
 *
 * A MeshCore out_path is an ordered list of 1-byte routing hashes — each hop is
 * the **first byte of that repeater's public key** (the default 1-byte path
 * hash width). The companion API stores/accepts the path as a comma-separated
 * hex chain (e.g. "a3,7f,02"); these helpers convert between that wire form and
 * a name-aware UI.
 */

/** A single forwarding hop as a normalized 2-char lowercase hex byte. */
export type PathHop = string;

/** Parse a stored out_path ("a3,7f,02") into normalized hop bytes. */
export function parsePathHops(outPath: string | null | undefined): PathHop[] {
  if (!outPath) return [];
  return outPath
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{1,2}$/.test(s))
    .map((s) => s.padStart(2, '0'));
}

/** Join hop bytes back into the comma-separated chain the API expects. */
export function joinPathHops(hops: PathHop[]): string {
  return hops.join(',');
}

/**
 * The routing hop byte for a node = the first byte of its public key.
 *
 * NOTE: assumes the **1-byte path hash width**, which is MeshCore's default and
 * the only width this name-picker supports. The firmware can negotiate 2- or
 * 3-byte hashes (`outPathLenRaw >> 6` on the wire); on such a network the mapped
 * byte would be wrong. 1-byte is overwhelmingly the norm, so we scope to it here
 * rather than plumb hash-width through the UI — revisit if multi-byte hashes
 * become common.
 */
export function hopByteForKey(publicKey: string): PathHop {
  return publicKey.slice(0, 2).toLowerCase();
}

export interface RepeaterOption {
  publicKey: string;
  name: string;
  hopByte: PathHop;
}

/**
 * Candidate hops for the path picker: repeaters (advType 2) and room servers
 * (advType 3) — the relay infrastructure a path traverses — with display names
 * and their hop byte, sorted by name.
 */
export function repeaterHopOptions(contacts: MeshCoreContact[]): RepeaterOption[] {
  return contacts
    .filter((c) => c.advType === 2 || c.advType === 3)
    .map((c) => ({
      publicKey: c.publicKey,
      name: c.advName || c.name || `${c.publicKey.slice(0, 8)}…`,
      hopByte: hopByteForKey(c.publicKey),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ResolvedHop {
  byte: PathHop;
  /** Repeaters whose key starts with this byte (0, 1, or many — 1-byte hashes collide). */
  matches: RepeaterOption[];
  /** Human label: the repeater name, "name (+N)" on collision, or "Unknown (0xAB)". */
  label: string;
}

/** Resolve a hop byte to a human label using the known-repeater list. */
export function resolveHop(byte: PathHop, options: RepeaterOption[]): ResolvedHop {
  const matches = options.filter((o) => o.hopByte === byte);
  let label: string;
  if (matches.length === 1) label = matches[0].name;
  else if (matches.length > 1) label = `${matches[0].name} (+${matches.length - 1})`;
  else label = `Unknown (0x${byte})`;
  return { byte, matches, label };
}
