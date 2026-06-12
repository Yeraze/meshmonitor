/**
 * Resolve the effective "maximum age" (in hours) used to filter the map.
 *
 * The Map Features age slider (`mapMaxAgeHours`) is `null` when the user hasn't
 * moved it — the map then follows the global `maxNodeAgeHours` setting (the
 * slider's default position). A concrete value is clamped to
 * `[1, settingsMaxAgeHours]` so it can never exceed the configured maximum
 * (e.g. after the operator lowers the setting below a previously-saved value).
 *
 * See #3322.
 */
export function effectiveMapMaxAgeHours(
  mapMaxAgeHours: number | null | undefined,
  settingsMaxAgeHours: number,
): number {
  const settingsMax = Math.max(1, settingsMaxAgeHours);
  if (mapMaxAgeHours == null || !Number.isFinite(mapMaxAgeHours)) return settingsMax;
  return Math.min(Math.max(1, mapMaxAgeHours), settingsMax);
}
