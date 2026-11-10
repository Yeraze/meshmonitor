/**
 * Clock-offset helpers shared by the Security tab, the notification text and
 * the digest (#6281). Pure; no server or React imports.
 *
 * Offset = receipt time minus the node's own time, in seconds. Positive means
 * the node is behind (Meshtastic's convention). A node that never had its clock
 * set (no RTC; it stamps a firmware default years in the past) is far off, and
 * is labelled "Clock not set" instead of a drift in years.
 */

/** A year or more off counts as a clock that was never set. */
export const CLOCK_NOT_SET_OFFSET_SECONDS = 365 * 86400;

export function isClockNotSet(offsetSeconds: number | null | undefined): boolean {
  return typeof offsetSeconds === 'number' && Math.abs(offsetSeconds) >= CLOCK_NOT_SET_OFFSET_SECONDS;
}

/**
 * A short English span: `2h 14m`, `3d 4h`, `45m`, `30s`. The caller keeps it
 * under a year (see {@link isClockNotSet}). Rounds down; never negative.
 */
export function formatCompactSpan(seconds: number): string {
  const abs = Math.max(0, Math.floor(Math.abs(seconds)));
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  const m = Math.floor((abs % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${abs}s`;
}
