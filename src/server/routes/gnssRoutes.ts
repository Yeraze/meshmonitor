/**
 * GNSS Routes — GPS/GNSS constellation overlay (#4729, backend foundation).
 *
 * Public (optionalAuth), rate-limited compute endpoints over live GNSS TLEs.
 * There is NO per-source scoping and NO database: a sky view is a pure function
 * of an observer point + an instant + the (cached) TLE set, exactly like the
 * elevation profile is a pure function of two points + a DEM source. Abuse is
 * bounded by `gnssLimiter` + the 24h TLE cache + the DOP-grid cell cap, not an
 * auth wall.
 *
 *  - `POST /skyview` — visible satellites + DOP for one observer point.
 *  - `POST /dop`     — a bounded grid of GDOP values for a bbox, for the future
 *                      map overlay. Reuses ONE fetched TLE set across all cells.
 *
 * No per-route express.json(): server.ts applies a global
 * `app.use(express.json({ limit: '10mb' }))` ahead of apiRouter.
 */

import { Router, Request, Response } from 'express';
import { optionalAuth } from '../auth/authMiddleware.js';
import { gnssLimiter } from '../middleware/rateLimiters.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';
import { computeSkyView } from '../services/gnss/skyView.js';
import {
  tleService,
  ENABLED_CONSTELLATIONS,
  type Constellation,
} from '../services/gnss/tleService.js';

const router = Router();

/** Default elevation mask (degrees) — a satellite must be at least this high to count as visible. */
const DEFAULT_ELEVATION_MASK_DEG = 5;

/**
 * Hard cap on DOP-grid cells per request. The grid endpoint runs SGP4 over the
 * whole constellation for EACH cell, so cell count is the cost driver. A bbox/
 * step that would exceed this is clamped to a coarser step (logged) rather than
 * silently truncated.
 */
const MAX_GRID_CELLS = 2500;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidLat(v: unknown): v is number {
  return isFiniteNumber(v) && v >= -90 && v <= 90;
}

function isValidLon(v: unknown): v is number {
  return isFiniteNumber(v) && v >= -180 && v <= 180;
}

/**
 * Validate + normalize a requested constellation list. Defaults to the enabled
 * set (GPS in v1). Rejects any constellation not yet enabled so a caller gets a
 * clear error instead of silently-empty results.
 */
function resolveConstellations(
  input: unknown
): { constellations: Constellation[] } | { error: string } {
  if (input === undefined || input === null) {
    return { constellations: [...ENABLED_CONSTELLATIONS] };
  }
  if (!Array.isArray(input) || input.length === 0) {
    return { error: 'constellations must be a non-empty array of constellation names.' };
  }
  const enabled = new Set<string>(ENABLED_CONSTELLATIONS);
  const out: Constellation[] = [];
  for (const c of input) {
    if (typeof c !== 'string' || !enabled.has(c)) {
      return {
        error: `Unsupported constellation "${String(c)}". Supported: ${ENABLED_CONSTELLATIONS.join(', ')}.`,
      };
    }
    out.push(c as Constellation);
  }
  return { constellations: out };
}

/** Resolve the requested instant (ms since epoch) or default to now. */
function resolveDate(timeMs: unknown): { date: Date } | { error: string } {
  if (timeMs === undefined || timeMs === null) return { date: new Date() };
  if (!isFiniteNumber(timeMs)) return { error: 'timeMs must be a finite number of milliseconds since epoch.' };
  return { date: new Date(timeMs) };
}

/** Resolve the elevation mask, clamped to [0, 90]; default 5. */
function resolveMask(input: unknown): { mask: number } | { error: string } {
  if (input === undefined || input === null) return { mask: DEFAULT_ELEVATION_MASK_DEG };
  if (!isFiniteNumber(input)) return { error: 'elevationMaskDeg must be a finite number.' };
  if (input < 0 || input > 90) return { error: 'elevationMaskDeg must be between 0 and 90.' };
  return { mask: input };
}

