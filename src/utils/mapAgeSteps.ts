/**
 * Non-linear stops for the Map Features "Maximum age" slider (#4770).
 *
 * A linear one-hour-per-tick slider is unusable once the range stretches to
 * weeks: 720 ticks to cover 1h..30d. The slider instead snaps to these
 * human-scale stops. The stops are always bounded by the per-source
 * `maxNodeAgeHours` setting — the setting's value is the final ("All") stop, so
 * the slider can never select an age the setting would clamp away (see
 * {@link ../utils/mapAge.ts effectiveMapMaxAgeHours}).
 */
export const AGE_FILTER_STOP_HOURS: readonly number[] = [
  1, // 1h
  3, // 3h
  6, // 6h
  12, // 12h
  24, // 1d
  72, // 3d
  168, // 7d
  336, // 14d
  720, // 30d
];

/**
 * Ordered slider stops for a given setting cap (`maxHours`): every canonical
 * stop strictly below the cap, then the cap itself as the top stop. The top
 * stop is rendered as "All" and stored as `null` (follow the setting).
 *
 * Always returns at least `[cap]`, so a cap of 1 yields a single (disabled)
 * stop.
 */
export function ageFilterStops(maxHours: number): number[] {
  // A "never / show all" setting (0 or non-finite, #4947) offers every canonical
  // stop PLUS an unlimited top stop (Infinity), rendered "All".
  if (!Number.isFinite(maxHours) || maxHours <= 0) {
    return [...AGE_FILTER_STOP_HOURS, Infinity];
  }
  const cap = Math.max(1, Math.round(maxHours));
  const stops = AGE_FILTER_STOP_HOURS.filter((h) => h < cap);
  stops.push(cap);
  return stops;
}

/**
 * Index of the stop nearest to `hours`. Ties resolve to the longer stop so an
 * exactly-halfway stored value snaps up rather than down. Used to position the
 * slider from an arbitrary stored age (which may not equal any stop).
 */
export function nearestAgeStopIndex(stops: number[], hours: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const dist = Math.abs(stops[i] - hours);
    if (dist <= bestDist) {
      bestDist = dist;
      best = i; // ascending iteration → ties keep the later (longer) stop
    }
  }
  return best;
}

/**
 * Human-readable label for an age-filter stop. The top stop (>= `maxHours`)
 * renders as `allLabel`; otherwise sub-day values read as `${h}h` and longer
 * ones as `${d}d` (with a trailing `${h}h` only when not a whole number of
 * days).
 */
export function formatAgeStop(hours: number, maxHours: number, allLabel = 'All'): string {
  // The unlimited top stop (Infinity, #4947) is always "All". Otherwise the top
  // stop is the one at/above a FINITE positive cap. Guarding `maxHours > 0` keeps
  // a "never" cap (0) from labelling every finite stop as "All".
  if (!Number.isFinite(hours)) return allLabel;
  if (Number.isFinite(maxHours) && maxHours > 0 && hours >= maxHours) return allLabel;
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}
