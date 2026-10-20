import type { MeshCoreContact } from './meshcoreHelpers.js';
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
 * Re-express a path at another hop-hash width (#5723). A hop hash is a prefix
 * of a public key, so narrowing truncates each hop. Widening needs the whole
 * key: it succeeds only when every hop is a prefix of exactly one of
 * `knownKeys`. Returns null when any hop is unknown or shared; nothing is
 * guessed. A path already at `toBytes` is returned unchanged.
 */
export function rewidthPathHops(hops: PathHop[], toBytes: 1 | 2 | 3, knownKeys: readonly string[]): PathHop[] | null {
  const width = toBytes * 2;
  const out: PathHop[] = [];
  for (const hop of hops) {
    if (hop.length === width) {
      out.push(hop);
    } else if (hop.length > width) {
      out.push(hop.slice(0, width));
    } else {
      const matches = knownKeys.filter((k) => k.toLowerCase().startsWith(hop));
      if (matches.length !== 1) return null;
      out.push(matches[0].slice(0, width).toLowerCase());
    }
  }
  return out;
}

/**
 * The routing hop hash for a node = the first `hashBytes` bytes of its public
 * key, as lowercase hex. At the default 1-byte width this is the leading byte;
 * at 2/3-byte widths the collision space shrinks accordingly.
 */
export function hopByteForKey(publicKey: string, hashBytes: 1 | 2 | 3 = 1): PathHop {
  return publicKey.slice(0, hashBytes * 2).toLowerCase();
}

/**
 * Most hops a trace path may carry. Each hop a trace passes appends one SNR
 * byte to the packet's path, which the firmware caps at MAX_PATH_SIZE (64).
 */
export const MAX_TRACE_PATH_HOPS = 63;

/**
 * Build the hop list for a trace (#5485).
 *
 * Without a return leg the trace walks only the saved out-path, so it stops at
 * the last repeater and the initiator often can't hear it end. With
 * `autoReturn`, the trace comes back along the same path, as MeshCore One's
 * "Auto Return Path" does:
 *
 * - `targetForwards` (repeater / room server): loop through the target —
 *   `out + target + reversed(out)`, e.g. `[5e]` to target `f6` becomes
 *   `[5e, f6, 5e]`. The firmware counts hops in a trace packet's hash, so a
 *   node can be revisited on the way back.
 * - otherwise (companion / sensor): a companion drops a trace unless its repeat
 *   setting is on, so turn around at the last repeater —
 *   `out + reversed(out) minus its first` — e.g. `[a, b]` becomes `[a, b, a]`.
 *
 * Falls back to the one-way path if the round trip would exceed
 * {@link MAX_TRACE_PATH_HOPS}.
 */
export function buildTracePathHops(
  outHops: PathHop[],
  targetPublicKey: string,
  hashBytes: 1 | 2 | 3,
  opts: { autoReturn: boolean; targetForwards: boolean },
): PathHop[] {
  if (!opts.autoReturn || outHops.length === 0) return outHops;
  const outbound = opts.targetForwards
    ? [...outHops, hopByteForKey(targetPublicKey, hashBytes)]
    : outHops;
  const full = [...outbound, ...[...outbound].reverse().slice(1)];
  return full.length > MAX_TRACE_PATH_HOPS ? outHops : full;
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

/** A fully-resolved route hop: the chosen candidate (if any) plus its position. */
export interface ResolvedRouteHop {
  byte: PathHop;
  /** Chosen candidate's name, or null when no repeater matched the hash. */
  name: string | null;
  /** How many repeater/room-server contacts matched this hash (0 = unknown, >1 = collision). */
  matchCount: number;
  /** Chosen candidate's position, when it has usable coordinates. */
  position: { lat: number; lon: number } | null;
}

/**
 * Resolve a received route's hop hashes to relay contacts — the shared engine
 * behind the {ROUTE_NAMES} automation token and the route-detail popup.
 *
 * Only relay infrastructure (repeaters, room servers) ever appears in a
 * MeshCore path — each forwarder appends the leading bytes of its public key
 * at the width the ORIGINAL SENDER stamped into `path_len`'s top two bits —
 * so matching is limited to those contacts. Per-hop rules:
 *   - exactly one match  → that contact
 *   - multiple matches   → best guess: the positioned candidate with the
 *     smallest summed haversine distance to the two neighbouring hops'
 *     resolved positions (previous hop as already resolved, next hop when it
 *     matches uniquely); falls back to the alphabetically-first match when no
 *     candidate/neighbour has coordinates
 *   - no match           → `name: null` (callers render the raw hex hash)
 */
export function resolveRoute(hops: PathHop[], contacts: MeshCoreContact[]): ResolvedRouteHop[] {
  const width = pathHashBytesOf(hops);
  const options = repeaterHopOptions(contacts, width);
  const matchesPerHop = hops.map((h) => options.filter((o) => o.hopByte === h));

  // Positions of hops that resolve unambiguously — usable as a "next hop"
  // anchor before that hop has been walked.
  const uniquePos = matchesPerHop.map((ms) => (ms.length === 1 ? optionPosition(ms[0]) : null));

  const resolved: ResolvedRouteHop[] = [];
  for (let i = 0; i < hops.length; i++) {
    const ms = matchesPerHop[i];
    if (ms.length === 0) {
      resolved.push({ byte: hops[i], name: null, matchCount: 0, position: null });
      continue;
    }
    let best = ms[0];
    if (ms.length > 1) {
      const neighbors = [i > 0 ? resolved[i - 1].position : null, uniquePos[i + 1] ?? null]
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
    resolved.push({ byte: hops[i], name: best.name, matchCount: ms.length, position: optionPosition(best) });
  }
  return resolved;
}

/**
 * Resolve a received route's hop hashes to relay names for the {ROUTE_NAMES}
 * automation token. Thin wrapper over `resolveRoute` — unknown hashes fall
 * back to the raw hex (compact — these strings ride in airtime-limited
 * MeshCore replies).
 */
export function resolveRouteNames(hops: PathHop[], contacts: MeshCoreContact[]): string[] {
  return resolveRoute(hops, contacts).map((r) => r.name ?? r.byte);
}

// ---------------------------------------------------------------------------
// Cross-source fallback (#5909)
// ---------------------------------------------------------------------------

/**
 * A relay on ANOTHER MeshCore source whose key starts with a hop hash, as the
 * server's permission-filtered `/hop-candidates` route returns it. Position is
 * present only when the viewer may see it.
 */
export interface CrossSourceHopCandidate {
  name: string;
  publicKey: string;
  sourceId: string;
  sourceName: string;
  latitude?: number;
  longitude?: number;
}

/** Hop hash (lowercase hex) to the other-source relays that match it. */
export type CrossSourceHopPool = Record<string, CrossSourceHopCandidate[]>;

/** A fallback candidate with its ranking distance (km), when it could be ranked. */
export interface RankedHopCandidate extends CrossSourceHopCandidate {
  /** Summed distance to the anchors used to rank it; absent when unranked. */
  distanceKm?: number;
}

/** A route hop resolved own-contacts-first, then from other sources. */
export interface ResolvedRouteHopWithFallback extends ResolvedRouteHop {
  /** 'own' = this source's contacts; 'other' = another source; 'none' = unknown. */
  origin: 'own' | 'other' | 'none';
  /** The source the shown name came from (origin 'other' only). */
  via: { sourceId: string; sourceName: string } | null;
  /**
   * True when `name` is a distance-ranked GUESS among several other-source
   * candidates. A tentative hop never carries a position, so it never lands on
   * the flow map as if it were known.
   */
  tentative: boolean;
  /** Every other-source candidate (origin 'other'), best first when ranked. */
  candidates: RankedHopCandidate[];
}

function candidatePosition(c: CrossSourceHopCandidate): { lat: number; lon: number } | null {
  return optionPosition({ publicKey: c.publicKey, name: c.name, hopByte: '', latitude: c.latitude, longitude: c.longitude });
}

/**
 * Resolve a route like {@link resolveRoute}, then fill hops that matched none
 * of this source's contacts from `pool` (other sources, #5909).
 *
 * Own contacts always win: a hop with any own match is left exactly as
 * `resolveRoute` resolved it. For an unmatched hop:
 *  - one candidate   → its name, labelled with its source; not tentative.
 *  - several, ranked → the nearest candidate, marked tentative. Anchors are
 *    the neighbouring hops' known positions (the previous hop, when it is not
 *    itself a guess, and the next hop when it resolves to one node), plus the
 *    receiving radio after the last hop, since the last relay is the one that
 *    reached it. With no neighbour anchor, the receiver alone is used.
 *  - several, unranked (no positioned candidate or no anchor) → no name; the
 *    caller shows "N candidates" and the list.
 */
export function resolveRouteWithFallback(
  hops: PathHop[],
  contacts: MeshCoreContact[],
  pool: CrossSourceHopPool | null | undefined,
  receiver?: { lat: number; lon: number } | null,
): ResolvedRouteHopWithFallback[] {
  const own = resolveRoute(hops, contacts);
  const candsFor = (i: number): CrossSourceHopCandidate[] => {
    if (!pool || own[i].matchCount > 0) return [];
    const byte = hops[i];
    return (pool[byte] ?? []).filter((c) => c.publicKey.toLowerCase().startsWith(byte));
  };

  // A position the hop is certain to have: an own unique match, or a single
  // other-source candidate. Used as the "next hop" anchor.
  const certainPos = hops.map((_, i) => {
    if (own[i].matchCount === 1) return own[i].position;
    const cs = candsFor(i);
    return cs.length === 1 ? candidatePosition(cs[0]) : null;
  });

  const out: ResolvedRouteHopWithFallback[] = [];
  for (let i = 0; i < hops.length; i++) {
    const base = own[i];
    if (base.matchCount > 0) {
      out.push({ ...base, origin: 'own', via: null, tentative: false, candidates: [] });
      continue;
    }
    const cs = candsFor(i);
    if (cs.length === 0) {
      out.push({ ...base, origin: 'none', via: null, tentative: false, candidates: [] });
      continue;
    }
    if (cs.length === 1) {
      const c = cs[0];
      out.push({
        byte: base.byte,
        name: c.name,
        matchCount: 1,
        position: candidatePosition(c),
        origin: 'other',
        via: { sourceId: c.sourceId, sourceName: c.sourceName },
        tentative: false,
        candidates: [c],
      });
      continue;
    }

    const prev = i > 0 && !out[i - 1].tentative ? out[i - 1].position : null;
    const next = i < hops.length - 1 ? certainPos[i + 1] : (receiver ?? null);
    let anchors = [prev, next].filter((p): p is { lat: number; lon: number } => p !== null);
    if (anchors.length === 0 && receiver) anchors = [receiver];

    const ranked: RankedHopCandidate[] = cs.map((c) => {
      const p = candidatePosition(c);
      if (!p || anchors.length === 0) return { ...c };
      const d = anchors.reduce((acc, a) => acc + calculateDistance(p.lat, p.lon, a.lat, a.lon), 0);
      return { ...c, distanceKm: d };
    });
    ranked.sort((a, b) => {
      const da = a.distanceKm ?? Infinity;
      const db = b.distanceKm ?? Infinity;
      if (da !== db) return da - db;
      return a.name.localeCompare(b.name);
    });
    const best = ranked[0];
    const isRanked = best.distanceKm !== undefined;
    out.push({
      byte: base.byte,
      name: isRanked ? best.name : null,
      matchCount: cs.length,
      position: null,
      origin: 'other',
      via: isRanked ? { sourceId: best.sourceId, sourceName: best.sourceName } : null,
      tentative: isRanked,
      candidates: ranked,
    });
  }
  return out;
}
