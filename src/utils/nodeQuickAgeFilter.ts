/**
 * Nodes tab quick age filter (#5387).
 *
 * A view-only lens over the Settings node window (`maxNodeAgeHours`). The
 * viewer picks a window on the Nodes tab (1d / 3d / 7d / 30d / all) and the
 * Nodes list + map use it INSTEAD of the Settings window. It never writes the
 * setting, and never reaches the server: the choice lives in this browser's
 * localStorage only.
 *
 * Semantics: the quick filter OVERRIDES the Settings window for display. It
 * can widen it (7d when Settings says 24h) as well as narrow it, because the
 * poll already delivers every node for the source and filters client-side.
 * `null` = "Setting", which restores the Settings window exactly.
 *
 * Only the Nodes tab reads it. Background jobs, the Messages tab, the unified
 * dashboard map, and the server keep using the Settings window.
 */

/** A quick-filter choice: hours, 0 = all (no cutoff), or null = follow Settings. */
export type NodeQuickAgeHours = number | null;

/** The windows offered, in hours. 0 = all (no cutoff). */
export const NODE_QUICK_AGE_OPTIONS: readonly number[] = [24, 72, 168, 720, 0];

export const NODE_QUICK_AGE_STORAGE_KEY = 'nodesQuickAgeHours';

/** Accept only one of the offered windows; anything else reads as "Setting". */
export function parseNodeQuickAgeHours(raw: string | null | undefined): NodeQuickAgeHours {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return NODE_QUICK_AGE_OPTIONS.includes(n) ? n : null;
}

/**
 * The window the Nodes tab filters by: the quick choice when one is picked,
 * else the Settings window. 0 (either source) = no cutoff (#4947).
 */
export function resolveNodeListAgeHours(
  quickHours: NodeQuickAgeHours,
  settingsHours: number,
): number {
  return quickHours == null ? settingsHours : quickHours;
}

export function readNodeQuickAgeHours(): NodeQuickAgeHours {
  try {
    return parseNodeQuickAgeHours(localStorage.getItem(NODE_QUICK_AGE_STORAGE_KEY));
  } catch {
    // Private mode / blocked storage: fall back to the Settings window.
    return null;
  }
}

export function writeNodeQuickAgeHours(hours: NodeQuickAgeHours): void {
  try {
    if (hours == null) localStorage.removeItem(NODE_QUICK_AGE_STORAGE_KEY);
    else localStorage.setItem(NODE_QUICK_AGE_STORAGE_KEY, String(hours));
  } catch {
    // Storage unavailable: the choice still applies for this page load.
  }
}
