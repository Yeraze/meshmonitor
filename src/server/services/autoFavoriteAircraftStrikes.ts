/**
 * Two-strike sweep-removal rule for Auto-Favorite likely-aircraft exclusion
 * (#5364/#5365 Phase 1 WP3, spec §4.11, decision D19).
 *
 * A flagged auto-favourite is removed only after it was seen flagged at TWO
 * consecutive sweeps at least `AIRCRAFT_STRIKE_MIN_GAP_MS` apart. The state is
 * persisted per source in the `autoFavoriteAircraftStrikes` setting (JSON), so
 * a restart or an unrelated settings save cannot reset the streak (mesh
 * impact checklist §3) — `favoritesService.ts` reads/writes that setting;
 * these are the pure, easily-tested helpers it calls.
 *
 * The 45-minute gap exists so the boot sweep (~55 s after every connect and
 * reconnect, `meshtasticManager.ts` ~2298) and any stacked hourly interval
 * from a quick reconnect cannot masquerade as the "second" sweep.
 */

export const AIRCRAFT_STRIKE_MIN_GAP_MS = 45 * 60_000;
export const AIRCRAFT_STRIKES_TO_REMOVE = 2;

export interface AircraftStrike {
  count: number;
  lastAt: number;
}

export type AircraftStrikes = Record<string, AircraftStrike>;

function isValidStrike(v: unknown): v is AircraftStrike {
  if (v == null || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return typeof s.count === 'number' && Number.isFinite(s.count) && typeof s.lastAt === 'number' && Number.isFinite(s.lastAt);
}

/**
 * Parse the stored `autoFavoriteAircraftStrikes` JSON. Garbage, non-object
 * input, or an entry that doesn't look like an `AircraftStrike` is dropped
 * rather than thrown — a corrupted value degrades to "no strikes yet", never
 * a crash.
 */
export function parseAircraftStrikes(raw: string | null | undefined): AircraftStrikes {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result: AircraftStrikes = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isValidStrike(value)) {
      result[key] = { count: value.count, lastAt: value.lastAt };
    }
  }
  return result;
}

/**
 * One node's strike update for one sweep.
 *  - not flagged              → entry deleted                    (streak broken)
 *  - flagged, no entry        → { count: 1, lastAt: now }
 *  - flagged, now - lastAt >= MIN_GAP → { count: count + 1, lastAt: now }
 *  - flagged, gap too short   → unchanged (same sweep window: boot sweep,
 *                                reconnect sweep, stacked interval)
 * Returns the new entry (or null when deleted) and whether it reached
 * AIRCRAFT_STRIKES_TO_REMOVE.
 */
export function applyAircraftStrike(
  prev: AircraftStrike | undefined,
  flagged: boolean,
  now: number,
): { next: AircraftStrike | null; remove: boolean } {
  if (!flagged) {
    return { next: null, remove: false };
  }
  if (!prev) {
    return { next: { count: 1, lastAt: now }, remove: false };
  }
  if (now - prev.lastAt >= AIRCRAFT_STRIKE_MIN_GAP_MS) {
    const next = { count: prev.count + 1, lastAt: now };
    return { next, remove: next.count >= AIRCRAFT_STRIKES_TO_REMOVE };
  }
  // Same sweep window as the last counted strike (boot sweep, reconnect sweep,
  // a stacked interval) — unchanged, and never a removal by itself. A prior
  // call that DID reach the removal count is acted on (and the entry deleted)
  // within that same sweep, so a stale "already at 2" entry never survives to
  // be re-evaluated here.
  return { next: prev, remove: false };
}
