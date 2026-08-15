/**
 * Predictive RF coverage API (#4727).
 *
 * `POST /api/rf/coverage` — runs a terrain-aware coverage sweep from a given
 * position and radio configuration, returning one reach distance per azimuth
 * plus the model's assumptions.
 *
 * **Authenticated, unlike `/api/elevation/profile`.** A profile is one path;
 * a sweep fans out to thousands of terrain samples across many tiles, so it
 * carries its own stricter limiter (`rfCoverageLimiter`) and requires
 * `nodes:read` rather than being public. It is a planning tool, not a page
 * decoration.
 *
 * Note what that gate means in practice. `nodes` is a per-source resource, so
 * `requirePermission('nodes', 'read')` with no source to scope to resolves via
 * `checkPermissionAsync`'s union branch: it passes for a user holding
 * `nodes:read` on ANY source, and a global (sourceId-null) nodes grant does
 * not satisfy it at all. That is the right bar here — the endpoint takes its
 * origin from the request rather than from a configured radio, so there is no
 * single source to scope to, and "can read node data somewhere" is the
 * meaningful threshold.
 *
 * **Reads only.** Nothing here touches a radio — the prediction is computed
 * from stored terrain, so there is no TX-disabled interaction to consider.
 * That remains true only while this endpoint stays passive; an active
 * measurement mode would need its own endpoint and its own guards.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requirePermission } from '../auth/authMiddleware.js';
import { rfCoverageLimiter } from '../middleware/rateLimiters.js';
import { ok, fail } from '../utils/apiResponse.js';
import { computeCoverage, type CoverageParams } from '../services/rf/coverageSweep.js';

const router = Router();

/** Meshtastic LoRa lives in the ISM bands; anything outside is a typo or abuse. */
const MIN_FREQ_HZ = 100e6;
const MAX_FREQ_HZ = 3e9;

/** Antenna heights above ground. The upper bound is a sanity cap, not physics. */
const MAX_ANTENNA_M = 1000;

function isLatLng(v: unknown): v is { lat: number; lng: number } {
  const o = v as { lat?: unknown; lng?: unknown } | null;
  return !!o
    && typeof o.lat === 'number' && Number.isFinite(o.lat) && o.lat >= -90 && o.lat <= 90
    && typeof o.lng === 'number' && Number.isFinite(o.lng) && o.lng >= -180 && o.lng <= 180;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

router.post(
  '/coverage',
  requirePermission('nodes', 'read'),
  rfCoverageLimiter,
  async (req: Request, res: Response) => {
    try {
      const settings = await databaseService.settings.getAllSettings();
      if (settings.elevationEnabled === 'false') {
        // Without terrain this degrades to a plain free-space circle, which
        // looks like a prediction while modelling nothing. Refuse instead.
        return fail(res, 403, 'ELEVATION_DISABLED',
          'Coverage prediction needs terrain data, and elevation lookups are disabled on this server.');
      }

      const b = req.body ?? {};
      if (!isLatLng(b.origin)) {
        return fail(res, 400, 'INVALID_ORIGIN', 'origin must be { lat, lng } within valid coordinate ranges.');
      }

      const frequencyHz = num(b.frequencyHz, 915e6);
      if (frequencyHz < MIN_FREQ_HZ || frequencyHz > MAX_FREQ_HZ) {
        return fail(res, 400, 'INVALID_FREQUENCY',
          `frequencyHz must be between ${MIN_FREQ_HZ} and ${MAX_FREQ_HZ}.`);
      }

      const params: CoverageParams = {
        origin: b.origin,
        // Heights are clamped rather than rejected: they arrive from a slider.
        txHeightM: clamp(num(b.txHeightM, 10), 0, MAX_ANTENNA_M),
        rxHeightM: clamp(num(b.rxHeightM, 2), 0, MAX_ANTENNA_M),
        frequencyHz,
        budget: {
          txPowerDbm: clamp(num(b.txPowerDbm, 30), -30, 60),
          txGainDbi: clamp(num(b.txGainDbi, 2), -10, 40),
          rxGainDbi: clamp(num(b.rxGainDbi, 2), -10, 40),
          lossesDb: clamp(num(b.lossesDb, 1), 0, 40),
          // LoRa's real sensitivity is preset-dependent and very low; the
          // default matches a long-range preset rather than a generic radio.
          sensitivityDbm: clamp(num(b.sensitivityDbm, -130), -200, 0),
        },
        // Bounds are enforced again inside computeCoverage — this endpoint is
        // not the only possible caller of the sweep.
        radiusKm: num(b.radiusKm, 15),
        azimuthCount: num(b.azimuthCount, 72),
        samplesPerRadial: num(b.samplesPerRadial, 96),
      };

      ok(res, await computeCoverage(params, settings.elevationSourceUrl));
    } catch (error) {
      logger.error('[API] Error computing RF coverage:', error);
      fail(res, 500, 'RF_COVERAGE_FAILED', 'Failed to compute coverage prediction.');
    }
  },
);

export default router;
