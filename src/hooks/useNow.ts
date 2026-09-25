/**
 * useNow — a display-only clock tick for elapsed-time labels (#5277 P4b,
 * review follow-up on PR #5353: `CoverageSurveyBar`'s live-survey badge
 * read `Date.now()` only at render time, so "Live — 12m elapsed" froze
 * until something else re-rendered the component).
 *
 * Returns the current time in ms, re-rendering the caller every
 * `intervalMs` while `enabled` is true. This is UI-only state — it never
 * feeds a TanStack Query key, a fetch argument, or anything else that
 * would turn a display tick into a network poll (CLAUDE.md mesh-impact
 * rule: "timers: none new" is about traffic/side effects, not a local
 * `setState` that repaints a label). The interval is cleared on unmount
 * and whenever `enabled` flips to `false` — a caller passes `enabled` for
 * exactly the state where the label is actually shown (e.g. a selected
 * survey being live), so ticking stops the moment there is nothing to
 * animate.
 *
 * Deliberately NOT a `Date.now()` read inline during render: that reads
 * correctly once, but does nothing to force the next render — a ticking
 * label needs its own state to invalidate, same reason
 * `coverageTimeRange.ts` warns against computing a query-affecting value
 * from `Date.now()` inline (different failure mode, same root cause: a
 * bare `Date.now()` read carries no re-render trigger of its own).
 */
import { useEffect, useState } from 'react';

export function useNow(intervalMs: number, enabled: boolean = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    // Catch up immediately in case `enabled` just flipped true (or a lot of
    // time passed while disabled) rather than waiting a full tick first.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);

  return now;
}

export default useNow;
