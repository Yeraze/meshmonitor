/**
 * Coverage Report metre-sized grid binning (#5277 Phase 4a WP1).
 *
 * One value per FIX (its "best" reading for the active metric — the same
 * value the dot colour uses, Decision D4), not per reception: a repeated
 * drive through one cell votes once per pass, not once per receiver. See
 * `COVERAGE_P4_SPEC.md` §2a.4 / Decision A3. Deliberately NOT the existing
 * `/api/analysis/coverage-grid` (zoom-keyed degree bins, positions only, no
 * signal) — same binning idea, different data.
 *
 * `src/utils/**` is in `tsconfig.server.json`'s include set, so relative
 * imports need an explicit `.js` extension (#4596).
 */
import type { CoverageFix, CoverageMetric } from './coverage.js';
import type { CoverageGridCell, CoverageGridCellSizeM } from '../types/coverageAnalysis.js';
import { median } from './coverageSummary.js';

/** Metres per degree of latitude, constant everywhere on the WGS84 sphere approximation used elsewhere in this codebase. */
const METERS_PER_DEGREE_LAT = 111_320;

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

interface CellAccumulator {
  latIndex: number;
  lonIndex: number;
  values: number[];
  fixCount: number;
}

/**
 * Bin `fixes` into a metre-sized lat/lon grid and return one cell per
 * non-empty bin.
 *
 * - Cell size in degrees: `latStep = cellSizeM / 111_320`;
 *   `lonStep = cellSizeM / (111_320 * cos(refLat))`, where `refLat` is the
 *   mean latitude of the input fixes — uniform cells across one survey area
 *   without a per-fix distortion.
 * - Cell index: `floor(lat / latStep)`, `floor(lon / lonStep)`; `key` is
 *   `${latIndex}:${lonIndex}`.
 * - `medianValue` is the median, across the fixes landing in that cell, of
 *   each fix's `bestSnr`/`bestRssi` (per `metric`). A fix whose best value is
 *   null still counts toward `fixCount`; `medianValue` is null only when
 *   EVERY fix in the cell has a null best value.
 */
export function binFixesToGrid(
  fixes: CoverageFix[],
  cellSizeM: CoverageGridCellSizeM,
  metric: CoverageMetric,
): CoverageGridCell[] {
  if (fixes.length === 0) return [];

  const refLat = fixes.reduce((sum, fix) => sum + fix.latitude, 0) / fixes.length;
  const latStep = cellSizeM / METERS_PER_DEGREE_LAT;
  const lonDivisor = METERS_PER_DEGREE_LAT * Math.cos(toRadians(refLat));
  // Guard the (practically unreachable, refLat -> +/-90) division-by-zero case.
  const lonStep = cellSizeM / (lonDivisor === 0 ? Number.EPSILON : lonDivisor);

  const cells = new Map<string, CellAccumulator>();

  for (const fix of fixes) {
    const latIndex = Math.floor(fix.latitude / latStep);
    const lonIndex = Math.floor(fix.longitude / lonStep);
    const key = `${latIndex}:${lonIndex}`;

    let cell = cells.get(key);
    if (!cell) {
      cell = { latIndex, lonIndex, values: [], fixCount: 0 };
      cells.set(key, cell);
    }
    cell.fixCount += 1;

    const value = metric === 'snr' ? fix.bestSnr : fix.bestRssi;
    if (value != null) cell.values.push(value);
  }

  return Array.from(cells.values()).map((cell) => ({
    key: `${cell.latIndex}:${cell.lonIndex}`,
    south: cell.latIndex * latStep,
    north: (cell.latIndex + 1) * latStep,
    west: cell.lonIndex * lonStep,
    east: (cell.lonIndex + 1) * lonStep,
    medianValue: median(cell.values),
    fixCount: cell.fixCount,
  }));
}
