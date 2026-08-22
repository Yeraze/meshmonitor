/**
 * Reboot detection for Device Health (#4558 Phase B).
 *
 * A node's uptime counter is MONOTONIC during normal operation — every fresh
 * reading is larger than the last by roughly the telemetry reporting interval.
 * The only way it can DECREASE is a restart, which resets it to near zero, so a
 * reboot is simply "the new uptime reading is lower than the prior stored one".
 *
 * The prior value is read from the telemetry table (persistent), NOT an
 * in-memory baseline — that is the restart-safety mechanism (CLAUDE.md mesh
 * -impact checklist §3): a MeshMonitor process restart cannot spuriously fire a
 * reboot, because the baseline is the durable DB row rather than lost state.
 * Detection reads the DB only; it sends no packets, so it costs zero airtime.
 */

/**
 * Jitter slack (seconds). Uptime should only ever grow, so ANY decrease is
 * anomalous; this slack only absorbs trivial rounding or a slightly
 * out-of-order reading (a few seconds). A genuine reboot drops uptime by
 * minutes to days, so a small 10s slack cleanly separates a real reset from
 * noise without needing a per-node baseline. Deliberately small (CLAUDE.md
 * asks for a documented slack): making it larger would risk masking a reboot of
 * a node that had only been up a short while.
 */
export const REBOOT_UPTIME_SLACK_SECONDS = 10;

/**
 * True when `newUptimeSeconds` represents a reboot relative to the prior stored
 * uptime — i.e. a real decrease beyond the jitter slack. A missing / non-finite
 * prior (first-ever reading for a node) never counts as a reboot: with no
 * baseline there is no transition to detect.
 */
export function isUptimeReboot(
  priorUptimeSeconds: number | null | undefined,
  newUptimeSeconds: number,
  slackSeconds: number = REBOOT_UPTIME_SLACK_SECONDS,
): boolean {
  if (priorUptimeSeconds == null || !Number.isFinite(priorUptimeSeconds)) return false;
  if (!Number.isFinite(newUptimeSeconds)) return false;
  return newUptimeSeconds + slackSeconds < priorUptimeSeconds;
}
