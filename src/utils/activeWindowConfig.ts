/**
 * Browser-side mirror of the user's `maxNodeAgeHours` "active window" setting,
 * for code that classifies node transports outside React context (#4240).
 *
 * Mirrors `positionDisplayConfig`: SettingsContext keeps this module in sync
 * (synchronously in its setter, on server load, and at boot), and non-context
 * call sites read it via {@link getActiveWindowHours}.
 *
 * Transport decay needs this value in `useAnalysisNodes`, which feeds several
 * Map Analysis components. Reading it from SettingsContext there would make a
 * pure data hook depend on a UI provider, forcing every consumer — and every
 * consumer's tests — to wrap or stub SettingsProvider. Components that already
 * have the value in scope (DashboardMap, NodesTab, App) should keep passing it
 * explicitly rather than reading this mirror.
 *
 * Default matches SettingsContext's own default so a read before first sync
 * behaves identically to the configured default.
 */

const DEFAULT_MAX_NODE_AGE_HOURS = 24;

let maxNodeAgeHours = DEFAULT_MAX_NODE_AGE_HOURS;

/** Current active window, in hours. */
export function getActiveWindowHours(): number {
  return maxNodeAgeHours;
}

/** Sync the cached window (called by SettingsContext on set + server load). */
export function setActiveWindowHours(hours: number): void {
  if (Number.isFinite(hours) && hours > 0) maxNodeAgeHours = hours;
}
