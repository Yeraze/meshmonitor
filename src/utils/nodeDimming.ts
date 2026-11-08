/**
 * Map-marker dimming by last-heard age. Shared by the Meshtastic Nodes tab and
 * the MeshCore map so both use one curve (#6258).
 *
 * Returns 1 up to `startHours`, then falls linearly to `minOpacity` at
 * `maxNodeAgeHours` (the end of the node window). No dimming when disabled,
 * when `lastHeardSec` is missing, or when the window is not wider than the
 * start threshold (this includes window 0 = "show all").
 */
export function calculateNodeOpacity(
  lastHeardSec: number | undefined,
  enabled: boolean,
  startHours: number,
  minOpacity: number,
  maxNodeAgeHours: number,
  nowMs: number = Date.now(),
): number {
  if (!enabled || !lastHeardSec) return 1;

  const ageHours = (nowMs - lastHeardSec * 1000) / (1000 * 60 * 60);

  // No dimming if node was heard within the start threshold
  if (ageHours <= startHours) return 1;

  const dimmingRange = maxNodeAgeHours - startHours;
  if (dimmingRange <= 0) return 1;

  const dimmingProgress = Math.min(1, (ageHours - startHours) / dimmingRange);

  // Linear interpolation from 1 to minOpacity
  return 1 - (dimmingProgress * (1 - minOpacity));
}
