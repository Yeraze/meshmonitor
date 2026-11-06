/**
 * Ordering for a MeshCore message's heard-repeaters list (#6000).
 *
 * Fewest hops first (the repeaters that heard the sender directly lead),
 * then strongest SNR. An entry with no hop count (rows written before
 * migration 218) sorts after every entry that has one; a missing SNR sorts
 * after a present one. Ties keep their input order.
 */
export interface HeardByOrderEntry {
  hops?: number | null;
  snr?: number | null;
}

/** Compare two optional numbers, missing values last; `dir` 1 = ascending, -1 = descending. */
function compareNullLast(a: number | null | undefined, b: number | null | undefined, dir: 1 | -1): number {
  const aOk = typeof a === 'number';
  const bOk = typeof b === 'number';
  if (aOk && bOk) return ((a as number) - (b as number)) * dir;
  if (aOk) return -1;
  if (bOk) return 1;
  return 0;
}

export function sortHeardBy<T extends HeardByOrderEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((x, y) => compareNullLast(x.hops, y.hops, 1) || compareNullLast(x.snr, y.snr, -1));
}

// ---------------------------------------------------------------------------
// Required Repeater gate (#6178)
//
// MeshCore's per-source Required Repeater gate keeps the resend (↻) button
// available until ONE specific repeater is heard relaying a channel message,
// rather than any repeater at all. The UI (`meshcoreResend.ts`) and the server
// authority (`MeshCoreManager.resendChannelMessage`) both call this one pure
// helper so they can never drift.
//
// A `heardBy` entry carries a relay path-hash: a short hex PREFIX of the
// relaying repeater's public key (1–3 bytes, i.e. 2–6 hex chars). Prefixes
// collide, so a bare `requiredKey.startsWith(hash)` test would fire on the
// wrong repeater. We mirror the existing `nameForRelayHash` uniqueness guard
// instead: a hearing counts only when a prefix resolves to EXACTLY ONE known
// relay and that relay is the required one.
//
// The asymmetry is deliberate. A false positive (hide resend early) defeats the
// feature; a false negative (keep the button) only costs one extra,
// already-rate-limited resend. So ambiguous or unknown prefixes do NOT count.
// ---------------------------------------------------------------------------

/** Minimal contact shape the matcher needs — full public key + advert type. */
export interface RepeaterContactLike {
  publicKey: string;
  advType?: number | null;
}

/** Minimal heardBy entry shape — just the relay path-hash prefix. */
export interface HeardByEntryLike {
  hash: string;
}

/** Advert types that can appear in a relay path: REPEATER (2), ROOM_SERVER (3). */
export const RELAY_ADV_TYPES: ReadonlySet<number> = new Set<number>([2, 3]);

/**
 * True when `heardBy` contains a path-hash that resolves UNAMBIGUOUSLY to the
 * required repeater (identified by its full public key).
 *
 * Returns false when no required repeater is set, when `heardBy` is empty, when
 * every matching prefix is ambiguous (more than one known relay shares it), or
 * when the required repeater is not among the known contacts.
 *
 * A contact with an unknown advert type (`advType == null`) is treated as a
 * possible relay so a repeater heard before its advert type is known is not
 * silently excluded from the uniqueness count.
 */
