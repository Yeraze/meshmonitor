/**
 * Lookback slider stops for flight trails (#5364/#5365 Phase 3, D2): fine
 * steps for recent flights, coarser toward the 7-day telemetry retention.
 */
export const AIRCRAFT_TRAIL_HOUR_STOPS: readonly number[] = [
  1, 2, 3, 4, 6, 8, 12, 18, 24, 36, 48, 72, 96, 120, 144, 168,
];

/** Index of the stop closest to `hours` (ties go to the lower stop). */
export function nearestTrailHourStopIndex(hours: number): number {
  let best = 0;
  for (let i = 1; i < AIRCRAFT_TRAIL_HOUR_STOPS.length; i++) {
    if (Math.abs(AIRCRAFT_TRAIL_HOUR_STOPS[i] - hours) < Math.abs(AIRCRAFT_TRAIL_HOUR_STOPS[best] - hours)) best = i;
  }
  return best;
}