/**
 * POST /api/gnss/skyview
 * Public (optionalAuth) + rate-limited.
 * Body: { lat, lon, altKm?, timeMs?, constellations?, elevationMaskDeg? }.
 */
router.post('/skyview', optionalAuth(), gnssLimiter, async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      lat?: unknown;
      lon?: unknown;
      altKm?: unknown;
      timeMs?: unknown;
      constellations?: unknown;
      elevationMaskDeg?: unknown;
    };

    if (!isValidLat(body?.lat) || !isValidLon(body?.lon)) {
      fail(res, 400, 'INVALID_INPUT', 'Request body must include a valid lat (-90..90) and lon (-180..180).');
      return;
    }
    const altKm = body.altKm === undefined || body.altKm === null ? 0 : body.altKm;
    if (!isFiniteNumber(altKm)) {
      fail(res, 400, 'INVALID_INPUT', 'altKm must be a finite number.');
      return;
    }

    const cResult = resolveConstellations(body.constellations);
    if ('error' in cResult) {
      fail(res, 400, 'INVALID_INPUT', cResult.error);
      return;
    }
    const dResult = resolveDate(body.timeMs);
    if ('error' in dResult) {
      fail(res, 400, 'INVALID_INPUT', dResult.error);
      return;
    }
    const mResult = resolveMask(body.elevationMaskDeg);
    if ('error' in mResult) {
      fail(res, 400, 'INVALID_INPUT', mResult.error);
      return;
    }

    let tles;
    try {
      tles = await tleService.getTlesForConstellations(cResult.constellations);
    } catch (err) {
      logger.warn('[GNSS] skyview: TLE data unavailable:', err);
      fail(res, 503, 'TLE_UNAVAILABLE', 'Satellite element data is currently unavailable.');
      return;
    }
    // An empty set means no element data could be fetched for any requested
    // constellation (and none was cached) — distinct from "data present but
    // nothing above the mask", which is a legitimate 200 with visibleCount 0.
    if (tles.length === 0) {
      fail(res, 503, 'TLE_UNAVAILABLE', 'Satellite element data is currently unavailable.');
      return;
    }

    const result = computeSkyView({
      tles,
      observer: { latDeg: body.lat, lonDeg: body.lon, altKm },
      date: dResult.date,
      elevationMaskDeg: mResult.mask,
    });

    ok(res, {
      observer: { lat: body.lat, lon: body.lon, altKm },
      timeMs: dResult.date.getTime(),
      elevationMaskDeg: mResult.mask,
      constellations: cResult.constellations,
      ...result,
    });
  } catch (error) {
    logger.error('Error in POST /api/gnss/skyview:', error);
    fail(res, 500, 'GNSS_SKYVIEW_FAILED', 'Failed to compute sky view.');
  }
});

/**
 * POST /api/gnss/dop
 * Public (optionalAuth) + rate-limited.
 * Body: { bbox:{minLat,minLon,maxLat,maxLon}, stepDeg, timeMs?, elevationMaskDeg?, constellations? }.
 * Returns a grid of { lat, lon, gdop } for the future map overlay. Reuses one
 * fetched TLE set across every cell. The grid is clamped to MAX_GRID_CELLS
 * (never silently truncated) by coarsening the step.
 */
