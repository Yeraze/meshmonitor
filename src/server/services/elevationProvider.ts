/**
 * Elevation provider abstraction for the Terrain Link Profile feature
 * (#4111 Phase 1).
 *
 * Two provider implementations:
 *  - `TerrariumTileProvider` — samples Mapzen/AWS "terrarium" encoded RGB PNG
 *    DEM tiles (the default, free, no-API-key public dataset).
 *  - `JsonPointProvider` — batches point queries against an Open-Topo-Data
 *    compatible JSON HTTP API (for self-hosted / API-key-gated sources).
 *
 * Both providers are deliberately resilient: a fetch/decode failure for one
 * tile or one batch degrades to `null` elevations for the affected points
 * rather than throwing, so a single unreachable tile server never aborts an
 * entire profile request (see `elevationService.computeProfile`).
 *
 * All outbound HTTP goes through `safeFetch` (SSRF-guarded) — never a raw
 * `fetch`.
 */

import { PNG } from 'pngjs';
import { logger } from '../../utils/logger.js';
import { safeFetch, SsrfBlockedError } from '../utils/ssrfGuard.js';
import { LruCache } from '../utils/lruCache.js';
import { lngLatToTilePixel, type LatLng } from '../../utils/greatCircle.js';

export type ProviderType = 'terrarium' | 'json';

export interface ElevationProvider {
  readonly type: ProviderType;
  /** Returns one elevation (meters) per input point; null where DEM data is unavailable. */
  sample(points: LatLng[]): Promise<(number | null)[]>;
}

/** Default public terrarium tile source (Mapzen/AWS "elevation-tiles-prod", free, no key). */
export const DEFAULT_TERRARIUM_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/** Fixed zoom level used for all terrarium sampling — ~38 m/px @ equator, bounds tile fan-out. */
export const TERRARIUM_ZOOM = 12;

/** Terrarium tiles are always 256x256 px. */
export const TILE_SIZE = 256;

/** Max decoded tiles held in the module-scope LRU cache (see cache below for the memory budget). */
export const TILE_CACHE_MAX = 64;

/** Max cached JSON point samples (keyed by rounded lat,lng). */
const JSON_CACHE_MAX = 10_000;

/** Open-Topo-Data max locations per request. */
const JSON_BATCH_SIZE = 100;

/**
 * URL-shape detection: a `{z}`/`{x}`/`{y}` slippy-tile template is a
 * terrarium PNG source; anything else is treated as an Open-Topo-Data
 * compatible JSON point API.
 */
export function detectProviderType(url: string): ProviderType {
  if (url.includes('{z}') && url.includes('{x}') && url.includes('{y}')) {
    return 'terrarium';
  }
  return 'json';
}

/**
 * Decode a terrarium-encoded RGB(A) PNG tile buffer into a flat Float32Array
 * of elevations in meters (row-major, length = width*height).
 *
 * Terrarium encoding: `elevation = (R*256 + G + B/256) - 32768`.
 *
 * pngjs's synchronous parser always upconverts decoded pixel data to RGBA
 * (4 bytes/pixel) regardless of the source PNG's color type, so indexing by
 * `pixelIndex*4` is safe for grayscale/RGB/RGBA terrarium tiles alike.
 *
 * Float32 (not Float64) is intentional: terrarium values are exact multiples
 * of 1/256 m within ±32768 m — fully representable in f32 — and it halves
 * cache memory.
 */
export function decodeTerrariumTile(
  png: Buffer
): { width: number; height: number; data: Float32Array } {
  const decoded = PNG.sync.read(png);
  const { width, height, data } = decoded;
  const out = new Float32Array(width * height);

  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    out[i] = r * 256 + g + b / 256 - 32768;
  }

  return { width, height, data: out };
}

/**
 * Module-scope terrarium tile cache, shared across all `TerrariumTileProvider`
 * instances/requests. Keyed `"z/x/y"`.
 *
 * Worst-case memory budget: 256*256 px * 4 B (Float32) = 256 KB/tile * 64
 * tiles = 16 MB steady-state ceiling (plus Map/key overhead, negligible). A
 * 500 km path at z=12 crosses well under 64 tiles, so one max-length profile
 * still fits in cache; repeat/nearby queries hit warm tiles.
 */
const tileCache = new LruCache<string, Float32Array>(TILE_CACHE_MAX);

/**
 * Samples a terrarium-encoded slippy-tile DEM source (e.g. the default
 * Mapzen/AWS `elevation-tiles-prod` dataset). Points are grouped by the tile
 * they fall in so each unique tile is fetched/decoded at most once per
 * `sample()` call (plus whatever the shared LRU cache already has warm).
 *
 * A fetch failure, non-OK HTTP response, or decode error for a given tile
 * degrades to `null` elevations for that tile's points only — `sample()`
 * itself never throws. Ocean returns a real (~0 m) terrarium value, which is
 * a legitimate sample, not a void.
 */
export class TerrariumTileProvider implements ElevationProvider {
  readonly type: ProviderType = 'terrarium';

  constructor(private readonly urlTemplate: string) {}

  async sample(points: LatLng[]): Promise<(number | null)[]> {
    const results: (number | null)[] = new Array(points.length).fill(null);

    interface TileGroup {
      x: number;
      y: number;
      members: Array<{ index: number; px: number; py: number }>;
    }
    const tileGroups = new Map<string, TileGroup>();

    for (let index = 0; index < points.length; index++) {
      const { lat, lng } = points[index];
      const { x, y, px, py } = lngLatToTilePixel(lat, lng, TERRARIUM_ZOOM, TILE_SIZE);
      const key = `${TERRARIUM_ZOOM}/${x}/${y}`;
      let group = tileGroups.get(key);
      if (!group) {
        group = { x, y, members: [] };
        tileGroups.set(key, group);
      }
      group.members.push({ index, px, py });
    }

    await Promise.all(
      Array.from(tileGroups.entries()).map(async ([key, group]) => {
        const tile = await this.getTile(key, group.x, group.y);
        if (!tile) return; // Fetch/decode failure — leave this tile's points as null.
        for (const { index, px, py } of group.members) {
          results[index] = tile[py * TILE_SIZE + px];
        }
      })
    );

    return results;
  }

