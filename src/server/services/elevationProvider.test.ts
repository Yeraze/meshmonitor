import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PNG } from 'pngjs';

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

import {
  detectProviderType,
  decodeTerrariumTile,
  resolveProvider,
  sanitizeElevation,
  TerrariumTileProvider,
  JsonPointProvider,
  DEFAULT_TERRARIUM_URL,
  TERRARIUM_ZOOM,
  TILE_SIZE,
} from './elevationProvider.js';
import { lngLatToTilePixel } from '../../utils/greatCircle.js';

/** Builds a raw RGBA PNG buffer where every pixel encodes the same terrarium elevation. */
function encodeTerrariumPixel(elevationMeters: number): { r: number; g: number; b: number } {
  // Only exact integer meters round-trip cleanly through this helper (B stays 0).
  const raw = elevationMeters + 32768;
  const r = Math.floor(raw / 256);
  const g = raw - r * 256;
  return { r, g, b: 0 };
}

function makeUniformTerrariumTile(elevationMeters: number, size: number): Buffer {
  const { r, g, b } = encodeTerrariumPixel(elevationMeters);
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

function fakeResponse(opts: { ok: boolean; status?: number; buffer?: Buffer }) {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    arrayBuffer: async () => {
      const buf = opts.buffer ?? Buffer.alloc(0);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

function fakeJsonResponse(opts: { ok: boolean; status?: number; body?: unknown }) {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: async () => opts.body,
  };
}

beforeEach(() => {
  mockSafeFetch.mockReset();
});

describe('detectProviderType', () => {
  it('detects a {z}/{x}/{y} slippy template as terrarium', () => {
    expect(detectProviderType(DEFAULT_TERRARIUM_URL)).toBe('terrarium');
    expect(detectProviderType('https://example.com/{z}/{x}/{y}.png')).toBe('terrarium');
  });

  it('detects an Open-Topo-Data-style URL as json', () => {
    expect(detectProviderType('https://api.opentopodata.org/v1/mapzen')).toBe('json');
  });

  it('detects a {locations} placeholder template as json', () => {
    expect(detectProviderType('https://api.example.com/v1/dem?locations={locations}')).toBe(
      'json'
    );
  });
});

describe('decodeTerrariumTile', () => {
  it('decodes known R,G,B pixels to the documented elevation formula', () => {
    // Elevation 1000m -> raw = 33768 -> R=131, G=232... verify via formula directly.
    const cases = [1000, 0, -100, 8848];
    const png = new PNG({ width: cases.length, height: 1 });
    for (let i = 0; i < cases.length; i++) {
      const { r, g, b } = encodeTerrariumPixel(cases[i]);
      png.data[i * 4] = r;
      png.data[i * 4 + 1] = g;
      png.data[i * 4 + 2] = b;
      png.data[i * 4 + 3] = 255;
    }
    const buf = PNG.sync.write(png);

    const { width, height, data } = decodeTerrariumTile(buf);
    expect(width).toBe(cases.length);
    expect(height).toBe(1);
    for (let i = 0; i < cases.length; i++) {
      expect(data[i]).toBeCloseTo(cases[i], 5);
    }
  });

  it('decodes an ocean (0m) pixel to exactly 0', () => {
    const buf = makeUniformTerrariumTile(0, 1);
    const { data } = decodeTerrariumTile(buf);
    expect(data[0]).toBeCloseTo(0, 5);
  });

  it('decodes a negative (below-sea-level) pixel correctly', () => {
    const buf = makeUniformTerrariumTile(-86, 1); // roughly Dead Sea shore
    const { data } = decodeTerrariumTile(buf);
    expect(data[0]).toBeCloseTo(-86, 5);
  });
});

describe('sanitizeElevation (#4111 P3 WP-1 DEM void clamp)', () => {
  it('nulls a Terrarium bathymetry void (e.g. Lake Pontchartrain ~-12000m)', () => {
    expect(sanitizeElevation(-12000)).toBeNull();
  });

  it('nulls a value at/below the -500m floor', () => {
    expect(sanitizeElevation(-500.01)).toBeNull();
    expect(sanitizeElevation(-501)).toBeNull();
  });

  it('nulls a defensive out-of-range high value (>9000m)', () => {
    expect(sanitizeElevation(9000.01)).toBeNull();
    expect(sanitizeElevation(20000)).toBeNull();
  });

  it('passes through a valid ocean (0m) sample unchanged', () => {
    expect(sanitizeElevation(0)).toBe(0);
  });

  it('passes through a valid +100m sample unchanged', () => {
    expect(sanitizeElevation(100)).toBe(100);
  });

  it('passes through a valid below-sea-level-but-real sample (e.g. Death Valley -86m)', () => {
    expect(sanitizeElevation(-86)).toBe(-86);
  });

  it('passes through the boundary values (-500m and 9000m) unchanged', () => {
    expect(sanitizeElevation(-500)).toBe(-500);
    expect(sanitizeElevation(9000)).toBe(9000);
  });

  it('nulls a null input', () => {
    expect(sanitizeElevation(null)).toBeNull();
  });

  it('nulls a non-finite input', () => {
    expect(sanitizeElevation(NaN)).toBeNull();
    expect(sanitizeElevation(Infinity)).toBeNull();
  });
});

describe('TerrariumTileProvider.sample', () => {
  const point = { lat: 40.0, lng: -105.0 }; // arbitrary land coordinate

  it('returns the correct elevation for a mocked tile fetch', async () => {
    const tile = makeUniformTerrariumTile(1609, TILE_SIZE); // uniform tile, any pixel = 1609m
    mockSafeFetch.mockResolvedValue(fakeResponse({ ok: true, buffer: tile }));

    const provider = new TerrariumTileProvider(DEFAULT_TERRARIUM_URL);
    const [elevation] = await provider.sample([point]);

    expect(elevation).toBeCloseTo(1609, 5);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockSafeFetch.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('{z}');
    expect(calledUrl).not.toContain('{x}');
    expect(calledUrl).not.toContain('{y}');
  });

  it('caches decoded tiles — a second sample() for the same tile does not refetch', async () => {
    const tile = makeUniformTerrariumTile(2500, TILE_SIZE);
    mockSafeFetch.mockResolvedValue(fakeResponse({ ok: true, buffer: tile }));

    // Use a distinct tile coordinate (offset slightly) so this test's cache
    // entry can't be a hit left over from a previous test in this file.
    const cachePoint = { lat: 41.234, lng: -104.987 };
    const provider = new TerrariumTileProvider(DEFAULT_TERRARIUM_URL);

    const [first] = await provider.sample([cachePoint]);
    const [second] = await provider.sample([cachePoint]);

    expect(first).toBeCloseTo(2500, 5);
    expect(second).toBeCloseTo(2500, 5);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('returns null (never throws) when the tile fetch fails (non-OK response)', async () => {
    mockSafeFetch.mockResolvedValue(fakeResponse({ ok: false, status: 404 }));
    const missingPoint = { lat: 12.345, lng: 67.891 };

    const provider = new TerrariumTileProvider(DEFAULT_TERRARIUM_URL);
    await expect(provider.sample([missingPoint])).resolves.toEqual([null]);
  });

  it('returns null (never throws) when safeFetch rejects with SsrfBlockedError', async () => {
    mockSafeFetch.mockRejectedValue(new MockSsrfBlockedError('blocked target'));
    const blockedPoint = { lat: -12.345, lng: -67.891 };

    const provider = new TerrariumTileProvider(DEFAULT_TERRARIUM_URL);
    await expect(provider.sample([blockedPoint])).resolves.toEqual([null]);
  });

  it('groups multiple points in the same tile into a single fetch', async () => {
    const tile = makeUniformTerrariumTile(500, TILE_SIZE);
    mockSafeFetch.mockResolvedValue(fakeResponse({ ok: true, buffer: tile }));

    // Two points close enough together (at TERRARIUM_ZOOM) to land in the same tile.
    const a = { lat: 50.0001, lng: 10.0001 };
    const b = { lat: 50.0002, lng: 10.0002 };
    const tileA = lngLatToTilePixel(a.lat, a.lng, TERRARIUM_ZOOM, TILE_SIZE);
    const tileB = lngLatToTilePixel(b.lat, b.lng, TERRARIUM_ZOOM, TILE_SIZE);
    expect(tileA.x).toBe(tileB.x);
    expect(tileA.y).toBe(tileB.y);

    const provider = new TerrariumTileProvider(DEFAULT_TERRARIUM_URL);
    const results = await provider.sample([a, b]);

    expect(results).toEqual([500, 500]);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('nulls a Terrarium bathymetry-void pixel (#4111 P3 WP-1)', async () => {
    const tile = makeUniformTerrariumTile(-12000, TILE_SIZE);
    mockSafeFetch.mockResolvedValue(fakeResponse({ ok: true, buffer: tile }));

    const voidPoint = { lat: 30.0, lng: -90.1 }; // roughly Lake Pontchartrain
    const provider = new TerrariumTileProvider(DEFAULT_TERRARIUM_URL);
    const [elevation] = await provider.sample([voidPoint]);

    expect(elevation).toBeNull();
  });

  it('nulls a defensive out-of-range high pixel (>9000m, #4111 P3 WP-1)', async () => {
    const tile = makeUniformTerrariumTile(12000, TILE_SIZE);
    mockSafeFetch.mockResolvedValue(fakeResponse({ ok: true, buffer: tile }));

    const highPoint = { lat: 27.98, lng: 86.92 }; // arbitrary — value is what's under test
    const provider = new TerrariumTileProvider(DEFAULT_TERRARIUM_URL);
    const [elevation] = await provider.sample([highPoint]);

    expect(elevation).toBeNull();
  });
});

describe('JsonPointProvider.sample', () => {
  const template = 'https://api.opentopodata.org/v1/mapzen';

  it('parses elevations from a mocked JSON response', async () => {
    mockSafeFetch.mockResolvedValue(
      fakeJsonResponse({
        ok: true,
        body: {
          results: [
            { elevation: 123.4, location: { lat: 1, lng: 2 } },
            { elevation: 567.8, location: { lat: 3, lng: 4 } },
          ],
        },
      })
    );

    const provider = new JsonPointProvider(template);
    const results = await provider.sample([
      { lat: 1, lng: 2 },
      { lat: 3, lng: 4 },
    ]);

    expect(results).toEqual([123.4, 567.8]);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('maps an explicit null elevation result to null', async () => {
    mockSafeFetch.mockResolvedValue(
      fakeJsonResponse({
        ok: true,
        body: { results: [{ elevation: null, location: { lat: 9, lng: 9 } }] },
      })
    );

    const provider = new JsonPointProvider(template);
    const results = await provider.sample([{ lat: 9, lng: 9 }]);

    expect(results).toEqual([null]);
  });

  it('returns null for all points (never throws) on request failure', async () => {
    mockSafeFetch.mockResolvedValue(fakeJsonResponse({ ok: false, status: 503 }));

    const provider = new JsonPointProvider(template);
    const results = await provider.sample([{ lat: 5, lng: 5 }]);

    expect(results).toEqual([null]);
  });

  it('batches more than 100 locations into multiple requests', async () => {
    mockSafeFetch.mockImplementation(async () =>
      fakeJsonResponse({
        ok: true,
        body: { results: Array.from({ length: 100 }, () => ({ elevation: 42 })) },
      })
    );

    const points = Array.from({ length: 150 }, (_, i) => ({ lat: i * 0.001, lng: i * 0.001 }));
    const provider = new JsonPointProvider(template);
    const results = await provider.sample(points);

    expect(results).toHaveLength(150);
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('nulls a -9999-style no-data sentinel elevation (#4111 P3 WP-1)', async () => {
    mockSafeFetch.mockResolvedValue(
      fakeJsonResponse({
        ok: true,
        body: { results: [{ elevation: -9999, location: { lat: 8, lng: 8 } }] },
      })
    );

    const provider = new JsonPointProvider(template);
    const results = await provider.sample([{ lat: 8, lng: 8 }]);

    expect(results).toEqual([null]);
  });

  it('substitutes a {locations} placeholder when present in the template', async () => {
    mockSafeFetch.mockResolvedValue(
      fakeJsonResponse({ ok: true, body: { results: [{ elevation: 10 }] } })
    );

    const provider = new JsonPointProvider('https://api.example.com/v1/dem?locations={locations}');
    await provider.sample([{ lat: 1.1111, lng: 2.2222 }]);

    const calledUrl = mockSafeFetch.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('{locations}');
    expect(calledUrl).toContain('1.1111');
  });
});

describe('resolveProvider', () => {
  it('returns a terrarium provider for an empty/undefined sourceUrl (default)', () => {
    expect(resolveProvider(undefined).type).toBe('terrarium');
    expect(resolveProvider('').type).toBe('terrarium');
    expect(resolveProvider('   ').type).toBe('terrarium');
  });

  it('returns a terrarium provider for an explicit terrarium template', () => {
    expect(resolveProvider('https://example.com/{z}/{x}/{y}.png').type).toBe('terrarium');
  });

  it('returns a json provider for a non-templated URL', () => {
    expect(resolveProvider('https://api.opentopodata.org/v1/mapzen').type).toBe('json');
  });
});
