/**
 * Deterministic numeric formatting for the UI.
 *
 * Bare `toLocaleString()` follows the *host OS* locale, so the same data
 * renders as `2,134` on an English machine and `2.134` on a German one —
 * which broke `PacketStatsChart`/`MqttViolationsReport` on non-US systems.
 * In a data-dense dashboard a locale whose thousands separator is also its
 * decimal separator (German `2.134`) is additionally ambiguous next to real
 * decimals, so counts are pinned to `en-US` separators regardless of locale.
 *
 * This mirrors the precedent set by `MeshCoreAutoAnnounceSection`
 * (`toLocaleDateString('en-US')`) rather than following the active UI
 * language, which would still change the separator for `de` users.
 */

let countFormatter: Intl.NumberFormat | undefined;

function getCountFormatter(): Intl.NumberFormat {
  if (!countFormatter) {
    countFormatter = new Intl.NumberFormat('en-US');
  }
  return countFormatter;
}

/**
 * Format a whole number with `en-US` thousands separators (`2134` → `2,134`).
 * Returns `''` for non-finite input so it can be used directly in labels.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '';
  return getCountFormatter().format(value);
}
