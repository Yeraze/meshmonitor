/**
 * Per-widget fixed Y-axis range for telemetry chart widgets (#6348).
 *
 * A range holds an optional min and an optional max. A missing bound means
 * "auto": Recharts picks it from the data. Bounds are stored in the series'
 * base unit (Celsius for temperature, the stored A/W for current/power), the
 * same rule the gauge range follows, so a unit switch or an auto-scale change
 * does not move the line the user set.
 *
 * Shared by the dashboard charts and by the settings route, which validates
 * the `dashboardChartYRange` setting on save.
 */

export interface ChartYRange {
  min?: number;
  max?: number;
}

/** Settings key holding a JSON `Record<widgetKey, ChartYRange>` per source. */
export const CHART_Y_RANGE_SETTING = 'dashboardChartYRange';

/** Cap on stored entries: one per chart widget, far above any real dashboard. */
export const CHART_Y_RANGE_MAX_ENTRIES = 1000;

/** Widget key length cap (`${nodeId}-${telemetryType}` is well under this). */
const MAX_KEY_LENGTH = 200;

/** Keys that would write to the object's prototype instead of an own entry. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True for a widget key that is safe to store as an own property. */
export const isSafeChartYRangeKey = (key: string): boolean =>
  !!key && key.length <= MAX_KEY_LENGTH && !UNSAFE_KEYS.has(key);

const finite = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** True when the range fixes at least one bound. */
export function hasFixedYBound(range: ChartYRange | null | undefined): boolean {
  return !!range && (range.min !== undefined || range.max !== undefined);
}

/**
 * Clean one stored range: drop non-finite bounds, and drop the whole range
 * when both bounds are set and min is not below max. Returns null for "auto".
 */
export function normalizeChartYRange(input: unknown): ChartYRange | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const min = finite(raw.min);
  const max = finite(raw.max);
  if (min !== undefined && max !== undefined && min >= max) return null;
  const out: ChartYRange = {};
  if (min !== undefined) out.min = min;
  if (max !== undefined) out.max = max;
  return hasFixedYBound(out) ? out : null;
}

/**
 * Clean a whole map. Invalid entries are dropped rather than failing the
 * load, so one bad row never blanks every chart.
 */
export function normalizeChartYRangeMap(input: unknown): Record<string, ChartYRange> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  // Build from an entry list rather than `out[key] = …`, so no stored key is
  // ever used as a property-write target (CodeQL js/remote-property-injection).
  const entries: Array<[string, ChartYRange]> = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (entries.length >= CHART_Y_RANGE_MAX_ENTRIES) break;
    if (!isSafeChartYRangeKey(key)) continue;
    const range = normalizeChartYRange(value);
    if (range) entries.push([key, range]);
  }
  return Object.fromEntries(entries);
}

/** Parse the stored setting string. Bad JSON reads as "no fixed ranges". */
export function parseChartYRangeMap(json: string | null | undefined): Record<string, ChartYRange> {
  if (!json) return {};
  try {
    return normalizeChartYRangeMap(JSON.parse(json));
  } catch {
    return {};
  }
}

/**
 * Return a copy of `map` with `key` set to `range`, or removed when the range
 * is auto (or invalid).
 */
export function withChartYRange(
  map: Record<string, ChartYRange>,
  key: string,
  range: ChartYRange | null,
): Record<string, ChartYRange> {
  const next = { ...map };
  if (!isSafeChartYRangeKey(key)) return next;
  const clean = normalizeChartYRange(range);
  if (clean) next[key] = clean;
  else delete next[key];
  return next;
}

export type YAxisDomain = [number | 'auto', number | 'auto'];

/**
 * Recharts `domain` for a Y axis. `toDisplay` maps a stored bound into the
 * plotted unit (temperature conversion, auto-scale factor); both are
 * increasing, so min stays below max.
 */
export function chartYDomain(
  range: ChartYRange | null | undefined,
  toDisplay: (v: number) => number = (v) => v,
): YAxisDomain {
  return [
    range?.min !== undefined ? toDisplay(range.min) : 'auto',
    range?.max !== undefined ? toDisplay(range.max) : 'auto',
  ];
}

export type YRangeInputResult =
  | { ok: true; range: ChartYRange | null }
  | { ok: false; error: 'order' };

/**
 * Build a range from the editor's two fields. A blank (null/undefined) or
 * non-finite bound means auto for that end. Fails only when both bounds are
 * set and min is not below max.
 */
export function buildYRangeInput(
  min: number | null | undefined,
  max: number | null | undefined,
): YRangeInputResult {
  const lo = finite(min);
  const hi = finite(max);
  if (lo !== undefined && hi !== undefined && lo >= hi) return { ok: false, error: 'order' };
  const range: ChartYRange = {};
  if (lo !== undefined) range.min = lo;
  if (hi !== undefined) range.max = hi;
  return { ok: true, range: hasFixedYBound(range) ? range : null };
}
