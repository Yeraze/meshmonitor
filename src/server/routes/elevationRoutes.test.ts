/**
 * Elevation Routes — WP3 route tests (#4111 Phase 1)
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md: real
 * session + real optionalAuth/requirePermission + the live singleton
 * DatabaseService against a `:memory:` SQLite DB. The only mock is
 * `safeFetch` (ssrfGuard) — the sole non-DB outbound-network collaborator —
 * so tests never hit the real network but do exercise real settings/
 * permission SQL.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PNG } from 'pngjs';
import elevationRoutes from './elevationRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

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

/** Builds a uniform terrarium-encoded 256x256 PNG tile for a given elevation (meters). */
function makeUniformTerrariumTile(elevationMeters: number): Buffer {
  const raw = elevationMeters + 32768;
  const r = Math.floor(raw / 256);
  const g = Math.round(raw - r * 256);
  const png = new PNG({ width: 256, height: 256 });
  for (let i = 0; i < 256 * 256; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = 0;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

function fakeTileResponse(elevationMeters = 100): {
  ok: boolean;
  status: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
} {
  const buf = makeUniformTerrariumTile(elevationMeters);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  };
}

// Two real-world points ~140 km apart (San Francisco -> Sacramento), well
// under the 500 km MAX_PATH_KM cap.
const POINT_A = { lat: 37.7749, lng: -122.4194 };
const POINT_B = { lat: 38.5816, lng: -121.4944 };

describe('elevationRoutes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/elevation', elevationRoutes),
    });
    mockSafeFetch.mockReset();
    mockSafeFetch.mockResolvedValue(fakeTileResponse());
  });

  afterEach(async () => {
    await harness.cleanup();
    await harness.db.settings.setSetting('elevationEnabled', 'true').catch(() => {});
    await harness.db.settings.setSetting('elevationSourceUrl', '').catch(() => {});
  });

  describe('POST /elevation/profile', () => {
    it('anonymous request returns 200 with success envelope and correct sample count', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent
        .post('/elevation/profile')
        .send({ pointA: POINT_A, pointB: POINT_B, samples: 64 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.samples).toHaveLength(64);
      expect(res.body.data.samples[0].lat).toBeCloseTo(POINT_A.lat, 5);
      expect(res.body.data.samples[0].lng).toBeCloseTo(POINT_A.lng, 5);
      expect(res.body.data.samples[63].lat).toBeCloseTo(POINT_B.lat, 5);
      expect(res.body.data.samples[63].lng).toBeCloseTo(POINT_B.lng, 5);
      expect(res.body.data.distanceMeters).toBeGreaterThan(0);
      expect(res.body.data.provider).toBe('terrarium');
    });

    it('missing pointA/pointB returns 400 INVALID_BODY', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post('/elevation/profile').send({ pointA: POINT_A });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_BODY');
    });

    it('malformed point (non-numeric lat) returns 400 INVALID_BODY', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent
        .post('/elevation/profile')
        .send({ pointA: { lat: 'nope', lng: 0 }, pointB: POINT_B });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_BODY');
    });

    it('out-of-range coordinates return 400 INVALID_COORDINATES', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent
        .post('/elevation/profile')
        .send({ pointA: { lat: 999, lng: 0 }, pointB: POINT_B });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_COORDINATES');
    });

    it('identical points return 400 IDENTICAL_POINTS', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent
        .post('/elevation/profile')
        .send({ pointA: POINT_A, pointB: POINT_A });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IDENTICAL_POINTS');
    });

    it('elevationEnabled=false returns 403 ELEVATION_DISABLED', async () => {
      await harness.db.settings.setSetting('elevationEnabled', 'false');

      const agent = await harness.loginAs(null);
      const res = await agent
        .post('/elevation/profile')
        .send({ pointA: POINT_A, pointB: POINT_B, samples: 64 });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('ELEVATION_DISABLED');
    });
  });

  describe('POST /elevation/test', () => {
    it('anonymous request returns 403', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post('/elevation/test').send({ url: 'https://example.com/{z}/{x}/{y}.png' });

      expect(res.status).toBe(403);
    });

    it('user without settings:write returns 403', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/elevation/test').send({ url: 'https://example.com/{z}/{x}/{y}.png' });

      expect(res.status).toBe(403);
    });

    it('admin returns 200 with success envelope', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/elevation/test').send({ url: 'https://example.com/{z}/{x}/{y}.png' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.detectedType).toBe('terrarium');
    });

    it('user granted settings:write returns 200', async () => {
      await harness.grant(harness.limited.id, 'settings', 'write');
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/elevation/test').send({ url: 'https://example.com/{z}/{x}/{y}.png' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('missing url returns 400 MISSING_URL', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/elevation/test').send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MISSING_URL');
    });
  });
});
