/**
 * Named thresholds for the Mesh Issues Analysis Tier A rules (#4964, Phase 1
 * WP2). Every numeric threshold used by `rules.ts` lives here as a named,
 * JSDoc'd constant — `rules.ts` must not contain a numeric literal threshold.
 *
 * Each constant's JSDoc ends in one of:
 *   - `[official]` — sourced from the Meshtastic ROUTER_LATE blog post /
 *     firmware documentation.
 *   - `[ours]` — a MeshMonitor-chosen value, tunable (settings UI is Phase 3).
 *     These are explicit veto candidates — see the Phase 1 spec §5.
 *
 * Pure, dependency-free except for `DeviceRole` (a plain constant object, no
 * `databaseService` import) — safe for WP2's zero-`databaseService`-import
 * acceptance gate.
 */
import { DeviceRole } from '../../../constants/index.js';

/** Mean airUtilTx above which a node is "chatty", percent. [official] */
export const AIR_UTIL_TX_PCT_THRESHOLD = 8;

/** Minimum airUtilTx samples in-window before A2a may fire. [ours] */
export const AIR_UTIL_TX_MIN_SAMPLES = 6;

/** A2a/A2b metric window, hours. [ours] */
export const UTILIZATION_WINDOW_HOURS = 24;

/** Mean channelUtilization above which an area is congested, percent. [official] */
export const CHANNEL_UTIL_PCT_THRESHOLD = 25;

/** Minimum nodes in a geographic bin before A2b is an AREA finding. [ours] */
export const CONGESTED_AREA_MIN_NODES = 3;

/** Geographic bin size for A2b clustering, degrees (~5.5 km of latitude). [ours] */
export const AREA_GRID_BIN_DEG = 0.05;

/** Battery percent below which an infra node counts as deep-discharging. [ours] */
export const BATTERY_LOW_PCT = 20;

/** Minimum batteryLevel samples in-window before the A3 battery clause fires. [ours] */
export const BATTERY_MIN_SAMPLES = 3;

/** Uptime resets in the A3 window that make a power problem a warning. [ours] */
export const UPTIME_RESET_MIN_COUNT = 2;

/** A3/A4 window, hours (7 days). [ours] */
export const POWER_WINDOW_HOURS = 168;

/** Bounding-box span above which an infra node counts as mobile, meters. [ours] */
export const MOBILE_SPAN_METERS = 500;

/**
 * Minimum position precision bits before A4 trusts a computed span. At 16 bits
 * a position cell is 360/2^16 deg ~= 610 m, which straddles MOBILE_SPAN_METERS,
 * so truncated positions could fabricate "movement". 17 bits ~= 305 m. [ours]
 */
export const MOBILE_MIN_PRECISION_BITS = 17;

/** Firmware version at/after which `is_unmessagable` is meaningful. [ours] */
export const UNMESSAGABLE_MIN_FIRMWARE = '2.5.0';

/** Consecutive clean runs before an open finding auto-closes. [ours] */
export const AUTO_CLOSE_CLEAN_RUNS = 3;

/** Roles that carry routing responsibility. Built from DeviceRole. */
export const INFRA_ROLES: ReadonlySet<number> = new Set([
  DeviceRole.ROUTER,
  DeviceRole.ROUTER_CLIENT,
  DeviceRole.REPEATER,
  DeviceRole.ROUTER_LATE,
]);

/** Roles the firmware documentation now deprecates for new deployments. */
export const DEPRECATED_ROLES: ReadonlySet<number> = new Set([
  DeviceRole.ROUTER_CLIENT,
  DeviceRole.REPEATER,
]);

/** Dedicated-infrastructure roles that SHOULD be unmessagable (A5). */
export const DEDICATED_ROUTER_ROLES: ReadonlySet<number> = new Set([
  DeviceRole.ROUTER,
  DeviceRole.ROUTER_LATE,
]);
