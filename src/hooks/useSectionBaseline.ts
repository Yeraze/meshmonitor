import { useCallback, useState } from 'react';

/**
 * The "saved" side of a SaveBar section (#5797): the values the node is known
 * to hold, kept in state so a change to it re-renders the section.
 *
 * The baseline moves only when the caller says so:
 *   - `commit(values)` after a save the node accepted (never after a failed one);
 *   - a new `reseedKey` (Reload config bumps it), which takes the current values,
 *     except the `keepOnReseed` keys, which a reload does not refresh.
 *
 * It never saves anything itself: no effect here calls back into the section.
 */
type Values = Record<string, unknown>;

export interface SectionBaselineOptions<T extends Values> {
  /** Changes when the parent has just reloaded these values from the node. */
  reseedKey?: unknown;
  /** Keys the reload does not refresh, so their baseline stays put. */
  keepOnReseed?: readonly (keyof T)[];
}

export interface SectionBaseline<T extends Values> {
  /** What Dismiss goes back to. */
  baseline: T;
  /** True when any value differs from the baseline. */
  hasChanges: boolean;
  /** Make these values the baseline. Call only after the node accepted them. */
  commit: (values: T) => void;
}

const snapshot = <T extends Values>(values: T): T => {
  const copy = { ...values };
  for (const key of Object.keys(copy)) {
    const v = copy[key];
    if (Array.isArray(v)) (copy as Values)[key] = [...v];
  }
  return copy;
};

// Scalars by value; arrays and objects (admin keys, beacon targets) by content.
const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
};

export function useSectionBaseline<T extends Values>(
  values: T,
  options: SectionBaselineOptions<T> = {}
): SectionBaseline<T> {
  const { reseedKey, keepOnReseed } = options;
  const [baseline, setBaseline] = useState<T>(() => snapshot(values));
  const [seenReseedKey, setSeenReseedKey] = useState(reseedKey);

  // Re-baseline during render (not in an effect) so the render that shows the
  // reloaded values never flags them as changes.
  let current = baseline;
  if (!Object.is(seenReseedKey, reseedKey)) {
    const next = snapshot(values);
    for (const key of keepOnReseed ?? []) next[key] = baseline[key];
    current = next;
    setSeenReseedKey(reseedKey);
    setBaseline(next);
  }

  const hasChanges = Object.keys(values).some(key => !sameValue(values[key], current[key]));

  const commit = useCallback((saved: T) => setBaseline(snapshot(saved)), []);

  return { baseline: current, hasChanges, commit };
}
