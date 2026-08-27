/**
 * Resolve the effective "maximum age" (in hours) used to filter the map.
 *
 * The Map Features age slider (`mapMaxAgeHours`) is `null` when the user hasn't
 * moved it — the map then follows the source's `maxNodeAgeHours` setting
 * (per-source since #4412 Phase 3; the slider's default position). A concrete
 * value is clamped to
 * `[1, settingsMaxAgeHours]` so it can never exceed the configured maximum
 * (e.g. after the operator lowers the setting below a previously-saved value).
 *
 * See #3322.
 */
export function effectiveMapMaxAgeHours(
  mapMaxAgeHours: number | null | undefined,
  settingsMaxAgeHours: number,
): number {
  // `maxNodeAgeHours` of 0 means "never / show all" (#4947). The effective cap
  // is then unbounded (Infinity): the map slider can still narrow it to a finite
  // value, but its default ("All") position follows the setting = no cutoff.
  // Downstream cutoffs (`now - hours*3600`) evaluate to -Infinity, so every node
  // passes without any per-site special-casing.
  const settingsMax = settingsMaxAgeHours <= 0 ? Infinity : Math.max(1, settingsMaxAgeHours);
  if (mapMaxAgeHours == null || !Number.isFinite(mapMaxAgeHours)) return settingsMax;
  return Math.min(Math.max(1, mapMaxAgeHours), settingsMax);
}
