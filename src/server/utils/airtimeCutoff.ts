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

/** How many of the strongest-RSSI infrastructure neighbours to average. */
export const NEIGHBOR_UTIL_SAMPLE_COUNT = 3;

/**
 * Device roles considered routing "infrastructure" (Meshtastic
 * Config.DeviceConfig.Role): Router (2), Router Client (3, deprecated),
 * Repeater (4, deprecated), Router Late (11).
 */
export const INFRASTRUCTURE_ROLES: ReadonlySet<number> = new Set([2, 3, 4, 11]);

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
}

/** An infrastructure neighbour that contributed to the averaged ChUtil. */
export interface NeighborUtilContributor {
  nodeNum: number | null;
  nodeId: string | null;
  longName: string | null;
  shortName: string | null;
  rssi: number;
  channelUtilization: number;
}

/**
 * Average the Channel Utilization of the strongest-RSSI 0-hop infrastructure
 * neighbours. Candidates must be an infrastructure role, directly heard
 * (`hopsAway === 0`), and have both an RSSI and a Channel Utilization reading.
 * The strongest `count` (highest/least-negative RSSI) are averaged.
 *
 * @returns the averaged ChUtil (or null if no candidate qualifies), how many
 *   neighbours contributed to the average, and the contributing nodes
 *   themselves (strongest RSSI first).
 */
export function averageStrongestNeighborUtilization(
  nodes: NeighborUtilCandidate[],
  count: number = NEIGHBOR_UTIL_SAMPLE_COUNT
): { value: number | null; sampleCount: number; contributors: NeighborUtilContributor[] } {
  const candidates = nodes.filter(
    (n) =>
      n.role != null &&
      INFRASTRUCTURE_ROLES.has(n.role) &&
      n.hopsAway === 0 &&
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
