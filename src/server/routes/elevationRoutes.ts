/**
 * Elevation Routes — Terrain Link Profile epic #4111 (Phase 1, backend only)
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
 * No per-route express.json(): server.ts applies a global
 * `app.use(express.json({ limit: '10mb' }))` ahead of apiRouter, matching
 * neighboring routes (analysisRoutes, tileServerTest).
 */

import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { elevationLimiter } from '../middleware/rateLimiters.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';
import { computeProfile, testSource } from '../services/elevationService.js';
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

export default router;
