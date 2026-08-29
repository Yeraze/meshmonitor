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

// ═══════════════════════════════════════════════════════════════════════════
// Tier B — RF adjacency graph rules (#4964, Phase 2 WP1)
// ═══════════════════════════════════════════════════════════════════════════

// ── B3 directional SNR ──────────────────────────────────────────────────────
/** Minimum SNR samples in ONE direction before B3 may fire. [ours] */
export const ASYMMETRY_MIN_SAMPLES_PER_DIRECTION = 3;
/** Directional mean-SNR delta above which a link is asymmetric, dB. [ours] */
export const ASYMMETRY_DELTA_DB = 6;

// ── Gateway evidence (class 3) ──────────────────────────────────────────────
/** Direct receptions at one gateway before a node counts as in its RF cell. [ours] */
export const GATEWAY_DIRECT_MIN_RECEPTIONS = 3;
/** Max nodes in one gateway cell before co-reception pairing is skipped for
 *  that gateway. Bounds the O(k^2) pair expansion on a metro gateway. [ours] */
export const GATEWAY_CELL_MAX_NODES = 64;
/** Max directional SNR samples one gateway-direct edge may contribute, so a
 *  chatty node cannot dominate an edge's SNR statistics. [ours] */
export const GATEWAY_SNR_SAMPLE_CAP = 25;

// ── B2 redundant router ─────────────────────────────────────────────────────
/** Minimum known direct neighbours on BOTH routers before B2 may fire. [ours] */
export const REDUNDANT_MIN_NEIGHBORS = 3;
/** Share of the smaller router's neighbour set the larger must cover. [ours] */
export const REDUNDANT_OVERLAP_RATIO = 0.9;

// ── B4 idle router ──────────────────────────────────────────────────────────
/** In-window corpus samples bracketing a router's area before B4 may fire. [ours] */
export const IDLE_ROUTER_MIN_AREA_PATHS = 20;
/** Hop share at/below which a router counts as idle. [ours] */
export const IDLE_ROUTER_MAX_HOP_SHARE = 0.01;
/** Peer hop share that must be EXCEEDED before idleness means anything. [ours] */
export const IDLE_ROUTER_PEER_MIN_HOP_SHARE = 0.10;

// ── B5 load-bearing CLIENT ──────────────────────────────────────────────────
/** Corpus samples with the node as an intermediate hop. [ours] */
export const LOAD_BEARING_MIN_TRACEROUTES = 10;
/** Share of the area's paths the node must carry. [ours] */
export const LOAD_BEARING_MIN_AREA_SHARE = 0.25;

// ── B6 hop horizon ───────────────────────────────────────────────────────────
/** Share of deduped observed packets arriving with hopLimit 0. [ours] */
export const HOP_HORIZON_EXHAUSTED_RATIO = 0.5;
/** Deduped observed packets before the ratio means anything. [ours] */
export const HOP_HORIZON_MIN_PACKETS = 20;

// ── B7 coverage shadow ──────────────────────────────────────────────────────
/** Positioned direct edges before a router's observed-range estimate is usable. [ours] */
export const COVERAGE_SHADOW_MIN_RANGE_SAMPLES = 3;
/** Hard ceiling on a router's observed-range estimate, metres — one freak
 *  tropo link must not swallow the whole mesh. [ours] */
export const COVERAGE_SHADOW_MAX_RANGE_M = 25_000;

// ── B1 router cluster ───────────────────────────────────────────────────────
/** Cluster size at/above which B1 is a warning. [ours] */
export const ROUTER_CLUSTER_WARNING_SIZE = 2;
/** Cluster size at/above which B1 is critical. [ours] */
export const ROUTER_CLUSTER_CRITICAL_SIZE = 4;

// ── Evidence hygiene ────────────────────────────────────────────────────────
/** Max entries in any evidence member/edge list. `mesh_issues.evidence` is
 *  MySQL TEXT (64 KB); a 200-router cluster with names would overflow it. [ours] */
export const EVIDENCE_MEMBER_LIST_CAP = 25;

/**
 * Roles that route at full priority and therefore form a B1 cluster.
 * ROUTER_LATE is deliberately EXCLUDED: it is the recommended remedy, so
 * counting it as a cluster member would make the fix re-raise the finding.
 */
export const CLUSTER_ROLES: ReadonlySet<number> = new Set([
  DeviceRole.ROUTER,
  DeviceRole.ROUTER_CLIENT,
  DeviceRole.REPEATER,
]);
