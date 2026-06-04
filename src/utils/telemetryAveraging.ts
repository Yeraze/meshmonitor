/**
 * Helpers for downsampling telemetry to a manageable number of points for
 * charting. Kept dependency-free so it can be unit tested without pulling in
 * the database singleton.
 */

/**
 * Target number of averaged data points per telemetry type for a charting
 * window. The averaging interval is derived from this so that any requested
 * window (15 minutes through the full retention period) yields a roughly
 * constant, manageable point count: short windows keep near-full resolution
 * (1-minute buckets) while long windows are downsampled rather than truncated.
 */
export const TELEMETRY_TARGET_BUCKETS = 240;

/**
 * Choose the time-bucket size (in minutes) for an averaged telemetry query so
 * the result lands near {@link TELEMETRY_TARGET_BUCKETS} points per type.
 *
 * @param maxHours - Width of the requested window in hours (fractional allowed,
 *   e.g. 0.25 for a 15-minute window). Falls back to 3-minute buckets when the
 *   window is unknown or non-positive.
 * @returns Bucket size in whole minutes, never less than 1.
 */
export function computeAveragingIntervalMinutes(maxHours?: number): number {
  if (maxHours === undefined || !(maxHours > 0)) {
    return 3;
  }
  const rangeMinutes = maxHours * 60;
  return Math.max(1, Math.round(rangeMinutes / TELEMETRY_TARGET_BUCKETS));
}
