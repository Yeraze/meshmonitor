// @vitest-environment jsdom
// (Leaflet touches `window` at import time.)
import { describe, it, expect } from 'vitest';
import L from 'leaflet';
import { circleEdgePoint, clampRadiusMeters, EARTH_RADIUS_M } from './geofenceEditorGeometry';
import { GEOFENCE_RADIUS_KM_MAX } from '../utils/geofenceLimits';

describe('circleEdgePoint', () => {
  // The radius handle must sit on the circle edge. The old lng + r/111320
  // drifted outside it as latitude grew (cos(lat) was missing).
  it.each([
    [0, 0, 10_000],
    [26, -80, 10_000],
    [60, 10, 50_000],
    [-45, 170, 1_000_000],
  ])('lies exactly radius metres from (%f, %f) for r=%i', (lat, lng, r) => {
    const center = L.latLng(lat, lng);
    expect(center.distanceTo(circleEdgePoint(center, r))).toBeCloseTo(r, 0);
  });

  it('beats the old approximation at 60° latitude', () => {
    const center = L.latLng(60, 10);
    const r = 50_000;
    const old = L.latLng(60, 10 + r / 111320);
    expect(Math.abs(center.distanceTo(old) - r)).toBeGreaterThan(20_000);
  });
});

describe('radius cap', () => {
  it('equals half the circumference of Leaflet’s sphere, rounded down', () => {
    expect(GEOFENCE_RADIUS_KM_MAX).toBe(Math.floor((Math.PI * EARTH_RADIUS_M) / 1000));
  });

  it('is reachable by a map drag, so the drag clamp can fire', () => {
    const antipodalDistance = L.latLng(0, 0).distanceTo(L.latLng(0, 180));
    expect(antipodalDistance).toBeGreaterThan(GEOFENCE_RADIUS_KM_MAX * 1000);
    expect(clampRadiusMeters(antipodalDistance)).toBe(GEOFENCE_RADIUS_KM_MAX * 1000);
    expect(clampRadiusMeters(5000)).toBe(5000);
  });
});
