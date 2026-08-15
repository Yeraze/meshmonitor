/**
 * Geometry for the predicted-coverage layer (#4727).
 *
 * Converts the server's per-azimuth reach distances into a closed polygon.
 * Kept out of the component module so that file exports only its component
 * (react-refresh cannot fast-refresh a mixed module).
 */
import { destinationPoint } from '../../../utils/greatCircle';

export interface CoverageRadial {
  bearingDeg: number;
  reachKm: number;
  limitedByRadius: boolean;
  reachablePocketsBeyond: boolean;
  hasDataGaps: boolean;
}

export interface PredictedCoverage {
  origin: { lat: number; lng: number };
  radiusKm: number;
  generatedAt: number;
  model: string;
  radials: CoverageRadial[];
  assumptions: string[];
}

/**
 * Polygon vertices, one per radial, ordered by bearing.
 *
 * Sorted rather than trusting input order: an out-of-order radial would draw a
 * self-intersecting bow-tie that reads as a rendering bug rather than as bad
 * data. Returns `[]` below three radials, since two points cannot bound an area
 * and Leaflet would render a degenerate shape.
 */
export function coverageToPolygon(coverage: PredictedCoverage): Array<[number, number]> {
  if (!coverage?.radials || coverage.radials.length < 3) return [];

  return [...coverage.radials]
    .sort((a, b) => a.bearingDeg - b.bearingDeg)
    .map((r) => {
      const p = destinationPoint(coverage.origin, r.bearingDeg, Math.max(0, r.reachKm) * 1000);
      return [p.lat, p.lng] as [number, number];
    });
}

/** Fraction of radials that ran out of map before running out of signal. */
export function radiusLimitedFraction(coverage: PredictedCoverage): number {
  const n = coverage?.radials?.length ?? 0;
  if (n === 0) return 0;
  return coverage.radials.filter((r) => r.limitedByRadius).length / n;
}

/** True when any radial reported terrain data gaps. */
export function hasAnyDataGaps(coverage: PredictedCoverage): boolean {
  return (coverage?.radials ?? []).some((r) => r.hasDataGaps);
}

/** True when any radial found reachable ground beyond its first failure. */
export function hasAnyPockets(coverage: PredictedCoverage): boolean {
  return (coverage?.radials ?? []).some((r) => r.reachablePocketsBeyond);
}
