/**
 * Estimate a leftHome anchor from stored position history.
 *
 * Takes pivoted lat/lon fixes, drops outliers farther than `refineRadiusMeters`
 * from the median, and returns the mean of the inliers. Used when establishing
 * or resetting a home so a single glitched "first fix" does not become the anchor
 * when a dense cluster already exists in telemetry.
 */
import { haversineKm } from './geo.js';
import { pivotPositionHistory, type PivotTelemetryRow } from '../../utils/positionHistoryPivot.js';
import databaseService from '../../../services/database.js';
import { ALL_SOURCES } from '../../../db/repositories/base.js';
import { logger } from '../../../utils/logger.js';

export interface LatLon {
  latitude: number;
  longitude: number;
}

export interface HomeEstimate extends LatLon {
  /** Total complete lat/lon fixes considered. */
  sampleCount: number;
  /** Fixes kept after the median-radius filter. */
  inlierCount: number;
}

function nodeIdOf(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Pure estimator: median → keep points within refineRadius → mean of inliers.
 * Returns null when fewer than 1 complete fix exists.
 */
export function estimateHomeFromPositions(
  positions: Array<{ latitude: number; longitude: number }>,
  refineRadiusMeters: number,
): HomeEstimate | null {
  const pts = positions.filter(
    (p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude),
  );
  if (pts.length === 0) return null;

  const latMed = median([...pts.map((p) => p.latitude)].sort((a, b) => a - b));
  const lonMed = median([...pts.map((p) => p.longitude)].sort((a, b) => a - b));
  const radius = Number.isFinite(refineRadiusMeters) && refineRadiusMeters > 0
    ? refineRadiusMeters
    : 150;

  const inliers = pts.filter(
    (p) => haversineKm(p.latitude, p.longitude, latMed, lonMed) * 1000 <= radius,
  );
  const use = inliers.length > 0 ? inliers : pts;
  const latitude = use.reduce((s, p) => s + p.latitude, 0) / use.length;
  const longitude = use.reduce((s, p) => s + p.longitude, 0) / use.length;
  return {
    latitude,
    longitude,
    sampleCount: pts.length,
    inlierCount: use.length,
  };
}

/**
 * Load recent position telemetry for a node and estimate a home anchor.
 * `thresholdMeters` sizes the outlier radius as threshold/2 (same as live refine).
 */
export async function estimateHomeFromNodeHistory(
  nodeNum: number,
  thresholdMeters: number,
  opts?: { limit?: number },
): Promise<HomeEstimate | null> {
  const refineRadius = (Number.isFinite(thresholdMeters) && thresholdMeters > 0 ? thresholdMeters : 300) / 2;
  const nodeId = nodeIdOf(nodeNum);
  try {
    // intentional cross-source: home is a property of the physical node
    const rows = await databaseService.telemetry.getPositionTelemetryByNode(
      nodeId,
      opts?.limit ?? 500,
      undefined,
      ALL_SOURCES,
    );
    const pivoted = pivotPositionHistory(rows as PivotTelemetryRow[]);
    return estimateHomeFromPositions(
      pivoted.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
      refineRadius,
    );
  } catch (e) {
    logger.warn(`[leftHome] history estimate failed for ${nodeId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
