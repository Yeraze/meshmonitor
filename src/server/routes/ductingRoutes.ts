/**
 * Tropospheric ducting forecast (#5734 spike).
 *
 * GET /api/ducting/forecast?hoursAhead=0&bbox=minLon,minLat,maxLon,maxLat
 *
 * Admin-only while this is a spike: each cache miss makes an outbound request
 * to NOAA, and no setting gates it yet. Without `bbox` the area is the spread
 * of recently heard Meshtastic nodes across all sources (admins can read every
 * source, so this reveals nothing).
 */
import { Router, type Request, type Response } from 'express';
import databaseService from '../../services/database.js';
import { requireAdmin } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';
import { ALL_SOURCES } from '../../db/repositories/base.js';
import { isBogusPosition } from '../../utils/nullIsland.js';
import { DuctingForecastService, MAX_HOURS_AHEAD } from '../services/ducting/ductingForecastService.js';
import { GfsUnavailableError, type BBox } from '../services/ducting/gfsClient.js';
import { Grib2FormatError } from '../services/ducting/grib2.js';
import { GfsProfileError } from '../services/ducting/gfsProfile.js';

/** Largest box side, degrees. 20x20 at 0.25 degrees is 6,561 points, ~300 KB of GRIB per hour. */
export const MAX_BBOX_SPAN_DEG = 20;
/** Nodes heard within this window set the default area. */
const NODE_WINDOW_S = 7 * 86400;
/** Margin added around the nodes, degrees. */
const NODE_PAD_DEG = 0.5;
const GRID_DEG = 0.25;

let service = new DuctingForecastService();

/** Drop the forecast cache. Tests only. */
export function resetDuctingForecastForTests(): void {
  service = new DuctingForecastService();
}

export function parseBBox(raw: string): BBox | string {
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return 'bbox must be minLon,minLat,maxLon,maxLat';
  }
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180) return 'bbox is outside -180..180 / -90..90';
  if (minLat >= maxLat || minLon >= maxLon) return 'bbox min must be below max (boxes across 180 degrees are not supported)';
  if (maxLat - minLat > MAX_BBOX_SPAN_DEG || maxLon - minLon > MAX_BBOX_SPAN_DEG) {
    return `bbox sides must be at most ${MAX_BBOX_SPAN_DEG} degrees`;
  }
  return { minLat, maxLat, minLon, maxLon };
}

function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/**
 * The area the nodes cover: 5th to 95th percentile on each axis (so one
 * far-off MQTT node does not stretch it), padded, snapped out to the GFS grid
 * and shrunk around its centre to the span cap.
 */
export function bboxFromPositions(points: readonly { lat: number; lon: number }[]): BBox | null {
  if (points.length === 0) return null;
  const lats = points.map((p) => p.lat).sort((a, b) => a - b);
  const lons = points.map((p) => p.lon).sort((a, b) => a - b);
  const snapDown = (v: number) => Math.floor(v / GRID_DEG) * GRID_DEG;
  const snapUp = (v: number) => Math.ceil(v / GRID_DEG) * GRID_DEG;
  const fit = (lo: number, hi: number, min: number, max: number): [number, number] => {
    let a = snapDown(lo - NODE_PAD_DEG);
    let b = snapUp(hi + NODE_PAD_DEG);
    if (b - a > MAX_BBOX_SPAN_DEG) {
      const mid = snapDown((a + b) / 2);
      a = mid - MAX_BBOX_SPAN_DEG / 2;
      b = mid + MAX_BBOX_SPAN_DEG / 2;
    }
    return [Math.max(min, a), Math.min(max, b)];
  };
  const [minLat, maxLat] = fit(percentile(lats, 0.05), percentile(lats, 0.95), -90, 90);
  const [minLon, maxLon] = fit(percentile(lons, 0.05), percentile(lons, 0.95), -180, 180);
  return { minLat, maxLat, minLon, maxLon };
}

async function nodeArea(): Promise<BBox | null> {
  const cutoff = Math.floor(Date.now() / 1000) - NODE_WINDOW_S;
  const nodes = await databaseService.nodes.getAllNodes(ALL_SOURCES);
  const points = nodes.flatMap((n) => {
    const lat = n.latitude;
    const lon = n.longitude;
    if (lat == null || lon == null || isBogusPosition(lat, lon)) return [];
    if (n.lastHeard == null || n.lastHeard < cutoff) return [];
    return [{ lat, lon }];
  });
  return bboxFromPositions(points);
}

const router = Router();

router.get('/forecast', requireAdmin(), async (req: Request, res: Response) => {
  const hoursAhead = req.query.hoursAhead === undefined ? 0 : Number(req.query.hoursAhead);
  if (!Number.isInteger(hoursAhead) || hoursAhead < 0 || hoursAhead > MAX_HOURS_AHEAD) {
    return fail(res, 400, 'INVALID_INPUT', `hoursAhead must be an integer from 0 to ${MAX_HOURS_AHEAD}`);
  }
  let bbox: BBox | null;
  if (typeof req.query.bbox === 'string') {
    const parsed = parseBBox(req.query.bbox);
    if (typeof parsed === 'string') return fail(res, 400, 'INVALID_INPUT', parsed);
    bbox = parsed;
  } else {
    bbox = await nodeArea();
    if (!bbox) return fail(res, 400, 'NO_AREA', 'No recently heard node has a position; pass bbox');
  }
  try {
    return ok(res, { bbox, ...(await service.getForecast(bbox, hoursAhead)) });
  } catch (err) {
    if (err instanceof GfsUnavailableError) return fail(res, 503, 'GFS_UNAVAILABLE', err.message);
    if (err instanceof Grib2FormatError || err instanceof GfsProfileError) {
      logger.warn('Ducting forecast: unreadable GFS data:', err);
      return fail(res, 502, 'GFS_UNREADABLE', err.message);
    }
    logger.error('Ducting forecast failed:', err);
    return fail(res, 500, 'INTERNAL_ERROR', 'Ducting forecast failed');
  }
});

export default router;
