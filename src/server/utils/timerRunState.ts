/**
 * Timer trigger run state belongs to the server (#5827).
 *
 * A timer's `lastRun`, `lastResult` and `lastError` are written by the
 * scheduler each time it fires. The settings page loads the trigger list once
 * and posts the whole list back on save, so a save sent the page's stale copy
 * of those fields and overwrote a newer run the server had recorded since.
 *
 * On save, take the run state from the stored copy of each trigger (matched by
 * id) and ignore what the client sent. A new trigger has no stored copy, so it
 * starts with no run state.
 */

const RUN_STATE_KEYS = ['lastRun', 'lastResult', 'lastError'] as const;

type TriggerLike = { id?: unknown } & Record<string, unknown>;

export function keepServerRunState<T>(incoming: T[], stored: unknown): T[] {
  const storedById = new Map<unknown, TriggerLike>();
  if (Array.isArray(stored)) {
    for (const t of stored) {
      if (t && typeof t === 'object' && (t as TriggerLike).id !== undefined) {
        storedById.set((t as TriggerLike).id, t as TriggerLike);
      }
    }
  }
  return incoming.map((trigger) => {
    if (!trigger || typeof trigger !== 'object') return trigger;
    const next = { ...(trigger as TriggerLike) };
    for (const key of RUN_STATE_KEYS) delete next[key];
    const prev = storedById.get(next.id);
    if (prev) {
      for (const key of RUN_STATE_KEYS) {
        if (prev[key] !== undefined) next[key] = prev[key];
      }
    }
    return next as T;
  });
}

/** Parse a stored trigger list, treating anything unreadable as empty. */
export function parseStoredTriggers(json: string | null | undefined): unknown[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
