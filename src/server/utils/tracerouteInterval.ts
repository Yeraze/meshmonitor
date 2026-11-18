/**
 * Auto Traceroute interval helpers.
 *
 * Auto Traceroute is OFF by default: a source with no saved
 * `tracerouteIntervalMinutes` value has an interval of 0. Every reader must
 * treat "no value saved" the same as a saved 0, and must not invent a
 * non-zero default. A value the user saved passes through unchanged.
 */

/** Rows-per-hour used to size the recent-traceroutes list when Auto Traceroute is off. */
export const RECENT_TRACEROUTE_SIZING_FLOOR_PER_HOUR = 12;

/** Smallest default row limit for the recent-traceroutes list. */
export const RECENT_TRACEROUTE_MIN_LIMIT = 100;

/**
 * Parse a stored `tracerouteIntervalMinutes` value. Absent or unreadable
 * means off (0); a saved number is returned as-is.
 */
export function parseTracerouteIntervalMinutes(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Default row limit for the recent-traceroutes list: enough rows to cover the
 * node window at the configured interval, plus 10% slack, never below
 * {@link RECENT_TRACEROUTE_MIN_LIMIT}. When Auto Traceroute is off, size the
 * list as if 12 traceroutes arrived per hour (manual and heard traceroutes
 * still land in the table).
 */
export function recentTracerouteLimit(rawInterval: string | null | undefined, maxNodeAgeHours: number): number {
  const minutes = parseTracerouteIntervalMinutes(rawInterval);
  const perHour = minutes > 0 ? 60 / minutes : RECENT_TRACEROUTE_SIZING_FLOOR_PER_HOUR;
  return Math.max(Math.ceil(perHour * maxNodeAgeHours * 1.1), RECENT_TRACEROUTE_MIN_LIMIT);
}
