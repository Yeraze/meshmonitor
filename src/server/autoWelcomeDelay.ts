/**
 * Auto-welcome pre-send delay (#3439).
 *
 * After a nodeDB reset, many nodes broadcast NodeInfo at once. A DM welcome
 * sent the instant that packet arrives can land while the target's radio is
 * still finishing its own startup TX burst (not receive-ready), so it fails at
 * zero hops with no retry. Deferring the send by a few seconds lets the node
 * settle into receive mode. Configurable per source via `autoWelcomeDelay`.
 */
export const AUTO_WELCOME_DELAY_DEFAULT_SECONDS = 30;
export const AUTO_WELCOME_DELAY_MAX_SECONDS = 120;

/**
 * Resolve the stored `autoWelcomeDelay` setting to a clamped number of seconds.
 * Absent / invalid / negative values fall back to the default (30s) so the fix
 * applies to existing installs without re-saving settings. Values are capped at
 * 120s.
 */
export function resolveAutoWelcomeDelaySeconds(raw: string | null | undefined): number {
  if (raw == null || raw === '') return AUTO_WELCOME_DELAY_DEFAULT_SECONDS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return AUTO_WELCOME_DELAY_DEFAULT_SECONDS;
  return Math.min(n, AUTO_WELCOME_DELAY_MAX_SECONDS);
}
