/**
 * Bounds for the number inputs on the Meshtastic Automation page.
 *
 * Every `<input type="number">` needs an explicit `max`. Without one, Chrome
 * exposes the spinbutton to assistive tech as `aria-valuemax="0"`, so a screen
 * reader announces a range of "0 to 0" on a field that takes 60. The values
 * here are the real accepted range: the server bound where one exists, or a
 * ceiling past which the value stops making sense.
 */

/** Per-node cooldowns entered in seconds (Auto-Acknowledge, Auto-Responder): up to one day. */
export const COOLDOWN_SECONDS_MAX = 86400;

/** Geofence per-node cooldown, in minutes: up to one week. */
export const GEOFENCE_COOLDOWN_MINUTES_MAX = 10080;

/**
 * Geofence "while inside" fire interval, in minutes: up to one day.
 *
 * The server arms this with `setInterval`, whose delay overflows at 2^31-1 ms
 * (~35,791 minutes). Node treats an overflowed delay as 1 ms, so an unbounded
 * value here would fire the trigger continuously instead of rarely.
 */
export const GEOFENCE_INTERVAL_MINUTES_MIN = 1;
export const GEOFENCE_INTERVAL_MINUTES_MAX = 1440;

/** Geofence circle radius, in km: half the Earth's circumference covers any point. */
export const GEOFENCE_RADIUS_KM_MAX = 20037;

/** Auto-delete-by-distance threshold, in km. Matches the settings route's 400 bound. */
export const DISTANCE_DELETE_THRESHOLD_KM_MAX = 50000;

/** "Last heard within N hours" node filters (Auto-Traceroute, Auto-LocalStats): up to one year. */
export const LAST_HEARD_FILTER_HOURS_MAX = 8760;

/**
 * Auto-Traceroute hop-range filter ceiling. Meshtastic caps hop_limit at 7, but
 * the stored default for the upper bound is 10 ("no ceiling"), so the input has
 * to accept 10 or the default itself would read as out of range.
 */
export const HOP_FILTER_MAX = 10;

/** Clamp an integer parsed from a number input into [min, max]; NaN falls back to `min`. */
export function clampInt(raw: string, min: number, max: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}
