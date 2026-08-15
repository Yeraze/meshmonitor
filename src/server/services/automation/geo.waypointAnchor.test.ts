/**
 * Waypoint-anchored geofence parsing (#4722).
 *
 * The anchor is parsed separately from `normalizeGeofenceParams` because it
 * cannot become a shape without a database read. These pin that separation —
 * an anchor must never leak out of the shape parser, and a drawn region must
 * never be mistaken for an anchor — plus the validation that keeps a
 * half-configured anchor from fencing the wrong place.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeGeofenceAnchor,
  normalizeGeofenceParams,
  shapeFromWaypoint,
  pointInShape,
} from './geo.js';

const anchorParams = {
  event: 'enter',
  shape: { type: 'waypoint', sourceId: 'src-a', waypointId: 42, radiusKm: 0.5 },
};

describe('normalizeGeofenceAnchor', () => {
  it('reads a fully specified waypoint anchor', () => {
    expect(normalizeGeofenceAnchor(anchorParams)).toEqual({
      type: 'waypoint', sourceId: 'src-a', waypointId: 42, radiusKm: 0.5,
    });
  });

  it('accepts waypoint id 0 — a legitimate id, not "unset"', () => {
    const a = normalizeGeofenceAnchor({ shape: { ...anchorParams.shape, waypointId: 0 } });
    expect(a?.waypointId).toBe(0);
  });

  it('rejects an anchor missing the source, since the fence would be ambiguous', () => {
    // Automations are global and waypoint ids are only unique per source, so an
    // anchor without a sourceId cannot identify one place on the map.
    expect(normalizeGeofenceAnchor({ shape: { ...anchorParams.shape, sourceId: '' } })).toBeNull();
    expect(normalizeGeofenceAnchor({ shape: { ...anchorParams.shape, sourceId: '   ' } })).toBeNull();
    const { sourceId: _omitted, ...noSource } = anchorParams.shape;
    expect(normalizeGeofenceAnchor({ shape: noSource })).toBeNull();
  });

  it('rejects a non-positive or missing radius', () => {
    // A zero-radius fence can never be entered; better to not resolve at all
    // than to install a rule that silently never fires.
    for (const radiusKm of [0, -1, Number.NaN, undefined]) {
      expect(normalizeGeofenceAnchor({ shape: { ...anchorParams.shape, radiusKm } })).toBeNull();
    }
  });

  it('rejects a non-numeric waypoint id', () => {
    expect(normalizeGeofenceAnchor({ shape: { ...anchorParams.shape, waypointId: 'abc' } })).toBeNull();
  });

  it('returns null for drawn regions and for empty params', () => {
    expect(normalizeGeofenceAnchor({ shape: { type: 'circle', center: { lat: 1, lng: 2 }, radiusKm: 1 } })).toBeNull();
    expect(normalizeGeofenceAnchor({ shape: { type: 'polygon', vertices: [] } })).toBeNull();
    expect(normalizeGeofenceAnchor({})).toBeNull();
  });
});

describe('anchor and shape parsers stay disjoint', () => {
  it('normalizeGeofenceParams does not resolve a waypoint anchor to a region', () => {
    // If this ever returned a shape, an anchored fence would silently evaluate
    // against a bogus region instead of failing closed.
    expect(normalizeGeofenceParams(anchorParams)).toBeNull();
  });

  it('normalizeGeofenceAnchor does not claim a legacy flat lat/lon fence', () => {
    const legacy = { lat: 40, lon: -74, radiusKm: 2 };
    expect(normalizeGeofenceAnchor(legacy)).toBeNull();
    expect(normalizeGeofenceParams(legacy)).toEqual({
      type: 'circle', center: { lat: 40, lng: -74 }, radiusKm: 2,
    });
  });
});

describe('shapeFromWaypoint', () => {
  it('centres a circle of the anchor radius on the waypoint', () => {
    const anchor = normalizeGeofenceAnchor(anchorParams)!;
    expect(shapeFromWaypoint(anchor, { latitude: 26.7, longitude: -80.05 })).toEqual({
      type: 'circle', center: { lat: 26.7, lng: -80.05 }, radiusKm: 0.5,
    });
  });

  it('moves the fence when the waypoint moves', () => {
    const anchor = normalizeGeofenceAnchor(anchorParams)!;
    const node = { lat: 26.7, lng: -80.05 };

    const before = shapeFromWaypoint(anchor, { latitude: 26.7, longitude: -80.05 });
    expect(pointInShape(node.lat, node.lng, before)).toBe(true);

    // Same automation, no edit — the waypoint has simply been dragged away.
    const after = shapeFromWaypoint(anchor, { latitude: 27.9, longitude: -82.4 });
    expect(pointInShape(node.lat, node.lng, after)).toBe(false);
  });
});
