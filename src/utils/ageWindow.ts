/**
 * Shared wording for node-age windows (#5344).
 *
 * Three controls describe "how far back" MeshMonitor looks: the Settings
 * node window (`maxNodeAgeHours`), the Map Features age filter, and the fixed
 * 2h sidebar activity stat. They all render durations through
 * {@link formatAgeDuration} so the Nodes header, the map slider, and its
 * "All (… from Settings)" stop read the same way.
 *
 * A window of 0, a negative value, a non-finite value, or no value at all means
 * "no cutoff / show all" (#4947, #5338).
 */

/** Minimal i18next-compatible translate signature. */
export type AgeWindowTranslate = (key: string, options?: Record<string, unknown>) => string;

/** True when `hours` means "no cutoff" (unset, ≤ 0, NaN, or Infinity). */
export function isUnlimitedAgeWindow(hours: number | null | undefined): boolean {
  return hours == null || !Number.isFinite(hours) || hours <= 0;
}

/**
 * Compact duration for a finite, positive window: `30m`, `6h`, `24h`, `3d`,
 * `1d 6h`. Sub-hour values read as minutes; anything under two days stays in
 * hours (so the common 24h default reads "24h", not "1d"); longer values read
 * as days, with trailing hours only when not a whole number of days.
 */
export function formatAgeDuration(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  const h = Math.round(hours);
  if (h < 48) return `${h}h`;
  const days = Math.floor(h / 24);
  const rem = h % 24;
  return rem === 0 ? `${days}d` : `${days}d ${rem}h`;
}

/**
 * Human label for an age window: "last 6h", or "all" when unlimited.
 * Pass the component's `t` so the words localise.
 */
export function formatAgeWindow(hours: number | null | undefined, t: AgeWindowTranslate): string {
  if (isUnlimitedAgeWindow(hours)) return t('age_window.all', { defaultValue: 'all' });
  return t('age_window.last', {
    duration: formatAgeDuration(hours as number),
    defaultValue: 'last {{duration}}',
  });
}
