/**
 * Elevation service — orchestrates a terrain link profile between two
 * coordinates (#4111 Phase 1). Holds no state of its own beyond what the
 * providers it calls cache internally (see `elevationProvider.ts`).
 *
 * Validation, sample-count clamping, and distance/interpolation math live
 * here; DEM sampling is delegated to `resolveProvider(sourceUrl)`.
 */

import { calculateDistance } from '../../utils/distance.js';
import { interpolateGreatCircle, type LatLng } from '../../utils/greatCircle.js';
import {
  detectProviderType,
  resolveProvider,
  fetchTerrariumTilePng,
  isValidTileCoord,
  DEFAULT_TERRARIUM_URL,
  type ProviderType,
} from './elevationProvider.js';
import { SsrfBlockedError } from '../utils/ssrfGuard.js';

export interface ProfileSample {
  distance: number;
  lat: number;
  lng: number;
  elevation: number | null;
}

export interface ProfileResult {
  distanceMeters: number;
  provider: ProviderType;
  samples: ProfileSample[];
}

/** Shape consumed by the route layer's `fail()` helper. */
export interface ProfileError {
  code: string;
  message: string;
  status: number;
}

export const MIN_SAMPLES = 64;
export const MAX_SAMPLES = 512;
export const DEFAULT_SAMPLES = 256;
export const MAX_PATH_KM = 500;

/** Below this distance (km), two points are treated as identical (~1mm). */
const IDENTICAL_POINT_EPSILON_KM = 1e-6;