export function requiredRepeaterHeard(
  heardBy: ReadonlyArray<HeardByEntryLike> | undefined | null,
  requiredPublicKey: string | null | undefined,
  repeaters: ReadonlyArray<RepeaterContactLike>,
): boolean {
  if (!requiredPublicKey || !heardBy || heardBy.length === 0) return false;
  const required = requiredPublicKey.toLowerCase();
  const relays = repeaters.filter(
    (r) => r.publicKey && (r.advType == null || RELAY_ADV_TYPES.has(r.advType)),
  );
  for (const entry of heardBy) {
    const h = (entry?.hash || '').toLowerCase();
    if (!h) continue;
    const matches = relays.filter((r) => r.publicKey.toLowerCase().startsWith(h));
    if (matches.length === 1 && matches[0].publicKey.toLowerCase() === required) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Required Repeater LIST gate (#6193)
//
// #6178 gated on ONE repeater. #6193 generalises to a LIST with an ANY / ALL
// mode: ANY hides the resend once at least one listed repeater is heard; ALL
// keeps it until every listed repeater is heard. Both modes reuse the single
// `requiredRepeaterHeard` unique-prefix matcher above, so the per-repeater
// decision — and therefore the badge ✓/✗ and the gate — can never drift.
//
// The old single key stays supported for read back-compat: no migration (the
// settings store is a KV store). The one reader below is the single source of
// truth both the UI resend path and the server authority call.
// ---------------------------------------------------------------------------

export type RequiredRepeaterMode = 'any' | 'all';

/** The three per-source settings the reader folds into a `{ keys, mode }`. */
export interface RequiredRepeaterSettingsLike {
  /** #6193 list: JSON array of full public-key hex strings (string or array). */
  meshcoreRequiredRepeaters?: unknown;
  /** #6178 legacy single full public-key hex string. */
  meshcoreRequiredRepeater?: unknown;
  /** #6193 mode; anything but `'all'` reads as `'any'` (the default). */
  meshcoreRequiredRepeaterMode?: unknown;
}

export interface RequiredRepeaterConfig {
  keys: string[];
  mode: RequiredRepeaterMode;
}

/** Normalise a stored list value (JSON string or array) to deduped hex keys. */
function parseKeyList(raw: unknown): string[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      arr = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const k = v.trim();
    if (!k) continue;
    const dedupe = k.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(k);
  }
  return out;
}

/**
 * Resolve the per-source Required Repeater configuration (#6193), preferring
 * the new list and falling back to the legacy single key so #6178 setups keep
 * working with no migration. Default mode is `'any'`.
 *
 * - `meshcoreRequiredRepeaters` present and non-empty → that list.
 * - else legacy `meshcoreRequiredRepeater` non-empty → `[that]`.
 * - else `[]` (no gate; #6184 "heard by any repeater" fallback applies).
 */
export function readRequiredRepeaters(
  settings: RequiredRepeaterSettingsLike | null | undefined,
): RequiredRepeaterConfig {
  const mode: RequiredRepeaterMode =
    String(settings?.meshcoreRequiredRepeaterMode ?? '').toLowerCase() === 'all' ? 'all' : 'any';
  const fromList = parseKeyList(settings?.meshcoreRequiredRepeaters);
  if (fromList.length > 0) return { keys: fromList, mode };
  const legacy = settings?.meshcoreRequiredRepeater;
  if (typeof legacy === 'string' && legacy.trim()) return { keys: [legacy.trim()], mode };
  return { keys: [], mode };
}

/**
 * True when the Required Repeater gate is SATISFIED (the send should stop being
 * resendable), built from the single-key matcher:
 *
 * - empty `requiredKeys` → the #6184 fallback: satisfied once ANY repeater is
 *   heard (`heardBy` non-empty).
 * - mode `'any'` → `.some()` of the keys heard.
 * - mode `'all'` → `.every()` of the keys heard.
 *
 * Preserves the documented false-positive / false-negative asymmetry: an
 * ambiguous or unknown prefix counts as "not heard", so ALL stays unsatisfied
 * (keep the button) rather than hiding it early.
 */
export function requiredRepeatersHeard(
  heardBy: ReadonlyArray<HeardByEntryLike> | undefined | null,
  requiredKeys: ReadonlyArray<string> | undefined | null,
  mode: RequiredRepeaterMode,
  repeaters: ReadonlyArray<RepeaterContactLike>,
): boolean {
  if (!requiredKeys || requiredKeys.length === 0) {
    return !!heardBy && heardBy.length > 0;
  }
  if (mode === 'all') {
    return requiredKeys.every((k) => requiredRepeaterHeard(heardBy, k, repeaters));
  }
  return requiredKeys.some((k) => requiredRepeaterHeard(heardBy, k, repeaters));
}

// ---------------------------------------------------------------------------
// Relay observations accumulate (#6193 follow-up)
//
// A `meshcore:channel-heard` push lists the repeaters that have relayed a
// message so far. An HTTP fetch or snapshot load can be captured BEFORE that
// push arrives, so replacing the row with the fetched copy would erase the
// confirmation and make the resend (↻) button reappear. Relay evidence is
// monotonic: merge by path hash, keep a name once learned, keep the strongest
// SNR and the fewest hops seen.
// ---------------------------------------------------------------------------

export interface HeardByObservation {
  hash: string;
  name?: string | null;
  snr?: number | null;
  hops?: number | null;
}

export function mergeMeshCoreHeardBy<T extends HeardByObservation>(
  previous: ReadonlyArray<T> | undefined | null,
  incoming: ReadonlyArray<T> | undefined | null,
): T[] | undefined {
  if (!previous?.length) return incoming ? [...incoming] : undefined;
  if (!incoming?.length) return [...previous];
  const byHash = new Map(previous.map((relay) => [relay.hash, relay]));
  for (const relay of incoming) {
    const old = byHash.get(relay.hash);
    byHash.set(relay.hash, {
      ...old,
      ...relay,
      name: relay.name ?? old?.name,
      snr: old?.snr != null && relay.snr != null
        ? Math.max(old.snr, relay.snr) : relay.snr ?? old?.snr,
      hops: old?.hops != null && relay.hops != null
        ? Math.min(old.hops, relay.hops) : relay.hops ?? old?.hops,
    });
  }
  return [...byHash.values()];
}
