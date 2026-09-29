/**
 * Bounds for scheduler intervals and delays built from user-set minutes, hours
 * or seconds.
 *
 * Node stores a timer delay as a signed 32-bit millisecond count. Any delay
 * above 2^31-1 ms (about 24.8 days, or 35,791 minutes) overflows, and Node
 * swaps it for 1 ms with only a TimeoutOverflowWarning. A `setInterval` fed a
 * stored value like 999999 minutes would therefore fire every millisecond: a
 * mesh flood for anything that transmits.
 *
 * Each scheduler clamps its setting into the range its UI offers before it
 * builds the delay. Out-of-range values are clamped and logged at warn, not
 * rejected, so rows already in the database keep working after an upgrade.
 */
import { logger } from '../../utils/logger.js';

/** Largest delay Node's timers accept without overflowing to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface IntervalRange {
  min: number;
  max: number;
}

/** Geofence "while inside" re-fire interval, minutes (matches the UI input). */
export const GEOFENCE_WHILE_INSIDE_MINUTES: IntervalRange = { min: 1, max: 1440 };
/** Meshtastic Auto-Announce interval, hours (AutoAnnounceSection: 3–24). */
export const AUTO_ANNOUNCE_HOURS: IntervalRange = { min: 3, max: 24 };
/** Delay between per-channel NodeInfo broadcasts, seconds (AutoAnnounceSection: 10–300). */
export const NODEINFO_BROADCAST_DELAY_SECONDS: IntervalRange = { min: 10, max: 300 };
/** Remote Admin Scanner interval, minutes (0 = disabled is handled by the caller). */
export const REMOTE_ADMIN_SCANNER_MINUTES: IntervalRange = { min: 1, max: 60 };
/** Auto Time Sync interval, minutes (0 = disabled is handled by the caller). */
export const TIME_SYNC_MINUTES: IntervalRange = { min: 15, max: 1440 };
/** Auto-Delete-by-Distance interval, hours (UI offers 6/12/24/48). */
export const DISTANCE_DELETE_HOURS: IntervalRange = { min: 6, max: 48 };
/** MeshCore Auto-Announce interval, hours (matches its save route). */
export const MESHCORE_AUTO_ANNOUNCE_HOURS: IntervalRange = { min: 1, max: 168 };
/** MeshCore Auto-Pathfinding gap between targets, minutes (matches its save route). */
export const MESHCORE_PATHFINDING_INTERVAL_MINUTES: IntervalRange = { min: 3, max: 60 };
/** MeshCore Auto-Pathfinding repeat, hours (matches its save route). */
export const MESHCORE_PATHFINDING_REPEAT_HOURS: IntervalRange = { min: 1, max: 168 };

/**
 * Clamp a user-set interval into `range`, logging a warning when it moves.
 *
 * A non-finite value (NaN from a garbled row) falls back to `fallback`, or to
 * `range.min` when no fallback is given. The result is always finite and inside
 * the range, so `result * unitMs` stays under {@link MAX_TIMER_DELAY_MS} for
 * every range defined here.
 */
export function clampIntervalSetting(
  value: number,
  range: IntervalRange,
  label: string,
  fallback?: number,
): number {
  if (!Number.isFinite(value)) {
    const used = fallback ?? range.min;
    logger.warn(`⚠️ ${label}: invalid value ${String(value)}, using ${used}`);
    return used;
  }
  if (value < range.min || value > range.max) {
    const clamped = Math.min(range.max, Math.max(range.min, value));
    logger.warn(`⚠️ ${label}: ${value} is outside ${range.min}–${range.max}, clamped to ${clamped}`);
    return clamped;
  }
  return value;
}
