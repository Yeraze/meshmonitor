/**
 * Telemetry outlier detection (#5333).
 *
 * Pure math shared by the server (preview + purge) and the client (input
 * bounds). No imports, so it compiles for both trees unchanged.
 *
 * ## Detection rule
 * Each (source, node, telemetryType) series is judged on its own. A point is
 * an outlier when it is an automatic outlier OR falls outside the manual
 * bounds:
 *
 * - **Automatic:** `|x - median| > k * MAD`, where MAD is the median absolute
 *   deviation from the median. Raw MAD, not the 1.4826-scaled sigma estimate:
 *   `k = 6` raw MADs is about 4 sigma on normal data, so ordinary noise stays.
 *   Median and MAD shrug off up to half the series being bad, which a mean and
 *   standard deviation cannot (one 1000 °C reading drags both).
 * - **Manual bounds:** `x < min` or `x > max` (inclusive bounds are kept).
 *
 * ## Guards
 * - **Minimum sample size ({@link OUTLIER_MIN_SAMPLES}):** below it the median
 *   and MAD are too unstable to trust, so automatic detection flags nothing.
 *   Ten points keep the 50% breakdown meaningful (up to four bad points can
 *   not move the median off the good ones). Manual bounds still apply.
 * - **MAD == 0:** more than half the series shares one value (a powered node
 *   reporting battery 101, a counter parked at 0). Any fallback scale built
 *   from the remaining points would call the whole legitimate minority an
 *   outlier, so automatic detection flags NOTHING and reports
 *   `scaleKind: 'flat'`. The UI tells the user to set manual bounds instead,
 *   which is exactly what a flat series with a glitch needs.
 */

export const OUTLIER_K_DEFAULT = 6;
export const OUTLIER_K_MIN = 2;
export const OUTLIER_K_MAX = 20;
export const OUTLIER_MIN_SAMPLES = 10;

export interface OutlierCriteria {
  /** Use median/MAD automatic detection. */
  auto: boolean;
  /** MAD multiplier; only read when `auto` is true. */
  k: number;
  /** Remove values strictly below this. */
  min: number | null;
  /** Remove values strictly above this. */
  max: number | null;
}

export interface OutlierSeriesPoint {
  id: number;
  value: number;
  timestamp: number;
}

export type OutlierReason = 'auto' | 'below_min' | 'above_max';

export interface FlaggedPoint extends OutlierSeriesPoint {
  reason: OutlierReason;
}

/**
 * Why automatic detection did or did not run on a series:
 * - `mad`: it ran.
 * - `off`: the caller turned it off.
 * - `too_few`: fewer than {@link OUTLIER_MIN_SAMPLES} finite points.
 * - `flat`: MAD is 0, so there is no spread to judge against.
 */
export type OutlierScaleKind = 'mad' | 'off' | 'too_few' | 'flat';

export interface SeriesAnalysis {
  sampleCount: number;
  median: number | null;
  mad: number | null;
  scaleKind: OutlierScaleKind;
  flagged: FlaggedPoint[];
}

/** Median of a list of numbers; null when empty. Does not mutate the input. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation from `center`; null when empty. */
export function medianAbsoluteDeviation(values: readonly number[], center: number): number | null {
  if (values.length === 0) return null;
  return median(values.map(v => Math.abs(v - center)));
}

/**
 * Analyse one series. Non-finite values are ignored for the statistics and
 * never flagged (they cannot be stored as REAL anyway).
 */
export function analyzeSeries(
  points: readonly OutlierSeriesPoint[],
  criteria: OutlierCriteria,
): SeriesAnalysis {
  const finite = points.filter(p => Number.isFinite(p.value));
  const values = finite.map(p => p.value);
  const med = median(values);
  const mad = med === null ? null : medianAbsoluteDeviation(values, med);

  let scaleKind: OutlierScaleKind;
  if (!criteria.auto) scaleKind = 'off';
  else if (finite.length < OUTLIER_MIN_SAMPLES) scaleKind = 'too_few';
  // MAD 0 is a flat series; null (no finite points) is already caught by too_few.
  else if (mad === null || mad === 0) scaleKind = 'flat';
  else scaleKind = 'mad';

  const threshold = scaleKind === 'mad' ? criteria.k * (mad as number) : null;

  const flagged: FlaggedPoint[] = [];
  for (const p of finite) {
    let reason: OutlierReason | null = null;
    if (criteria.min !== null && p.value < criteria.min) reason = 'below_min';
    else if (criteria.max !== null && p.value > criteria.max) reason = 'above_max';
    else if (threshold !== null && Math.abs(p.value - (med as number)) > threshold) reason = 'auto';
    if (reason) flagged.push({ ...p, reason });
  }

  return { sampleCount: finite.length, median: med, mad, scaleKind, flagged };
}

