/**
 * Airtime-cutoff gating for automations.
 *
 * When the locally-connected node's self-reported Channel Utilization (ChUtil)
 * exceeds a configured threshold, all transmitting automations (auto-traceroute,
 * auto-announce, timers, etc.) are paused so they don't add to mesh congestion
 * while real traffic is heavy. Automations resume automatically once utilization
 * drops back under the threshold.
 *
 * Implements: https://github.com/Yeraze/meshmonitor/issues (airtime cutoff)
 */

import { INFRASTRUCTURE_ROLES } from '../../utils/nodeRoleMarker.js';

/** Default cutoff threshold (percent Channel Utilization) when unset. */
export const DEFAULT_AIRTIME_CUTOFF_THRESHOLD = 30;

/**
 * Where the airtime cutoff reads Channel Utilization from:
 *  - `local`     — the locally-connected node's own self-reported ChUtil (default)
 *  - `neighbors` — the average ChUtil of the strongest-RSSI 0-hop infrastructure
 *                  (router-role) neighbours, for nodes whose local ChUtil
 *                  under-represents the mesh (e.g. a well-placed/quiet node).
 */
export type AirtimeCutoffSource = 'local' | 'neighbors';

/** Default measurement source. */
export const DEFAULT_AIRTIME_CUTOFF_SOURCE: AirtimeCutoffSource = 'local';

/**
 * Default number of infrastructure neighbours to average (issue #6007: now
 * user-set, clamped to [MIN_NEIGHBOR_UTIL_SAMPLE_COUNT, MAX_NEIGHBOR_UTIL_SAMPLE_COUNT]).
 */
export const NEIGHBOR_UTIL_SAMPLE_COUNT = 3;

/** Lowest sample count a user may set (issue #6007). */
export const MIN_NEIGHBOR_UTIL_SAMPLE_COUNT = 3;

/** Highest sample count a user may set (issue #6007). */
export const MAX_NEIGHBOR_UTIL_SAMPLE_COUNT = 5;

/**
 * How the infrastructure neighbours are chosen (issue #6007):
 *  - `auto`   — the strongest-RSSI candidates within maxHops (the original behaviour)
 *  - `manual` — exactly the nodes the user picked
 */
export type NeighborSelectionMode = 'auto' | 'manual';

/** Default selection mode. Existing installs stay on `auto`. */
export const DEFAULT_NEIGHBOR_SELECTION_MODE: NeighborSelectionMode = 'auto';

/**
 * A picked node's ChUtil counts as fresh when its newest `channelUtilization`
 * telemetry sample is at most this old. Device metrics broadcast every 30 min
 * by default, and firmware stretches that interval on busy meshes, so 3 hours
 * allows for a few missed or stretched broadcasts while still dropping a node
 * that has gone quiet (issue #6007).
 */
export const NEIGHBOR_UTIL_FRESH_MS = 3 * 60 * 60 * 1000;

/** Clamp a sample count to the allowed [3, 5] range; non-numbers get the default. */
export function clampNeighborSampleCount(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) return NEIGHBOR_UTIL_SAMPLE_COUNT;
  return Math.max(MIN_NEIGHBOR_UTIL_SAMPLE_COUNT, Math.min(MAX_NEIGHBOR_UTIL_SAMPLE_COUNT, Math.floor(n)));
}

/**
 * Parse a stored manual node list (a JSON array of node numbers). Returns the
 * unique, valid node numbers in order; anything unparseable yields [].
 */
