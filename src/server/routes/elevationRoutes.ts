/**
 * Elevation Routes — Terrain Link Profile epic #4111 (Phase 1, backend only)
 * + DEM tile proxy / capabilities (#3826 Phase 2 WP-A).
 *
 * `POST /profile` — public (optionalAuth), rate-limited. Computes an
 * elevation profile between two coordinates against the configured (or
 * default terrarium) DEM source. Elevation is source-agnostic public DEM
 * data — not per-source, not user-scoped — mirroring analysisRoutes.ts's
 * public posture. Abuse is bounded by elevationLimiter + the service's
 * MAX_SAMPLES/MAX_PATH_KM caps + the SSRF guard, not an auth wall.
 *
 * `POST /test` — admin-only (settings:write), rate-limited. Probes an
 * arbitrary admin-supplied URL, identical trust level to mapStyleRoutes'
 * `POST /from-url`.
 *
 * `GET /capabilities` — public (optionalAuth), no network I/O. Derived,
 * non-secret capability summary (`elevationSourceUrl` is a secret setting
 * stripped from `/api/settings` for non-admins) so the frontend can decide
 * whether to offer the 3D terrain toggle before rendering it.
 *
 * `GET /tiles/:z/:x/:y` — public (optionalAuth) + `elevationTileLimiter`
 * (far more generous than `elevationLimiter` — a single 3D view legitimately
 * fetches dozens of DEM tiles). Returns raw `image/png` bytes (NOT the
 * `ok()`/`fail()` envelope on success) with a long `immutable` Cache-Control;
 * error paths use `fail()` + `no-store`. The resolved source URL/key is never
 * echoed in a response or log message.
 *
 * No per-route express.json(): server.ts applies a global
 * `app.use(express.json({ limit: '10mb' }))` ahead of apiRouter, matching
 * neighboring routes (analysisRoutes, tileServerTest).
 */

import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { elevationLimiter, elevationTileLimiter } from '../middleware/rateLimiters.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';
import {
  computeProfile,
  testSource,
  getElevationCapabilities,
  fetchTerrainTile,
} from '../services/elevationService.js';
import type { LatLng } from '../../utils/greatCircle.js';

const router = Router();

function isValidLatLng(value: unknown): value is LatLng {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.lat === 'number' && typeof v.lng === 'number' &&
    Number.isFinite(v.lat) && Number.isFinite(v.lng);
}

/**
 * POST /api/elevation/profile
 * Public (optionalAuth) + rate-limited. Body: { pointA, pointB, samples? }.
 */
router.post('/profile', optionalAuth(), elevationLimiter, async (req: Request, res: Response) => {
  try {
    const settings = await databaseService.settings.getAllSettings();
    if (settings.elevationEnabled === 'false') {
      fail(res, 403, 'ELEVATION_DISABLED', 'Elevation profiles are disabled on this server.');
      return;
    }

    const body = req.body as { pointA?: unknown; pointB?: unknown; samples?: unknown };
    if (!isValidLatLng(body?.pointA) || !isValidLatLng(body?.pointB)) {
      fail(res, 400, 'INVALID_BODY', 'Request body must include pointA and pointB, each { lat, lng }.');
      return;
    }
    const samples = typeof body.samples === 'number' && Number.isFinite(body.samples)
      ? body.samples
      : undefined;

    const result = await computeProfile(
      { pointA: body.pointA, pointB: body.pointB, samples },
      settings.elevationSourceUrl,
    );

    if ('code' in result) {
      fail(res, result.status, result.code, result.message);
      return;
    }

    ok(res, result);
  } catch (error) {
    logger.error('Error in POST /api/elevation/profile:', error);
    fail(res, 500, 'ELEVATION_PROFILE_FAILED', 'Failed to compute elevation profile.');
  }
});

/**
 * POST /api/elevation/test
 * Admin only (settings:write) + rate-limited. Body: { url, lat?, lng? }.
 * Reports even a probe outcome of success:false — the probe result is data,
 * not a request-level error.
 */
router.post('/test', requirePermission('settings', 'write'), elevationLimiter, async (req: Request, res: Response) => {
  try {
    const body = req.body as { url?: unknown; lat?: unknown; lng?: unknown };
    if (typeof body?.url !== 'string' || body.url.trim().length === 0) {
      fail(res, 400, 'MISSING_URL', 'Request body must include a url.');
      return;
    }

    const probe = typeof body.lat === 'number' && typeof body.lng === 'number' &&
      Number.isFinite(body.lat) && Number.isFinite(body.lng)
      ? { lat: body.lat, lng: body.lng }
      : undefined;

    const result = await testSource(body.url, probe);
    ok(res, result);
  } catch (error) {
    logger.error('Error in POST /api/elevation/test:', error);
    fail(res, 500, 'ELEVATION_TEST_FAILED', 'Failed to test elevation source.');
  }
});

/**
 * GET /api/elevation/capabilities
 * Public (optionalAuth), no network I/O — reads two settings and derives a
 * non-secret capability summary (#3826 Phase 2 WP-A).
 */
router.get('/capabilities', optionalAuth(), async (_req: Request, res: Response) => {
  try {
    const settings = await databaseService.settings.getAllSettings();
    const capabilities = getElevationCapabilities(settings.elevationEnabled, settings.elevationSourceUrl);
    ok(res, capabilities);
  } catch (error) {
    logger.error('Error in GET /api/elevation/capabilities:', error);
    fail(res, 500, 'ELEVATION_CAPABILITIES_FAILED', 'Failed to determine elevation capabilities.');
  }
});

function parseTileParam(value: string): number {
  // `Number('')`/whitespace would otherwise coerce to 0 — require a
  // non-empty, fully-numeric string so a stray extension (e.g. "123.png")
  // or empty segment reliably yields NaN -> INVALID_TILE_COORDS.
  if (!/^-?\d+$/.test(value)) return NaN;
  return Number(value);
}

/**
 * GET /api/elevation/tiles/:z/:x/:y
 * Public (optionalAuth) + elevationTileLimiter. Returns raw `image/png`
 * bytes on success (no envelope) — error paths use `fail()`. Never includes
 * the resolved source URL or key in a response or log message.
 */
router.get(
  '/tiles/:z/:x/:y',
  optionalAuth(),
  elevationTileLimiter,
  async (req: Request, res: Response) => {
    try {
      const z = parseTileParam(req.params.z);
      const x = parseTileParam(req.params.x);
      const y = parseTileParam(req.params.y);

      const settings = await databaseService.settings.getAllSettings();
      const result = await fetchTerrainTile(z, x, y, settings.elevationEnabled, settings.elevationSourceUrl);

      if ('code' in result) {
        res.set('Cache-Control', 'no-store');
        fail(res, result.status, result.code, result.message);
        return;
      }

      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=604800, immutable');
      res.send(result.png);
    } catch (error) {
      logger.error('Error in GET /api/elevation/tiles/:z/:x/:y:', error);
      res.set('Cache-Control', 'no-store');
      fail(res, 500, 'ELEVATION_TILE_FAILED', 'Failed to fetch terrain tile.');
    }
  }
);

export default router;
