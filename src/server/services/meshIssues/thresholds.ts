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

/** Consecutive clean runs before an open finding auto-closes. [ours]
 *  Default for `ResolvedMeshIssueThresholds.autoCloseCleanRuns` — the
 *  constant stays exported for callers/tests that want the default without
 *  resolving a full threshold set. */
export const AUTO_CLOSE_CLEAN_RUNS = 3;

// ── A5 telemetry-cadence clause (post-epic follow-up #4964) ────────────────
/** Minimum deduped broadcast TELEMETRY_APP samples in-window before A5's
 *  cadence clause may fire. [ours] */
export const A5_CADENCE_MIN_SAMPLES = 5;
/** Median broadcast-telemetry interval below which a dedicated router's
 *  cadence looks hand-edited, milliseconds. Real ROUTER/ROUTER_LATE defaults
 *  broadcast telemetry roughly every 12 h; anything under 2 h means someone
 *  shortened the interval. [ours] */
export const A5_TELEMETRY_MEDIAN_MS = 2 * 3600_000;

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
/** Max km between two POSITIONED nodes for their edge to count toward B1/B6
 *  cluster adjacency (#4976). B1 claims redundant same-spot coverage, and
 *  MQTT-bridged firmwares (TRON) record traceroute "hops" between repeaters
 *  100+ km apart that never happened over RF — carrying plausible SNR, so the
 *  sentinel filter cannot catch them. Distance is the only robust guard.
 *  Edges with an unpositioned endpoint are kept (fail-open). [ours] */
export const ROUTER_CLUSTER_MAX_LINK_KM = 30;

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

// ═══════════════════════════════════════════════════════════════════════════
// Threshold resolution seam (#4964, Phase 3 WP1)
// ═══════════════════════════════════════════════════════════════════════════

// ── C2 over-broadcasting ────────────────────────────────────────────────────
/** C2: deduped position/telemetry median inter-arrival below which a
 *  non-tracker node counts as over-broadcasting, seconds. [ours] */
export const OVER_BROADCAST_INTERVAL_SECONDS = 300;
/** C2: minimum deduped broadcasts in-window before a median means anything. [ours] */
export const OVER_BROADCAST_MIN_SAMPLES = 6;
/** C2: candidate gate multiplier for the stage-2 exact median (spec §2.5) —
 *  a node whose stage-1 MEAN inter-arrival is below
 *  `overBroadcastSeconds * OVER_BROADCAST_CANDIDATE_FACTOR` gets the exact
 *  (stage-2) median computed; a node offline for part of the window has an
 *  inflated mean, so this gate under-selects (safe direction, P3-D2). [ours] */
export const OVER_BROADCAST_CANDIDATE_FACTOR = 2;
/** Roles for which frequent position/telemetry broadcast is the intended
 *  behaviour and C2 must never fire. TAK_TRACKER joins TRACKER/SENSOR
 *  (P3-D6) — it is a tracker by design and excluding it would fire on every
 *  correctly configured ATAK node. */
export const OVER_BROADCAST_EXEMPT_ROLES: ReadonlySet<number> = new Set([
  DeviceRole.TRACKER,
  DeviceRole.SENSOR,
  DeviceRole.TAK_TRACKER,
]);
/** C2 severity multiplier: a median under
 *  `overBroadcastSeconds * OVER_BROADCAST_WARNING_SEVERITY_FACTOR` is a
 *  warning regardless of power state (spec §3.4 "under half the
 *  threshold"). [ours] */
export const OVER_BROADCAST_WARNING_SEVERITY_FACTOR = 0.5;

/**
 * The subset of thresholds a user can tune (#4964 Phase 3). Everything not in
 * this interface stays a code constant, documented in docs/features/mesh-issues.md.
 */
export interface ResolvedMeshIssueThresholds {
  tierAEnabled: boolean;
  tierBEnabled: boolean;
  tierCEnabled: boolean;
  b7Enabled: boolean;
  /** percent, [official] */ airUtilTxPct: number;
  /** percent, [official] */ channelUtilPct: number;
  /** metres, [ours] */ mobileSpanMeters: number;
  /** dB, [ours] */ snrAsymmetryDb: number;
  /** seconds, [ours] */ overBroadcastSeconds: number;
  /** count, [ours] */ autoCloseCleanRuns: number;
  /** km, [ours] */ routerClusterMaxLinkKm: number;
}

export const DEFAULT_MESH_ISSUE_THRESHOLDS: ResolvedMeshIssueThresholds = {
  tierAEnabled: true,
  tierBEnabled: true,
  tierCEnabled: true,
  b7Enabled: true,
  airUtilTxPct: AIR_UTIL_TX_PCT_THRESHOLD,
  channelUtilPct: CHANNEL_UTIL_PCT_THRESHOLD,
  mobileSpanMeters: MOBILE_SPAN_METERS,
  snrAsymmetryDb: ASYMMETRY_DELTA_DB,
  overBroadcastSeconds: OVER_BROADCAST_INTERVAL_SECONDS,
  autoCloseCleanRuns: AUTO_CLOSE_CLEAN_RUNS,
  routerClusterMaxLinkKm: ROUTER_CLUSTER_MAX_LINK_KM,
};