  /** Fetches (or reads from cache) and decodes a single tile. Never throws. */
  private async getTile(key: string, x: number, y: number): Promise<Float32Array | null> {
    const cached = tileCache.get(key);
    if (cached) return cached;

    const url = this.urlTemplate
      .replace('{z}', String(TERRARIUM_ZOOM))
      .replace('{x}', String(x))
      .replace('{y}', String(y));

    try {
      const response = await safeFetch(url);
      if (!response.ok) {
        logger.debug(`Elevation: terrarium tile fetch returned ${response.status} for ${key}`);
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const { data } = decodeTerrariumTile(buffer);
      tileCache.set(key, data);
      return data;
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        logger.warn(`Elevation: terrarium tile fetch blocked by SSRF guard for ${key}: ${err.message}`);
      } else {
        logger.debug(`Elevation: terrarium tile fetch/decode failed for ${key}:`, err);
      }
      return null;
    }
  }
}

/** Rounds a coordinate to a stable cache key (~1.1m precision at the equator). */
function jsonCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

/** Module-scope JSON point-sample cache, shared across all `JsonPointProvider` instances. */
const jsonCache = new LruCache<string, number | null>(JSON_CACHE_MAX);

interface OpenTopoDataResult {
  elevation: number | null;
  location?: { lat: number; lng: number };
}
interface OpenTopoDataResponse {
  results?: OpenTopoDataResult[];
}

/**
 * Samples an Open-Topo-Data compatible JSON point API.
 *
 * Accepted URL template shapes:
 *  - Contains a `{locations}` placeholder — substituted with a
 *    `lat,lng|lat,lng|...` pipe-delimited, URI-encoded batch string.
 *  - No placeholder — the batch string is appended as a `locations` query
 *    parameter (`?locations=...` or `&locations=...` if the template already
 *    has a query string), matching Open-Topo-Data's own documented query
 *    style (`GET /v1/{dataset}?locations=lat,lng|lat,lng`).
 *
 * Points are looked up in the shared cache first; only cache misses are
 * batched (max 100 locations/request, Open-Topo-Data's limit) and fetched.
 * A request/parse failure degrades that batch's points to `null` — it does
 * not cache the failure, so a later call can retry. An explicit
 * `elevation: null` in a successful response *is* cached (it is a real
 * "no data" answer from the provider, not a transient failure).
 */
export class JsonPointProvider implements ElevationProvider {
  readonly type: ProviderType = 'json';

  constructor(private readonly urlTemplate: string) {}

  async sample(points: LatLng[]): Promise<(number | null)[]> {
    const results: (number | null)[] = new Array(points.length).fill(null);
    const misses: number[] = [];

    for (let index = 0; index < points.length; index++) {
      const key = jsonCacheKey(points[index].lat, points[index].lng);
      if (jsonCache.has(key)) {
        results[index] = jsonCache.get(key) ?? null;
      } else {
        misses.push(index);
      }
    }

    for (let start = 0; start < misses.length; start += JSON_BATCH_SIZE) {
      const batch = misses.slice(start, start + JSON_BATCH_SIZE);
      await this.fetchBatch(batch, points, results);
    }

    return results;
  }

  private buildUrl(locations: string): string {
    const encoded = encodeURIComponent(locations);
    if (this.urlTemplate.includes('{locations}')) {
      return this.urlTemplate.replace('{locations}', encoded);
    }
    const separator = this.urlTemplate.includes('?') ? '&' : '?';
    return `${this.urlTemplate}${separator}locations=${encoded}`;
  }

  private async fetchBatch(
    indices: number[],
    points: LatLng[],
    results: (number | null)[]
  ): Promise<void> {
    const locations = indices.map((i) => `${points[i].lat},${points[i].lng}`).join('|');
    const url = this.buildUrl(locations);

    try {
      const response = await safeFetch(url);
      if (!response.ok) {
        logger.debug(`Elevation: JSON provider fetch returned ${response.status}`);
        for (const i of indices) results[i] = null;
        return;
      }
      const body = (await response.json()) as OpenTopoDataResponse;
      const items = body.results ?? [];
      for (let j = 0; j < indices.length; j++) {
        const index = indices[j];
        const elevation = items[j]?.elevation ?? null;
        results[index] = elevation;
        jsonCache.set(jsonCacheKey(points[index].lat, points[index].lng), elevation);
      }
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        logger.warn(`Elevation: JSON provider fetch blocked by SSRF guard: ${err.message}`);
      } else {
        logger.debug('Elevation: JSON provider fetch/parse failed:', err);
      }
      for (const i of indices) results[i] = null;
    }
  }
}

/**
 * Builds the elevation provider implied by a configured source URL.
 * Empty/unset `sourceUrl` falls back to the default public terrarium source.
 */
export function resolveProvider(sourceUrl: string | undefined): ElevationProvider {
  const url = sourceUrl && sourceUrl.trim().length > 0 ? sourceUrl.trim() : DEFAULT_TERRARIUM_URL;
  const type = detectProviderType(url);
  return type === 'terrarium' ? new TerrariumTileProvider(url) : new JsonPointProvider(url);
}