function isValidLat(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

function isValidLng(lng: number): boolean {
  return Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Validates and computes a terrain link profile between `pointA` and
 * `pointB`, sampling `samples` (clamped `MIN_SAMPLES..MAX_SAMPLES`, default
 * `DEFAULT_SAMPLES`) evenly spaced points along the great-circle path.
 *
 * Validation order (first failure wins):
 *  1. Both points have valid lat/lng ranges -> `INVALID_COORDINATES`.
 *  2. Points are not (near-)identical -> `IDENTICAL_POINTS`.
 *  3. Path length <= `MAX_PATH_KM` -> `PATH_TOO_LONG`.
 *
 * Never throws for these expected-input cases — returns a `ProfileError`
 * instead, which the route layer maps onto `fail()`. Provider-level fetch
 * failures never throw either (see `elevationProvider.ts`) — they surface
 * as `elevation: null` on the affected samples.
 */
export async function computeProfile(
  input: { pointA: LatLng; pointB: LatLng; samples?: number },
  sourceUrl: string | undefined
): Promise<ProfileResult | ProfileError> {
  const { pointA, pointB, samples } = input;

  if (
    !pointA ||
    !pointB ||
    !isValidLat(pointA.lat) ||
    !isValidLng(pointA.lng) ||
    !isValidLat(pointB.lat) ||
    !isValidLng(pointB.lng)
  ) {
    return {
      code: 'INVALID_COORDINATES',
      message: 'pointA and pointB must have lat in [-90,90] and lng in [-180,180].',
      status: 400,
    };
  }

  const distanceKm = calculateDistance(pointA.lat, pointA.lng, pointB.lat, pointB.lng);

  if (distanceKm < IDENTICAL_POINT_EPSILON_KM) {
    return {
      code: 'IDENTICAL_POINTS',
      message: 'pointA and pointB must not be the same location.',
      status: 400,
    };
  }

  if (distanceKm > MAX_PATH_KM) {
    return {
      code: 'PATH_TOO_LONG',
      message: `Path distance (${distanceKm.toFixed(1)} km) exceeds the ${MAX_PATH_KM} km maximum.`,
      status: 400,
    };
  }

  const requestedSamples =
    typeof samples === 'number' && Number.isFinite(samples) ? samples : DEFAULT_SAMPLES;
  const n = clamp(Math.round(requestedSamples), MIN_SAMPLES, MAX_SAMPLES);

  const points = interpolateGreatCircle(pointA, pointB, n);
  const provider = resolveProvider(sourceUrl);
  const elevations = await provider.sample(points);

  const distanceMeters = distanceKm * 1000;
  const denom = Math.max(n - 1, 1);
  const samplesOut: ProfileSample[] = points.map((point, i) => ({
    distance: (distanceMeters * i) / denom,
    lat: point.lat,
    lng: point.lng,
    elevation: elevations[i] ?? null,
  }));

  return { distanceMeters, provider: provider.type, samples: samplesOut };
}

export interface TestResult {
  success: boolean;
  detectedType: ProviderType;
  sampleElevation: number | null;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
}

/**
 * Default probe coordinate for `testSource` when the caller doesn't supply
 * one: the summit of Mount Everest (~8848 m). A mid/high-elevation land
 * point is deliberately chosen over sea level so a working provider can be
 * distinguished from one that always returns void/0 (an ocean point would
 * make a broken terrarium source that always returns 0 look "successful").
 */
const DEFAULT_PROBE: LatLng = { lat: 27.9881, lng: 86.925 };

/**
 * Probes a candidate elevation source URL: detects its provider type, times
 * a single sample of a known coordinate, and reports success/failure.
 * Models `tileServerTest.ts`'s `/test` handler pattern. Never throws —
 * fetch/SSRF failures are caught and reported via `TestResult.error`.
 */
export async function testSource(url: string, probe?: LatLng): Promise<TestResult> {
  const detectedType = detectProviderType(url);
  const point = probe ?? DEFAULT_PROBE;
  const startTime = Date.now();

  try {
    const provider = resolveProvider(url);
    const [sampleElevation] = await provider.sample([point]);
    const latencyMs = Date.now() - startTime;

    if (sampleElevation == null) {
      return {
        success: false,
        detectedType,
        sampleElevation: null,
        latencyMs,
        error: 'No elevation data returned for the probe coordinate.',
      };
    }

    return { success: true, detectedType, sampleElevation, latencyMs };
  } catch (err) {
    // Providers are designed to never throw out of sample() (fetch/decode
    // failures degrade to null); this catch is defense-in-depth in case a
    // future provider or SsrfBlockedError still surfaces here.
    const latencyMs = Date.now() - startTime;
    const message =
      err instanceof SsrfBlockedError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { success: false, detectedType, sampleElevation: null, latencyMs, error: message };
  }
}

/**
 * Non-secret capability summary derived from settings (#3826 Phase 2 WP-A).
 * The frontend needs to know whether to offer the 3D toggle before rendering
 * it, but `elevationSourceUrl` is a secret setting stripped for non-admins —
 * so provider type must be resolved server-side and exposed as a boolean.
 */
export interface ElevationCapabilities {
  enabled: boolean;
  terrainTiles: boolean;
  provider: ProviderType;
}

/**
 * Derives elevation/terrain-tile capabilities from raw settings values. Pure
 * (no network I/O) — provider type detection is a string-shape check, not a
 * probe.
 *
 * - `enabled` mirrors the same `elevationEnabled !== 'false'` gate used by
 *   `POST /profile`.
 * - `provider` is `detectProviderType` on the configured `sourceUrl`, or the
 *   default terrarium URL when unset/empty.
 * - `terrainTiles` is true only when both enabled AND the provider is
 *   terrarium — a configured JSON point source never serves DEM tiles (no
 *   silent fallback to the public AWS terrarium source; see spec §2.1).
 */
export function getElevationCapabilities(
  elevationEnabled: string | undefined,
  sourceUrl: string | undefined,
): ElevationCapabilities {
  const enabled = elevationEnabled !== 'false';
  const url = sourceUrl && sourceUrl.trim().length > 0 ? sourceUrl.trim() : DEFAULT_TERRARIUM_URL;
  const provider = detectProviderType(url);
  const terrainTiles = enabled && provider === 'terrarium';
  return { enabled, terrainTiles, provider };
}

/** Shape returned by `fetchTerrainTile` on any failure branch. */
export interface TileError {
  code: string;
  status: number;
  message: string;
}

/**
 * Resolves the terrain tile bytes for `z/x/y`, honoring `elevationSourceUrl`
 * (#3826 Phase 2 WP-A, DEM tile proxy). Validation order (first failure
 * wins), matching spec §3.2:
 *  1. `elevationEnabled === 'false'`         -> `ELEVATION_DISABLED` (403).
 *  2. Configured provider is JSON (no tiles) -> `TERRAIN_TILES_UNAVAILABLE` (409).
 *     (JSON never falls back to the public terrarium source — see §2.1.)
 *  3. Invalid `z/x/y`                        -> `INVALID_TILE_COORDS` (400).
 *  4. Upstream miss/failure                  -> `TILE_FETCH_FAILED` (502).
 *  5. Success                                -> `{ png }`.
 *
 * Never throws — `fetchTerrariumTilePng` degrades all fetch/SSRF/decode
 * failures to `null`, which this maps onto `TILE_FETCH_FAILED`.
 */
export async function fetchTerrainTile(
  z: number,
  x: number,
  y: number,
  elevationEnabled: string | undefined,
  sourceUrl: string | undefined,
): Promise<{ png: Buffer } | TileError> {
  const caps = getElevationCapabilities(elevationEnabled, sourceUrl);

  if (!caps.enabled) {
    return {
      code: 'ELEVATION_DISABLED',
      status: 403,
      message: 'Elevation is disabled on this server.',
    };
  }

  if (caps.provider !== 'terrarium') {
    return {
      code: 'TERRAIN_TILES_UNAVAILABLE',
      status: 409,
      message: 'Terrain tiles are not available with the configured elevation source.',
    };
  }

  if (!isValidTileCoord(z, x, y)) {
    return {
      code: 'INVALID_TILE_COORDS',
      status: 400,
      message: 'Invalid tile coordinates.',
    };
  }

  const url = sourceUrl && sourceUrl.trim().length > 0 ? sourceUrl.trim() : DEFAULT_TERRARIUM_URL;
  const png = await fetchTerrariumTilePng(url, z, x, y);
  if (!png) {
    return {
      code: 'TILE_FETCH_FAILED',
      status: 502,
      message: 'Failed to fetch terrain tile from the upstream source.',
    };
  }

  return { png };
}
