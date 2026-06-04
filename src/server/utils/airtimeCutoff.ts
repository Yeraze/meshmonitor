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
