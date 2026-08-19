/**
 * GNSS Routes tests (#4729).
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md: real
 * session + real optionalAuth + the live singleton DatabaseService. The only
 * mock is `safeFetch` (ssrfGuard) — the sole outbound-network collaborator —
 * so the real `tleService` parsing/caching and real `computeSkyView` compute
 * run, but no request ever hits the network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockSafeFetch = vi.hoisted(() => vi.fn());
const MockSsrfBlockedError = vi.hoisted(
  () =>
    class SsrfBlockedError extends Error {
      reason: string;
      constructor(message: string, reason = 'blocked') {
        super(message);
        this.name = 'SsrfBlockedError';
        this.reason = reason;
      }
    }
);
vi.mock('../utils/ssrfGuard.js', () => ({
  safeFetch: mockSafeFetch,
  SsrfBlockedError: MockSsrfBlockedError,
}));

import gnssRoutes from './gnssRoutes.js';
import { tleService } from '../services/gnss/tleService.js';
import { GPS_TLE_FIXTURE } from '../services/gnss/gpsTleFixture.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

// A full 32-sat TLE body built from the fixture, so skyview returns a realistic
// visible count + non-null DOP.
const TLE_BODY = GPS_TLE_FIXTURE.map((t) => `${t.name}\n${t.line1}\n${t.line2}`).join('\n');

function textResponse(body: string, ok = true, status = 200) {
  return { ok, status, text: async () => body };
}

// Florida reference observer + the fixture's paired instant.
const FLORIDA = { lat: 26.12, lon: -80.14 };
const FIXTURE_TIME_MS = new Date('2026-08-18T12:00:00Z').getTime();

describe('gnssRoutes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/gnss', gnssRoutes),
    });
    tleService.__resetForTests();
    mockSafeFetch.mockReset();
    mockSafeFetch.mockResolvedValue(textResponse(TLE_BODY));
  });

  afterEach(async () => {
    await harness.cleanup();
    tleService.__resetForTests();
  });

  describe('POST /gnss/skyview', () => {
    it('happy path (anonymous, Florida) returns visible sats + DOP', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent
        .post('/gnss/skyview')
        .send({ ...FLORIDA, timeMs: FIXTURE_TIME_MS });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.visibleCount).toBeGreaterThan(0);
      expect(res.body.data.satellites.length).toBe(res.body.data.visibleCount);
      expect(res.body.data.dop).not.toBeNull();
      expect(res.body.data.dop.gdop).toBeGreaterThan(0);
      expect(res.body.data.constellations).toEqual(['gps']);
      expect(res.body.data.elevationMaskDeg).toBe(5);
      const sat = res.body.data.satellites[0];
      expect(sat.elDeg).toBeGreaterThanOrEqual(5);
      expect(sat.azDeg).toBeGreaterThanOrEqual(0);
      expect(sat.azDeg).toBeLessThan(360);
      expect(sat.rangeKm).toBeGreaterThan(20000);
    });

    it('respects a custom elevation mask', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent
        .post('/gnss/skyview')
        .send({ ...FLORIDA, timeMs: FIXTURE_TIME_MS, elevationMaskDeg: 89 });

      expect(res.status).toBe(200);
      expect(res.body.data.visibleCount).toBe(0);
      expect(res.body.data.dop).toBeNull();
    });

    it('rejects out-of-range latitude with 400 INVALID_INPUT', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post('/gnss/skyview').send({ lat: 999, lon: 0 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_INPUT');
    });

    it('rejects a missing lon with 400 INVALID_INPUT', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post('/gnss/skyview').send({ lat: 26 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_INPUT');
    });

    it('rejects a not-yet-enabled constellation with 400 INVALID_INPUT', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent
        .post('/gnss/skyview')
        .send({ ...FLORIDA, constellations: ['galileo'] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_INPUT');
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('returns 503 TLE_UNAVAILABLE when TLE data cannot be fetched', async () => {
      mockSafeFetch.mockReset();
      mockSafeFetch.mockRejectedValue(new Error('network down'));
      const agent = await harness.loginAs(null);
      const res = await agent.post('/gnss/skyview').send({ ...FLORIDA });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('TLE_UNAVAILABLE');
    });
  });

  describe('POST /gnss/dop', () => {
    it('happy path returns a grid of GDOP points', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post('/gnss/dop').send({
        bbox: { minLat: 25, minLon: -81, maxLat: 27, maxLon: -79 },
        stepDeg: 1,
        timeMs: FIXTURE_TIME_MS,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.points)).toBe(true);
      // 3x3 grid (span 2 / step 1 -> 3 points each axis).
      expect(res.body.data.cellCount).toBe(9);
      expect(res.body.data.points).toHaveLength(9);
      expect(res.body.data.clamped).toBe(false);
      for (const p of res.body.data.points) {
        expect(typeof p.lat).toBe('number');
        expect(typeof p.lon).toBe('number');
        // gdop is a number or null (fewer than 4 sats over a cell).
        expect(p.gdop === null || typeof p.gdop === 'number').toBe(true);
      }
    });

    it('clamps an oversized grid instead of truncating', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post('/gnss/dop').send({
        // 160° x 340° span at 0.5° step -> ~218k cells, far over the 2500 cap.
        bbox: { minLat: -80, minLon: -170, maxLat: 80, maxLon: 170 },
        stepDeg: 0.5,
        timeMs: FIXTURE_TIME_MS,
      });

      expect(res.status).toBe(200);
      expect(res.body.data.clamped).toBe(true);
      expect(res.body.data.stepDeg).toBeGreaterThan(0.5);
      expect(res.body.data.requestedStepDeg).toBe(0.5);
      expect(res.body.data.cellCount).toBeLessThanOrEqual(2500);
      expect(res.body.data.cellCount).toBeGreaterThan(0);
    });

    it('rejects an inverted bbox with 400 INVALID_INPUT', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post('/gnss/dop').send({
        bbox: { minLat: 27, minLon: -79, maxLat: 25, maxLon: -81 },
        stepDeg: 1,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_INPUT');
    });

    it('rejects a non-positive stepDeg with 400 INVALID_INPUT', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post('/gnss/dop').send({
        bbox: { minLat: 25, minLon: -81, maxLat: 27, maxLon: -79 },
        stepDeg: 0,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_INPUT');
    });

    it('rejects a missing bbox with 400 INVALID_INPUT', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post('/gnss/dop').send({ stepDeg: 1 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_INPUT');
    });
  });
});
