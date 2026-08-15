import { describe, it, expect } from 'vitest';
import { interpolateGreatCircle, lngLatToTile, lngLatToTilePixel, destinationPoint } from './greatCircle';
import { calculateDistance } from './distance';

describe('interpolateGreatCircle', () => {
  it('returns exactly `count` points', () => {
    const points = interpolateGreatCircle({ lat: 0, lng: 0 }, { lat: 0, lng: 90 }, 10);
    expect(points).toHaveLength(10);
  });

  it('includes both endpoints inclusive (first == a, last == b)', () => {
    const a = { lat: 40, lng: -105 };
    const b = { lat: 41, lng: -104 };
    const points = interpolateGreatCircle(a, b, 5);
    expect(points[0].lat).toBeCloseTo(a.lat, 6);
    expect(points[0].lng).toBeCloseTo(a.lng, 6);
    expect(points[4].lat).toBeCloseTo(b.lat, 6);
    expect(points[4].lng).toBeCloseTo(b.lng, 6);
  });

  it('computes the correct midpoint for a known equatorial pair', () => {
    // Equator, 0,0 -> 0,90: the great-circle midpoint is 0,45.
    const points = interpolateGreatCircle({ lat: 0, lng: 0 }, { lat: 0, lng: 90 }, 3);
    expect(points[1].lat).toBeCloseTo(0, 6);
    expect(points[1].lng).toBeCloseTo(45, 6);
  });

  it('stays on the short arc across the antimeridian', () => {
    // 179 -> -179 is an 2-degree hop across the antimeridian, not a 358-degree
    // trip the other way around. The midpoint longitude should be ~180/-180,
    // not 0.
    const points = interpolateGreatCircle({ lat: 0, lng: 179 }, { lat: 0, lng: -179 }, 3);
    const midLng = points[1].lng;
    // Midpoint should be near +/-180, i.e. far from 0.
    expect(Math.abs(midLng)).toBeGreaterThan(170);
  });

  it('does not produce NaN for identical points', () => {
    const a = { lat: 12.34, lng: 56.78 };
    const points = interpolateGreatCircle(a, a, 5);
    expect(points).toHaveLength(5);
    for (const p of points) {
      expect(Number.isNaN(p.lat)).toBe(false);
      expect(Number.isNaN(p.lng)).toBe(false);
      expect(p.lat).toBeCloseTo(a.lat, 6);
      expect(p.lng).toBeCloseTo(a.lng, 6);
    }
  });

  it('does not produce NaN for near-antipodal points', () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 0.0000001, lng: 180 };
    const points = interpolateGreatCircle(a, b, 4);
    for (const p of points) {
      expect(Number.isNaN(p.lat)).toBe(false);
      expect(Number.isNaN(p.lng)).toBe(false);
    }
  });
});

describe('lngLatToTile', () => {
  it('matches known slippy-map reference values at zoom 12', () => {
    // Reference: Denver, CO (39.7392, -104.9903) at z=12.
    // https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames
    const { x, y } = lngLatToTile(39.7392, -104.9903, 12);
    expect(x).toBe(853);
    expect(y).toBe(1554);
  });

  it('matches known slippy-map reference values at zoom 0', () => {
    const { x, y } = lngLatToTile(0, 0, 0);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });

  it('clamps latitude beyond the Web-Mercator limit (+90 -> +85.0511 behavior)', () => {
    const atLimit = lngLatToTile(85.0511, 10, 5);
    const beyondLimit = lngLatToTile(89.9, 10, 5);
    expect(beyondLimit).toEqual(atLimit);
  });

  it('clamps latitude beyond the negative Web-Mercator limit', () => {
    const atLimit = lngLatToTile(-85.0511, 10, 5);
    const beyondLimit = lngLatToTile(-89.9, 10, 5);
    expect(beyondLimit).toEqual(atLimit);
  });
});

describe('lngLatToTilePixel', () => {
  it('returns px/py within [0, tileSize) at a mid-tile point', () => {
    const result = lngLatToTilePixel(39.7392, -104.9903, 12, 256);
    expect(result.px).toBeGreaterThanOrEqual(0);
    expect(result.px).toBeLessThan(256);
    expect(result.py).toBeGreaterThanOrEqual(0);
    expect(result.py).toBeLessThan(256);
  });

  it('agrees with lngLatToTile on tile indices', () => {
    const tile = lngLatToTile(39.7392, -104.9903, 12);
    const pixel = lngLatToTilePixel(39.7392, -104.9903, 12, 256);
    expect(pixel.x).toBe(tile.x);
    expect(pixel.y).toBe(tile.y);
  });

  it('keeps px/py in range for coordinates near a tile boundary', () => {
    const result = lngLatToTilePixel(0, 0, 4, 256);
    expect(result.px).toBeGreaterThanOrEqual(0);
    expect(result.px).toBeLessThan(256);
    expect(result.py).toBeGreaterThanOrEqual(0);
    expect(result.py).toBeLessThan(256);
  });
});

describe('destinationPoint (#4727)', () => {
  it('moves north by the requested distance', () => {
    // 1 degree of latitude is ~111.19 km on a sphere of radius 6371 km.
    const d = destinationPoint({ lat: 0, lng: 0 }, 0, 111_195);
    expect(d.lat).toBeCloseTo(1, 2);
    expect(d.lng).toBeCloseTo(0, 6);
  });

  it('agrees with calculateDistance for the distance travelled', () => {
    // Independent check: walk out, then measure back with the Haversine helper.
    const origin = { lat: 30.2672, lng: -97.7431 };
    for (const bearing of [0, 45, 137, 250, 359]) {
      for (const km of [1, 10, 50]) {
        const d = destinationPoint(origin, bearing, km * 1000);
        expect(calculateDistance(origin.lat, origin.lng, d.lat, d.lng)).toBeCloseTo(km, 2);
      }
    }
  });

  it('normalises longitude across the antimeridian', () => {
    // Heading east from just west of the antimeridian must not yield >180.
    const d = destinationPoint({ lat: 0, lng: 179.9 }, 90, 50_000);
    expect(d.lng).toBeLessThanOrEqual(180);
    expect(d.lng).toBeGreaterThanOrEqual(-180);
    expect(d.lng).toBeLessThan(0); // wrapped to the far side
  });

  it('returns the origin for zero distance', () => {
    const origin = { lat: 12.34, lng: -56.78 };
    const d = destinationPoint(origin, 123, 0);
    expect(d.lat).toBeCloseTo(origin.lat, 9);
    expect(d.lng).toBeCloseTo(origin.lng, 9);
  });

  it('stays finite at the poles', () => {
    const d = destinationPoint({ lat: 89.999, lng: 0 }, 0, 200_000);
    expect(Number.isFinite(d.lat)).toBe(true);
    expect(Number.isFinite(d.lng)).toBe(true);
    expect(Math.abs(d.lat)).toBeLessThanOrEqual(90);
  });
});