// ── Wire shapes shared by the purge routes and the client ────────────────────

export interface OutlierPreviewPoint {
  id: number;
  nodeId: string;
  value: number;
  timestamp: number;
  reason: OutlierReason;
}

export interface OutlierNodeSummary {
  nodeId: string;
  sampleCount: number;
  median: number | null;
  mad: number | null;
  scaleKind: OutlierScaleKind;
  flaggedCount: number;
}

export interface OutlierPreview {
  sourceId: string;
  telemetryType: string;
  nodeId: string | null;
  criteria: OutlierCriteria;
  /** Highest row id analysed; pass back to the purge. Null when the scope is empty. */
  cutoffId: number | null;
  /** Hash of the flagged row ids; pass back to the purge. */
  fingerprint: string;
  rowsScanned: number;
  nodesScanned: number;
  affectedCount: number;
  nodesAffected: number;
  removedMin: number | null;
  removedMax: number | null;
  /** The series median (single-node scope only; null for a sweep). */
  median: number | null;
  /** The series MAD (single-node scope only). */
  mad: number | null;
  /** Why auto detection did or did not run (single-node scope only). */
  scaleKind: OutlierScaleKind | null;
  /** Nodes where auto detection was skipped for too few points / a flat series. */
  nodesTooFew: number;
  nodesFlat: number;
  /** Flagged points, oldest first, capped at the server's point limit. */
  points: OutlierPreviewPoint[];
  pointsTruncated: boolean;
  /** Nodes with flagged points, most flagged first, capped at the server's node limit. */
  nodes: OutlierNodeSummary[];
}

export interface OutlierPurgeResult {
  deletedCount: number;
  nodesAffected: number;
}

export type CriteriaValidation =
  | { ok: true; criteria: OutlierCriteria }
  | { ok: false; code: 'INVALID_AUTO' | 'INVALID_K' | 'INVALID_BOUNDS' | 'NO_CRITERIA'; message: string };

function optionalNumber(v: unknown): number | null | undefined {
  // Returns null when absent (undefined/null/''), the number when finite,
  // and undefined as an "invalid" marker otherwise.
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Validate untrusted criteria (request body or form state). `auto` defaults
 * to true and `k` to {@link OUTLIER_K_DEFAULT} when omitted.
 */
export function validateOutlierCriteria(input: {
  auto?: unknown;
  k?: unknown;
  min?: unknown;
  max?: unknown;
}): CriteriaValidation {
  if (input.auto !== undefined && typeof input.auto !== 'boolean') {
    return { ok: false, code: 'INVALID_AUTO', message: 'auto must be a boolean' };
  }
  const auto = input.auto === undefined ? true : input.auto;

  let k = OUTLIER_K_DEFAULT;
  if (input.k !== undefined && input.k !== null) {
    const parsed = typeof input.k === 'number' ? input.k : NaN;
    if (!Number.isFinite(parsed) || parsed < OUTLIER_K_MIN || parsed > OUTLIER_K_MAX) {
      return {
        ok: false,
        code: 'INVALID_K',
        message: `k must be a number between ${OUTLIER_K_MIN} and ${OUTLIER_K_MAX}`,
      };
    }
    k = parsed;
  }

  const min = optionalNumber(input.min);
  const max = optionalNumber(input.max);
  if (min === undefined || max === undefined) {
    return { ok: false, code: 'INVALID_BOUNDS', message: 'min and max must be finite numbers' };
  }
  if (min !== null && max !== null && min >= max) {
    return { ok: false, code: 'INVALID_BOUNDS', message: 'min must be less than max' };
  }
  if (!auto && min === null && max === null) {
    return {
      ok: false,
      code: 'NO_CRITERIA',
      message: 'Enable automatic detection or set a min or max bound',
    };
  }
  return { ok: true, criteria: { auto, k, min, max } };
}
