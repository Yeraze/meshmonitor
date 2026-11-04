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
