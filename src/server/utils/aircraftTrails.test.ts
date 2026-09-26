/**
 * Flight-trail shaping for GET /api/aircraft/trails (#5364/#5365 Phase 3).
 */
import { describe, it, expect } from 'vitest';
import { buildAircraftTrails, clampTrailHours, type TrailPositionRow } from './aircraftTrails.js';

const row = (sourceId: string, nodeNum: number, timestamp: number, lat = 1): TrailPositionRow => ({
  sourceId,
  nodeNum,
  latitude: lat,
  longitude: 2,
  altitude: null,
  timestamp,
});

describe('clampTrailHours', () => {
  it.each([
    [undefined, 6],
    ['', 6],
    ['abc', 6],
    ['0', 1],
    ['-5', 1],
    ['12', 12],
    ['168', 168],
    ['500', 168],
  ])('%s -> %s', (raw, expected) => {
    expect(clampTrailHours(raw)).toBe(expected);
  });
});

describe('buildAircraftTrails', () => {
  it('groups by (sourceId, nodeNum) and sorts points ascending', () => {
    const trails = buildAircraftTrails([row('a', 1, 30), row('a', 1, 10), row('b', 1, 20), row('a', 2, 5)]);
    const a1 = trails.find((t) => t.sourceId === 'a' && t.nodeNum === 1)!;
    expect(a1.points.map((p) => p.ts)).toEqual([10, 30]);
    expect(trails).toHaveLength(3);
  });

  it('orders trails by newest last fix first', () => {
    const trails = buildAircraftTrails([row('a', 1, 10), row('a', 2, 50), row('a', 3, 30)]);
    expect(trails.map((t) => t.nodeNum)).toEqual([2, 3, 1]);
  });

  it('downsamples to maxPoints, keeping first and last', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row('a', 1, i, i));
    const [trail] = buildAircraftTrails(rows, 500);
    expect(trail.points).toHaveLength(500);
    expect(trail.points[0].ts).toBe(0);
    expect(trail.points[499].ts).toBe(999);
  });

  it('caps the trail count, dropping the oldest', () => {
    const rows = Array.from({ length: 250 }, (_, i) => row('a', i + 1, i));
    const trails = buildAircraftTrails(rows, 500, 200);
    expect(trails).toHaveLength(200);
    expect(trails[0].nodeNum).toBe(250);
    expect(trails.some((t) => t.nodeNum === 1)).toBe(false);
  });
});
