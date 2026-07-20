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

  describe('GET /elevation/capabilities (#3826 Phase 2 WP-A)', () => {
    it('default settings -> enabled:true, terrainTiles:true, provider:terrarium, enveloped', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get('/elevation/capabilities');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({ enabled: true, terrainTiles: true, provider: 'terrarium' });
    });

    it('elevationEnabled=false -> enabled:false, terrainTiles:false', async () => {
      await harness.db.settings.setSetting('elevationEnabled', 'false');

      const agent = await harness.loginAs(null);
      const res = await agent.get('/elevation/capabilities');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ enabled: false, terrainTiles: false, provider: 'terrarium' });
    });

    it('JSON elevationSourceUrl -> terrainTiles:false, provider:json (no URL leak)', async () => {
      await harness.db.settings.setSetting(
        'elevationSourceUrl',
        'https://api.example.com/v1/dem?key=supersecret'
      );

      const agent = await harness.loginAs(null);
      const res = await agent.get('/elevation/capabilities');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ enabled: true, terrainTiles: false, provider: 'json' });
      expect(JSON.stringify(res.body)).not.toContain('supersecret');
    });

    it('anonymous request succeeds (public/optionalAuth)', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get('/elevation/capabilities');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /elevation/tiles/:z/:x/:y (#3826 Phase 2 WP-A, DEM tile proxy)', () => {
    it('default provider -> 200, image/png, immutable Cache-Control, anonymous succeeds', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get('/elevation/tiles/8/40/96');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^image\/png/);
      expect(res.headers['cache-control']).toContain('immutable');
      expect(res.headers['cache-control']).toContain('public');
      expect(res.headers['cache-control']).toContain('max-age=604800');
      expect(res.body.length).toBeGreaterThan(0);
      expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    });

    it('elevationEnabled=false -> 403 ELEVATION_DISABLED, no-store', async () => {
      await harness.db.settings.setSetting('elevationEnabled', 'false');

      const agent = await harness.loginAs(null);
      const res = await agent.get('/elevation/tiles/8/40/96');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('ELEVATION_DISABLED');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('JSON elevationSourceUrl -> 409 TERRAIN_TILES_UNAVAILABLE, body has no URL/key leak', async () => {
      const secretUrl = 'https://api.example.com/v1/dem?key=supersecret';
      await harness.db.settings.setSetting('elevationSourceUrl', secretUrl);

      const agent = await harness.loginAs(null);
      const res = await agent.get('/elevation/tiles/8/40/96');

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TERRAIN_TILES_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toContain('supersecret');
      expect(JSON.stringify(res.body)).not.toContain(secretUrl);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it.each([
      ['/elevation/tiles/99/1/1', 'zoom beyond MAX_TERRARIUM_TILE_ZOOM'],
      ['/elevation/tiles/8/-1/1', 'negative x'],
      ['/elevation/tiles/8/1/abc', 'non-numeric y'],
    ])('invalid coords (%s: %s) -> 400 INVALID_TILE_COORDS', async (path) => {
      const agent = await harness.loginAs(null);
      const res = await agent.get(path);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_TILE_COORDS');
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('SSRF-blocked upstream -> 502 TILE_FETCH_FAILED, no key leak, no-store', async () => {
      // Distinct tile coord — the raw-PNG LRU is module-scoped/shared across
      // tests in this file, so reusing 8/40/96 would hit the cache warmed by
      // an earlier test and never reach safeFetch.
      mockSafeFetch.mockRejectedValueOnce(new MockSsrfBlockedError('blocked: private IP target'));

      const agent = await harness.loginAs(null);
      const res = await agent.get('/elevation/tiles/8/41/97');

      expect(res.status).toBe(502);
      expect(res.body.code).toBe('TILE_FETCH_FAILED');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(res.body)).not.toContain('private IP target');
    });

    it('upstream non-OK response -> 502 TILE_FETCH_FAILED', async () => {
      mockSafeFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const agent = await harness.loginAs(null);
      const res = await agent.get('/elevation/tiles/8/42/98');

      expect(res.status).toBe(502);
      expect(res.body.code).toBe('TILE_FETCH_FAILED');
    });
  });
});
