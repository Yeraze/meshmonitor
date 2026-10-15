/**
 * Shared helpers for automation trigger lists (#5808).
 */

/** Show search + type filter once a section has more triggers than this. */
export const TRIGGER_FILTER_THRESHOLD = 5;

/** Case-insensitive "does any of these strings contain the query". */
export function matchesSearch(query: string, ...fields: Array<string | undefined | null>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(q));
}

/** A fresh id for a draft trigger. */
export function newTriggerId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
