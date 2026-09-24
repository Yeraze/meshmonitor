/**
 * Coverage Report time-range resolution (#5277, Phase 1 WP4).
 *
 * Pure helper, deliberately kept OUT of CoverageReport.tsx (both for the
 * `react-refresh/only-export-components` rule and for testability): resolves
 * a preset (or a custom from/to pair) into a concrete `{ sinceMs, untilMs }`
 * window anchored to a caller-supplied `nowMs`.
 *
 * CRITICAL: callers must resolve this ONCE per discrete user action (mount,
 * preset click, "Apply" on a custom range, Refresh) and store the result in
 * state — never call this with `Date.now()` inline during render. Regression
 * (#5277 browser validation): an earlier version computed `{ sinceMs, untilMs }`
 * fresh on every render via `Date.now()`. Since TanStack Query's default
 * `queryKeyHashFn` does structural (JSON) equality, a numeric value that
 * changes by even 1ms produces a genuinely different query key every render,
 * which triggers a real refetch, which triggers a re-render, which computes
 * a new "now" — an endless ~6 req/s fetch loop that never let the map render
 * (Refresh stayed permanently disabled because `isLoading` never cleared).
 * The fix is a stable value in state, not a memo/exhaustive-deps workaround:
 * a `useMemo` keyed on `Date.now()` has exactly the same bug, since the memo
 * still re-invokes its factory (and produces a new value) every render.
 */

export type CoverageRangePreset = '1h' | '6h' | '24h' | '3d' | '7d' | 'custom';

export const COVERAGE_RANGE_PRESET_MS: Record<Exclude<CoverageRangePreset, 'custom'>, number> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '3d': 3 * 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
};

export interface CoverageWindow {
  sinceMs: number;
  untilMs: number;
  /** True when a custom range's from/to could not be resolved (unparsable,
   *  or `to` before `from`). `sinceMs`/`untilMs` still hold a safe fallback
   *  (the last 24h) so callers always have numbers to query with. */
  rangeInvalid: boolean;
}

/**
 * Resolve `preset` (or, for `'custom'`, the `customFrom`/`customTo`
 * `datetime-local` input strings) into a concrete window anchored to
 * `nowMs`. Pure — same inputs always give the same output, so it is safe to
 * call once and cache the result in state.
 */
export function resolveCoverageWindow(
  preset: CoverageRangePreset,
  nowMs: number,
  customFrom?: string,
  customTo?: string,
): CoverageWindow {
  if (preset === 'custom') {
    const from = customFrom ? new Date(customFrom).getTime() : NaN;
    const to = customTo ? new Date(customTo).getTime() : nowMs;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      return {
        sinceMs: nowMs - COVERAGE_RANGE_PRESET_MS['24h'],
        untilMs: nowMs,
        rangeInvalid: true,
      };
    }
    return { sinceMs: from, untilMs: to, rangeInvalid: false };
  }
  return { sinceMs: nowMs - COVERAGE_RANGE_PRESET_MS[preset], untilMs: nowMs, rangeInvalid: false };
}
