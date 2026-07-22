import type { MeshCoreContact } from './meshcoreHelpers';
import { calculateDistance } from './distance.js';

/**
 * Helpers for composing a MeshCore contact forwarding path ("out_path") from
 * named repeaters instead of raw hex.
 *
 * A MeshCore out_path is an ordered list of per-hop routing hashes. Each hop is
 * the first `hashBytes` bytes of that repeater's public key, where `hashBytes`
 * is the path hash width (1, 2, or 3 — MeshCore packs `hash_size − 1` into the
 * top 2 bits of the on-wire `path_len`; 1-byte is the default). The companion
 * API stores/accepts the path as a comma-separated hex chain where each hop is
 * `hashBytes * 2` hex chars — "a3,7f,02" at 1-byte, "a3f2,7f01" at 2-byte.
 * These helpers convert between that wire form and a name-aware UI.
 */

/** A single forwarding hop as a normalized lowercase hex hash (2/4/6 chars). */
export type PathHop = string;

/**
 * Parse a stored out_path into normalized hop hashes. Width-agnostic: each
 * token keeps its own width (2, 4, or 6 hex chars), so a mixed call site
 * doesn't need to know the path's hash width up front. Legacy single-hex-char
 * tokens are left-padded to one byte.
 */
export function parsePathHops(outPath: string | null | undefined): PathHop[] {
  if (!outPath) return [];
  return outPath
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .map((s) => (/^[0-9a-f]$/.test(s) ? `0${s}` : s))
    .filter((s) => /^[0-9a-f]+$/.test(s) && s.length % 2 === 0 && s.length >= 2 && s.length <= 6);
}

/** Join hop hashes back into the comma-separated chain the API expects. */
export function joinPathHops(hops: PathHop[]): string {
  return hops.join(',');
}

/**
 * Infer the path hash width (1/2/3 bytes per hop) from a parsed hop list by
 * looking at the first hop's hex length. Empty list defaults to 1. Used to
 * pre-select the width selector when editing an existing path.
 */
export function pathHashBytesOf(hops: PathHop[]): 1 | 2 | 3 {
  if (hops.length === 0) return 1;
  const w = hops[0].length / 2;
  return w === 2 || w === 3 ? w : 1;
}

/**
 * The routing hop hash for a node = the first `hashBytes` bytes of its public
 * key, as lowercase hex. At the default 1-byte width this is the leading byte;
 * at 2/3-byte widths the collision space shrinks accordingly.
 */
export function hopByteForKey(publicKey: string, hashBytes: 1 | 2 | 3 = 1): PathHop {
  return publicKey.slice(0, hashBytes * 2).toLowerCase();
}

export interface RepeaterOption {
  publicKey: string;
  name: string;
  /** The hop hash for this repeater at the active path hash width. */
  hopByte: PathHop;
  /** Last advertised position, when known — used for collision tie-breaking. */
  latitude?: number;
  longitude?: number;
}

/**
 * Candidate hops for the path picker: repeaters (advType 2) and room servers
 * (advType 3) — the relay infrastructure a path traverses — with display names
 * and their hop hash at the active `hashBytes` width, sorted by name.
 */
export function repeaterHopOptions(
  contacts: MeshCoreContact[],
  hashBytes: 1 | 2 | 3 = 1,
): RepeaterOption[] {
  return contacts
    .filter((c) => c.advType === 2 || c.advType === 3)
    .map((c) => ({
      publicKey: c.publicKey,
      name: c.advName || c.name || `${c.publicKey.slice(0, 8)}…`,
      hopByte: hopByteForKey(c.publicKey, hashBytes),
      latitude: c.latitude,
      longitude: c.longitude,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ResolvedHop {
  byte: PathHop;
  /** Repeaters whose key starts with this hash (0, 1, or many — narrower at higher widths). */
  matches: RepeaterOption[];
  /** Human label: the repeater name, "name (+N)" on collision, or "Unknown (0xAB)". */
  label: string;
}

/** Resolve a hop hash to a human label using the known-repeater list. */
export function resolveHop(byte: PathHop, options: RepeaterOption[]): ResolvedHop {
  const matches = options.filter((o) => o.hopByte === byte);
  let label: string;
  if (matches.length === 1) label = matches[0].name;
  else if (matches.length > 1) label = `${matches[0].name} (+${matches.length - 1})`;
  else label = `Unknown (0x${byte})`;
  return { byte, matches, label };
}

/** A usable position for tie-breaking: finite coords, excluding null island. */
function optionPosition(o: RepeaterOption): { lat: number; lon: number } | null {
  const { latitude: lat, longitude: lon } = o;
  if (typeof lat !== 'number' || !isFinite(lat)) return null;
  if (typeof lon !== 'number' || !isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/**
 * Resolve a received route's hop hashes to relay names for the {ROUTE_NAMES}
 * automation token.
 *
 * Only relay infrastructure (repeaters, room servers) ever appears in a
 * MeshCore path — each forwarder appends the leading bytes of its public key
 * at the width the ORIGINAL SENDER stamped into `path_len`'s top two bits —
 * so matching is limited to those contacts. Per-hop rules:
 *   - exactly one match  → its name
 *   - multiple matches   → best guess: the positioned candidate with the
 *     smallest summed haversine distance to the two neighbouring hops'
 *     resolved positions (previous hop as already resolved, next hop when it
 *     matches uniquely); falls back to the alphabetically-first match when no
 *     candidate/neighbour has coordinates
 *   - no match           → the raw hex hash (compact — these strings ride in
 *     airtime-limited MeshCore replies)
 */
export function resolveRouteNames(hops: PathHop[], contacts: MeshCoreContact[]): string[] {
  const width = pathHashBytesOf(hops);
  const options = repeaterHopOptions(contacts, width);
  const matchesPerHop = hops.map((h) => options.filter((o) => o.hopByte === h));

  // Positions of hops that resolve unambiguously — usable as a "next hop"
  // anchor before that hop has been walked.
  const uniquePos = matchesPerHop.map((ms) => (ms.length === 1 ? optionPosition(ms[0]) : null));

  const names: string[] = [];
  const resolvedPos: ({ lat: number; lon: number } | null)[] = [];
  for (let i = 0; i < hops.length; i++) {
    const ms = matchesPerHop[i];
    if (ms.length === 0) {
      names.push(hops[i]);
      resolvedPos.push(null);
      continue;
    }
    let best = ms[0];
    if (ms.length > 1) {
      const neighbors = [i > 0 ? resolvedPos[i - 1] : null, uniquePos[i + 1] ?? null]
        .filter((p): p is { lat: number; lon: number } => p !== null);
      let bestScore = Infinity;
      for (const cand of ms) {
        const p = optionPosition(cand);
        if (!p) continue;
        const score = neighbors.reduce((acc, n) => acc + calculateDistance(p.lat, p.lon, n.lat, n.lon), 0);
        if (neighbors.length > 0 && score < bestScore) {
          bestScore = score;
          best = cand;
        }
      }
    }
    names.push(best.name);
    resolvedPos.push(optionPosition(best));
  }
  return names;
}