export function parseManualNeighborNodes(raw: unknown): number[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return [];
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: number[] = [];
  for (const v of arr) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
    if (Number.isInteger(n) && n > 0 && n <= 0xffffffff && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Default maximum `hopsAway` a router may be reached at and still qualify as
 * a neighbour candidate. 0 means "directly heard only" — the strict behaviour
 * that shipped originally. Raise via settings to include routers reached
 * through a relay (issue #4801, Scenario A: a CLIENT_BASE node relays to
 * routers, so at the MeshMonitor-connected node they arrive as hopsAway=1).
 */
export const DEFAULT_NEIGHBOR_UTIL_MAX_HOPS = 0;

/**
 * Firmware-side hop cap; matches Meshtastic's default `hop_limit` ceiling.
 * The UI clamps user input to this range. The pure utility does not clamp,
 * so tests can pass any value.
 */
export const MAX_NEIGHBOR_UTIL_MAX_HOPS = 7;

/**
 * Device roles considered routing "infrastructure" (Meshtastic
 * Config.DeviceConfig.Role): Router (2), Router Client (3, deprecated),
 * Repeater (4, deprecated), Router Late (11), Client Base (12). Client Base
 * retransmits like Router Late, so it counts as infrastructure too.
 *
 * Defined once in `src/utils/nodeRoleMarker.ts` and shared with the map
 * markers (#6008), so the two cannot drift.
 */
export { INFRASTRUCTURE_ROLES };

/** A node considered as a possible infrastructure neighbour. */
export interface NeighborUtilCandidate {
  nodeNum?: number | null;
  nodeId?: string | null;
  longName?: string | null;
  shortName?: string | null;
  role?: number | null;
  hopsAway?: number | null;
  rssi?: number | null;
  channelUtilization?: number | null;
  /** Epoch ms of the newest `channelUtilization` sample, when known (issue #6007). */
  channelUtilizationAt?: number | null;
  /** Heard over MQTT: its ChUtil describes a different RF area, so never counted (issue #6007). */
  viaMqtt?: boolean | number | null;
}

/** An infrastructure neighbour that contributed to the averaged ChUtil. */
export interface NeighborUtilContributor {
  nodeNum: number | null;
  nodeId: string | null;
  longName: string | null;
  shortName: string | null;
  /** Null only for a manual pick that has no RSSI reading (manual mode does not rank by RSSI). */
  rssi: number | null;
  channelUtilization: number;
}

/** Whether a candidate was heard over MQTT. */
export function isViaMqtt(n: NeighborUtilCandidate): boolean {
  return n.viaMqtt === true || n.viaMqtt === 1;
}

/** An infrastructure role, not MQTT-heard: what the manual picker may list (issue #6007). */
export function isPickableInfrastructureNode(n: NeighborUtilCandidate): boolean {
  return n.role != null && INFRASTRUCTURE_ROLES.has(n.role) && !isViaMqtt(n);
}

/**
 * Average the Channel Utilization of the strongest-RSSI infrastructure
 * neighbours. Candidates must be an infrastructure role, not heard over MQTT
 * (issue #6007), reached within
 * `maxHops` (default 0, i.e. directly heard), and have both an RSSI and a
 * Channel Utilization reading. The strongest `count` (highest / least-negative
 * RSSI) are averaged.
 *
 * @param nodes Candidate neighbours.
 * @param count How many top candidates to average. Defaults to
 *   `NEIGHBOR_UTIL_SAMPLE_COUNT`.
 * @param maxHops Highest `hopsAway` that still qualifies. Defaults to
 *   `DEFAULT_NEIGHBOR_UTIL_MAX_HOPS` (0). Set to 1 or more via user setting
 *   to admit relayed routers (issue #4801). The utility itself does not
 *   clamp; the UI enforces the `[0, MAX_NEIGHBOR_UTIL_MAX_HOPS]` range.
 *
 * @returns the averaged ChUtil (or null if no candidate qualifies), how many
 *   neighbours contributed to the average, and the contributing nodes
 *   themselves (strongest RSSI first).
 */
export function averageStrongestNeighborUtilization(
  nodes: NeighborUtilCandidate[],
  count: number = NEIGHBOR_UTIL_SAMPLE_COUNT,
  maxHops: number = DEFAULT_NEIGHBOR_UTIL_MAX_HOPS
): { value: number | null; sampleCount: number; contributors: NeighborUtilContributor[] } {
  const candidates = nodes.filter(
    (n) =>
      isPickableInfrastructureNode(n) &&
      typeof n.hopsAway === 'number' &&
      Number.isFinite(n.hopsAway) &&
      n.hopsAway >= 0 &&
      n.hopsAway <= maxHops &&
      typeof n.rssi === 'number' &&
      Number.isFinite(n.rssi) &&
      typeof n.channelUtilization === 'number' &&
      Number.isFinite(n.channelUtilization)
  );

  // Strongest RSSI first (higher dBm = stronger, e.g. -50 beats -90).
  candidates.sort((a, b) => (b.rssi as number) - (a.rssi as number));

  const top = candidates.slice(0, Math.max(0, count));
  if (top.length === 0) return { value: null, sampleCount: 0, contributors: [] };

  const contributors: NeighborUtilContributor[] = top.map((n) => ({
    nodeNum: n.nodeNum ?? null,
    nodeId: n.nodeId ?? null,
    longName: n.longName ?? null,
    shortName: n.shortName ?? null,
    rssi: n.rssi as number,
    channelUtilization: n.channelUtilization as number,
  }));

  const sum = top.reduce((acc, n) => acc + (n.channelUtilization as number), 0);
  return { value: sum / top.length, sampleCount: top.length, contributors };
}

const toContributor = (n: NeighborUtilCandidate): NeighborUtilContributor => ({
  nodeNum: n.nodeNum ?? null,
  nodeId: n.nodeId ?? null,
  longName: n.longName ?? null,
  shortName: n.shortName ?? null,
  rssi: typeof n.rssi === 'number' && Number.isFinite(n.rssi) ? n.rssi : null,
  channelUtilization: n.channelUtilization as number,
});

/** Why a manually picked node was left out of the average (issue #6007). */
export type ManualPickSkipReason = 'not_found' | 'mqtt' | 'not_infrastructure' | 'stale';

export interface SkippedNeighbor {
  nodeNum: number;
  nodeId: string | null;
  longName: string | null;
  shortName: string | null;
  reason: ManualPickSkipReason;
}

/**
 * Why the local node's own ChUtil was used (issue #6007):
 *  - `no_neighbors`  — no infrastructure node qualified, so local stands in
 *  - `higher_than_neighbors` — fewer nodes qualified than wanted and local
 *                      read higher than their average
 */
export type LocalFillReason = 'no_neighbors' | 'higher_than_neighbors';

export interface NeighborUtilResult {
  /** The value the gate compares against, or null when nothing is known. */
  value: number | null;
  /** How many infrastructure nodes contributed to `neighborAverage`. */
  sampleCount: number;
  contributors: NeighborUtilContributor[];
  /** How many nodes the average wanted: the sample count (auto) or the pick count (manual). */
  targetCount: number;
  /** Average of the contributing nodes alone, or null when none qualified. */
  neighborAverage: number | null;
  /** The local ChUtil seen at computation time. */
  localChannelUtilization: number | null;
  /** Set when the local ChUtil was used in place of the neighbour average. */
  localUsed: LocalFillReason | null;
  /** Manual picks left out, with the reason. Always empty in auto mode. */
  skipped: SkippedNeighbor[];
}

export interface NeighborUtilOptions {
  mode: NeighborSelectionMode;
  /** Auto mode: how many strongest nodes to average (clamped to 3-5). */
  sampleCount: number;
  /** Auto mode: highest hopsAway that qualifies. Ignored in manual mode. */
  maxHops: number;
  /** Manual mode: the picked node numbers. */
  manualNodeNums: readonly number[];
  /** The local node's own ChUtil, or null when unknown. */
  localChannelUtilization: number | null;
  /** Clock for the manual freshness check (epoch ms). */
  now: number;
  /** Manual freshness window; defaults to NEIGHBOR_UTIL_FRESH_MS. */
  freshMs?: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The Channel Utilization the airtime cutoff compares against when it reads
 * from infrastructure neighbours (issue #6007).
 *
 * Under-reading lets automations keep sending on a busy channel, so every rule
 * here leans toward the real local load:
 *  - MQTT-heard nodes never count, in either mode.
 *  - Auto: the strongest-RSSI `sampleCount` candidates (as before).
 *  - Manual: only the picked nodes; a pick that is gone, MQTT-heard, no longer
 *    infrastructure, or has no ChUtil sample within `freshMs` is skipped and
 *    reported in `skipped`.
 *  - Fill the gap: when fewer nodes qualify than wanted, the result is
 *    max(local ChUtil, their average); with none qualifying it is the local
 *    ChUtil. Unknown local ChUtil keeps the older behaviour (the average, or
 *    null with no data).
 */
export function computeNeighborUtilization(
  nodes: NeighborUtilCandidate[],
  opts: NeighborUtilOptions,
): NeighborUtilResult {
  const local = finite(opts.localChannelUtilization) ? opts.localChannelUtilization : null;
  let contributors: NeighborUtilContributor[];
  let targetCount: number;
  const skipped: SkippedNeighbor[] = [];

  if (opts.mode === 'manual') {
    const freshMs = opts.freshMs ?? NEIGHBOR_UTIL_FRESH_MS;
    const picks = opts.manualNodeNums;
    targetCount = Math.max(MIN_NEIGHBOR_UTIL_SAMPLE_COUNT, picks.length);
    contributors = [];
    for (const nodeNum of picks) {
      const n = nodes.find((c) => c.nodeNum != null && Number(c.nodeNum) === nodeNum);
      const skip = (reason: ManualPickSkipReason) =>
        skipped.push({
          nodeNum,
          nodeId: n?.nodeId ?? null,
          longName: n?.longName ?? null,
          shortName: n?.shortName ?? null,
          reason,
        });
      if (!n) { skip('not_found'); continue; }
      if (isViaMqtt(n)) { skip('mqtt'); continue; }
      if (n.role == null || !INFRASTRUCTURE_ROLES.has(n.role)) { skip('not_infrastructure'); continue; }
      if (
        !finite(n.channelUtilization) ||
        !finite(n.channelUtilizationAt) ||
        opts.now - n.channelUtilizationAt > freshMs
      ) {
        skip('stale');
        continue;
      }
      contributors.push(toContributor(n));
    }
  } else {
    targetCount = clampNeighborSampleCount(opts.sampleCount);
    contributors = averageStrongestNeighborUtilization(nodes, targetCount, opts.maxHops).contributors;
  }

  const neighborAverage = contributors.length > 0
    ? contributors.reduce((acc, c) => acc + c.channelUtilization, 0) / contributors.length
    : null;

  let value = neighborAverage;
  let localUsed: LocalFillReason | null = null;
  if (contributors.length < targetCount && local != null) {
    if (neighborAverage == null) {
      value = local;
      localUsed = 'no_neighbors';
    } else if (local > neighborAverage) {
      value = local;
      localUsed = 'higher_than_neighbors';
    }
  }

  return {
    value,
    sampleCount: contributors.length,
    contributors,
    targetCount,
    neighborAverage,
    localChannelUtilization: local,
    localUsed,
    skipped,
  };
}

/**
 * Decide whether automations should be gated (paused) right now.
 *
 * Fail-open by design:
 *  - threshold <= 0 disables the feature entirely (never gate).
 *  - a null/undefined utilization (no telemetry yet) never gates.
 *
 * @param channelUtilization local node's most recent ChUtil percent, or null if unknown
 * @param threshold cutoff percent; <= 0 disables gating
 * @returns true when automations should be suppressed
 */
export function shouldGateAutomations(
  channelUtilization: number | null | undefined,
  threshold: number
): boolean {
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  if (channelUtilization == null || !Number.isFinite(channelUtilization)) return false;
  return channelUtilization > threshold;
}