/**
 * Raw settings keys `resolveThresholds` consumes. Exported as a single source
 * of truth for the key list, so `meshIssuesAnalysisService.ts` (resolves once
 * per run) and `meshIssuesScheduler.ts` (resolves for `getStatus()`) never
 * drift apart on which keys make up a threshold map. [ours]
 */
export const MESH_ISSUE_THRESHOLD_SETTINGS_KEYS = [
  'mesh_issues_tier_a_enabled',
  'mesh_issues_tier_b_enabled',
  'mesh_issues_tier_c_enabled',
  'mesh_issues_b7_enabled',
  'mesh_issues_air_util_tx_pct',
  'mesh_issues_channel_util_pct',
  'mesh_issues_mobile_span_meters',
  'mesh_issues_snr_asymmetry_db',
  'mesh_issues_over_broadcast_seconds',
  'mesh_issues_auto_close_runs',
  'mesh_issues_router_cluster_max_link_km',
] as const;

/** Accepts both a raw settings string and a plain number (tests call this
 *  directly). Mirrors `meshIssuesScheduler.ts`'s local `parseNumeric`. */
function parseNumeric(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return parseFloat(raw);
  return NaN;
}

/** Same clamp doctrine as `clampLookbackHours`: unparseable falls back to
 *  `defaultValue` (NOT a bound), a finite out-of-range value clamps to the
 *  nearer bound. */
function resolveClampedNumber(
  raw: Record<string, unknown>,
  key: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const value = parseNumeric(raw[key]);
  if (!Number.isFinite(value)) return defaultValue;
  return Math.min(max, Math.max(min, value));
}

/** Default-ON: only the exact string 'false' disables. Every other value
 *  (including '', '0', a non-'false' string, undefined, or a non-string)
 *  leaves the toggle enabled. */
function resolveBooleanDefaultOn(raw: Record<string, unknown>, key: string): boolean {
  return raw[key] !== 'false';
}

/**
 * Pure. `raw` is a settings key -> raw value map (string | number | null),
 * keyed by `MESH_ISSUE_THRESHOLD_SETTINGS_KEYS`. Unparseable or missing falls
 * back to the default; a finite out-of-range value clamps to the nearer bound
 * (same doctrine as `clampLookbackHours`). Booleans are default-ON: only the
 * exact string 'false' disables. Always returns a fresh object — never the
 * shared `DEFAULT_MESH_ISSUE_THRESHOLDS` instance — so a caller mutating the
 * result cannot corrupt the default.
 */
export function resolveThresholds(raw: Record<string, unknown>): ResolvedMeshIssueThresholds {
  return {
    tierAEnabled: resolveBooleanDefaultOn(raw, 'mesh_issues_tier_a_enabled'),
    tierBEnabled: resolveBooleanDefaultOn(raw, 'mesh_issues_tier_b_enabled'),
    tierCEnabled: resolveBooleanDefaultOn(raw, 'mesh_issues_tier_c_enabled'),
    b7Enabled: resolveBooleanDefaultOn(raw, 'mesh_issues_b7_enabled'),
    airUtilTxPct: resolveClampedNumber(
      raw,
      'mesh_issues_air_util_tx_pct',
      DEFAULT_MESH_ISSUE_THRESHOLDS.airUtilTxPct,
      1,
      50
    ),
    channelUtilPct: resolveClampedNumber(
      raw,
      'mesh_issues_channel_util_pct',
      DEFAULT_MESH_ISSUE_THRESHOLDS.channelUtilPct,
      5,
      100
    ),
    mobileSpanMeters: resolveClampedNumber(
      raw,
      'mesh_issues_mobile_span_meters',
      DEFAULT_MESH_ISSUE_THRESHOLDS.mobileSpanMeters,
      50,
      50_000
    ),
    snrAsymmetryDb: resolveClampedNumber(
      raw,
      'mesh_issues_snr_asymmetry_db',
      DEFAULT_MESH_ISSUE_THRESHOLDS.snrAsymmetryDb,
      1,
      30
    ),
    overBroadcastSeconds: resolveClampedNumber(
      raw,
      'mesh_issues_over_broadcast_seconds',
      DEFAULT_MESH_ISSUE_THRESHOLDS.overBroadcastSeconds,
      30,
      3600
    ),
    autoCloseCleanRuns: resolveClampedNumber(
      raw,
      'mesh_issues_auto_close_runs',
      DEFAULT_MESH_ISSUE_THRESHOLDS.autoCloseCleanRuns,
      1,
      20
    ),
    routerClusterMaxLinkKm: resolveClampedNumber(
      raw,
      'mesh_issues_router_cluster_max_link_km',
      DEFAULT_MESH_ISSUE_THRESHOLDS.routerClusterMaxLinkKm,
      1,
      500
    ),
  };
}