router.post('/dop', optionalAuth(), gnssLimiter, async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      bbox?: { minLat?: unknown; minLon?: unknown; maxLat?: unknown; maxLon?: unknown };
      stepDeg?: unknown;
      timeMs?: unknown;
      elevationMaskDeg?: unknown;
      constellations?: unknown;
    };

    const bbox = body?.bbox;
    if (
      !bbox ||
      typeof bbox !== 'object' ||
      !isValidLat(bbox.minLat) ||
      !isValidLat(bbox.maxLat) ||
      !isValidLon(bbox.minLon) ||
      !isValidLon(bbox.maxLon)
    ) {
      fail(res, 400, 'INVALID_INPUT', 'bbox must include valid minLat/maxLat (-90..90) and minLon/maxLon (-180..180).');
      return;
    }
    if (bbox.minLat >= bbox.maxLat || bbox.minLon >= bbox.maxLon) {
      fail(res, 400, 'INVALID_INPUT', 'bbox requires minLat < maxLat and minLon < maxLon.');
      return;
    }
    if (!isFiniteNumber(body.stepDeg) || body.stepDeg <= 0) {
      fail(res, 400, 'INVALID_INPUT', 'stepDeg must be a positive number.');
      return;
    }

    const cResult = resolveConstellations(body.constellations);
    if ('error' in cResult) {
      fail(res, 400, 'INVALID_INPUT', cResult.error);
      return;
    }
    const dResult = resolveDate(body.timeMs);
    if ('error' in dResult) {
      fail(res, 400, 'INVALID_INPUT', dResult.error);
      return;
    }
    const mResult = resolveMask(body.elevationMaskDeg);
    if ('error' in mResult) {
      fail(res, 400, 'INVALID_INPUT', mResult.error);
      return;
    }

    const latSpan = bbox.maxLat - bbox.minLat;
    const lonSpan = bbox.maxLon - bbox.minLon;

    // Clamp the grid to MAX_GRID_CELLS by coarsening the step (never truncate).
    let stepDeg = body.stepDeg;
    const requestedCells =
      (Math.floor(latSpan / stepDeg) + 1) * (Math.floor(lonSpan / stepDeg) + 1);
    let clamped = false;
    if (requestedCells > MAX_GRID_CELLS) {
      clamped = true;
      // Scale the step up by ~sqrt(overshoot), then nudge until it fits.
      stepDeg = stepDeg * Math.sqrt(requestedCells / MAX_GRID_CELLS);
      let guard = 0;
      while (
        (Math.floor(latSpan / stepDeg) + 1) * (Math.floor(lonSpan / stepDeg) + 1) > MAX_GRID_CELLS &&
        guard < 100
      ) {
        stepDeg *= 1.05;
        guard++;
      }
      logger.warn(
        `[GNSS] dop grid clamped: requested ~${requestedCells} cells (step ${body.stepDeg}) exceeds cap ${MAX_GRID_CELLS}; coarsened step to ${stepDeg.toFixed(4)}.`
      );
    }

    let tles;
    try {
      tles = await tleService.getTlesForConstellations(cResult.constellations);
    } catch (err) {
      logger.warn('[GNSS] dop: TLE data unavailable:', err);
      fail(res, 503, 'TLE_UNAVAILABLE', 'Satellite element data is currently unavailable.');
      return;
    }
    if (tles.length === 0) {
      fail(res, 503, 'TLE_UNAVAILABLE', 'Satellite element data is currently unavailable.');
      return;
    }

    const nLat = Math.floor(latSpan / stepDeg) + 1;
    const nLon = Math.floor(lonSpan / stepDeg) + 1;
    const points: Array<{ lat: number; lon: number; gdop: number | null }> = [];

    for (let i = 0; i < nLat; i++) {
      const lat = bbox.minLat + i * stepDeg;
      for (let j = 0; j < nLon; j++) {
        const lon = bbox.minLon + j * stepDeg;
        const sky = computeSkyView({
          tles,
          observer: { latDeg: lat, lonDeg: lon, altKm: 0 },
          date: dResult.date,
          elevationMaskDeg: mResult.mask,
        });
        points.push({ lat, lon, gdop: sky.dop ? sky.dop.gdop : null });
      }
    }

    ok(res, {
      points,
      cellCount: points.length,
      stepDeg,
      requestedStepDeg: body.stepDeg,
      clamped,
      timeMs: dResult.date.getTime(),
      elevationMaskDeg: mResult.mask,
      constellations: cResult.constellations,
    });
  } catch (error) {
    logger.error('Error in POST /api/gnss/dop:', error);
    fail(res, 500, 'GNSS_DOP_FAILED', 'Failed to compute DOP grid.');
  }
});

export default router;
