import { describe, it, expect } from 'vitest';
import { haversineKm, geofenceFires, pointInPolygon, pointInShape, geofenceCenter, normalizeGeofenceParams } from './geo.js';

describe('haversineKm', () => {
  it('is 0 for the same point and ~111km per degree of latitude', () => {
    expect(haversineKm(0, 0, 0, 0)).toBe(0);
    expect(haversineKm(0, 0, 1, 0)).toBeGreaterThan(110);
    expect(haversineKm(0, 0, 1, 0)).toBeLessThan(112);
  });
});

describe('geofenceFires', () => {
  it('never fires on the baseline (no prior state)', () => {
    expect(geofenceFires(undefined, true, 'enter')).toBe(false);
    expect(geofenceFires(undefined, false, 'exit')).toBe(false);
    expect(geofenceFires(undefined, true, 'dwell')).toBe(false);
  });

  it('enter = outside → inside', () => {
    expect(geofenceFires(false, true, 'enter')).toBe(true);
    expect(geofenceFires(true, true, 'enter')).toBe(false);
    expect(geofenceFires(false, false, 'enter')).toBe(false);
  });

  it('exit = inside → outside', () => {
    expect(geofenceFires(true, false, 'exit')).toBe(true);
    expect(geofenceFires(false, false, 'exit')).toBe(false);
    expect(geofenceFires(true, true, 'exit')).toBe(false);
  });

  it('dwell = inside → still inside', () => {
    expect(geofenceFires(true, true, 'dwell')).toBe(true);
    expect(geofenceFires(false, true, 'dwell')).toBe(false);
    expect(geofenceFires(true, false, 'dwell')).toBe(false);
  });
});

// A 2°×2° square centred on (0,0).
const SQUARE = [
  { lat: -1, lng: -1 }, { lat: -1, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: -1 },
];

describe('pointInPolygon', () => {
  it('detects a point inside the ring', () => {
    expect(pointInPolygon(0, 0, SQUARE)).toBe(true);
  });
  it('rejects a point outside the ring', () => {
    expect(pointInPolygon(5, 5, SQUARE)).toBe(false);
  });
  it('is false for a degenerate (<3 vertex) ring', () => {
    expect(pointInPolygon(0, 0, [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }])).toBe(false);
  });
});

describe('pointInShape', () => {
  it('dispatches to haversine for circles', () => {
    const shape = { type: 'circle' as const, center: { lat: 0, lng: 0 }, radiusKm: 5 };
    expect(pointInShape(0.01, 0, shape)).toBe(true);   // ~1.1km in
    expect(pointInShape(1, 0, shape)).toBe(false);     // ~111km out
  });
  it('dispatches to ray-cast for polygons', () => {
    const shape = { type: 'polygon' as const, vertices: SQUARE };
    expect(pointInShape(0, 0, shape)).toBe(true);
    expect(pointInShape(2, 2, shape)).toBe(false);
  });
});

describe('geofenceCenter', () => {
  it('returns the circle center', () => {
    expect(geofenceCenter({ type: 'circle', center: { lat: 3, lng: 4 }, radiusKm: 1 })).toEqual({ lat: 3, lng: 4 });
  });
  it('returns the polygon centroid', () => {
    expect(geofenceCenter({ type: 'polygon', vertices: SQUARE })).toEqual({ lat: 0, lng: 0 });
  });
});

describe('normalizeGeofenceParams', () => {
  it('synthesizes a circle from legacy flat lat/lon/radiusKm (back-compat)', () => {
    expect(normalizeGeofenceParams({ event: 'enter', lat: 1, lon: 2, radiusKm: 5 }))
      .toEqual({ type: 'circle', center: { lat: 1, lng: 2 }, radiusKm: 5 });
  });
  it('passes a structured circle shape through', () => {
    const shape = { type: 'circle', center: { lat: 1, lng: 2 }, radiusKm: 3 };
    expect(normalizeGeofenceParams({ shape })).toEqual(shape);
  });
  it('passes a structured polygon shape through', () => {
    const shape = { type: 'polygon', vertices: SQUARE };
    expect(normalizeGeofenceParams({ shape })).toEqual(shape);
  });
  it('prefers a structured shape over legacy flat fields', () => {
    const shape = { type: 'polygon', vertices: SQUARE };
    expect(normalizeGeofenceParams({ shape, lat: 9, lon: 9, radiusKm: 9 })).toEqual(shape);
  });
  it('rejects a polygon with fewer than 3 valid vertices', () => {
    expect(normalizeGeofenceParams({ shape: { type: 'polygon', vertices: [{ lat: 0, lng: 0 }] } })).toBeNull();
  });
  it('returns null when no usable region is present', () => {
    expect(normalizeGeofenceParams({ event: 'enter' })).toBeNull();
    expect(normalizeGeofenceParams({ lat: 1, lon: 2, radiusKm: 0 })).toBeNull();
  });
});
