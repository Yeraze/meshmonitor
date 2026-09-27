/**
 * Flight-trail descriptor helpers (#5364/#5365 Phase 3).
 */
import { describe, it, expect } from 'vitest';
import {
  AIRCRAFT_TRAIL_DEDUPE_MS,
  aircraftNodeLabel,
  arrowIndices,
  buildAircraftTrailDescriptors,
  clampAircraftTrailHours,
  collectVisibleAircraft,
  nearestPointIndex,
  type AircraftTrail,
  type TrailEligibleNode,
} from './aircraftTrails';
import { colorForKey } from '../../utils/trailColor';
import { AIRCRAFT_TRAIL_HOUR_STOPS, nearestTrailHourStopIndex } from './aircraftTrailStops';

const trail = (sourceId: string, nodeNum: number, ts: number[]): AircraftTrail => ({
  sourceId,
  nodeNum,
  points: ts.map((t, i) => ({ lat: 10 + i, lon: 20 + i, alt: null, ts: t })),
});

describe('clampAircraftTrailHours', () => {
  it('clamps to 1..168 and rounds', () => {
    expect(clampAircraftTrailHours(0)).toBe(1);
    expect(clampAircraftTrailHours(500)).toBe(168);
    expect(clampAircraftTrailHours(5.6)).toBe(6);
    expect(clampAircraftTrailHours(Number.NaN)).toBe(6);
  });
});

describe('collectVisibleAircraft', () => {
  const label = (n: TrailEligibleNode) => `n${n.nodeNum}`;

  it('keeps flagged aircraft and aged-out aircraft from the drawn list', () => {
    const drawn: TrailEligibleNode[] = [
      { nodeNum: 1, likelyAircraft: true },
      { nodeNum: 2, likelyAircraft: false },
      { nodeNum: 3, likelyAircraft: false, isIgnored: true, aircraftAgedOutAt: 123 },
      { nodeNum: 4, likelyAircraft: null },
    ];
    expect(Array.from(collectVisibleAircraft(drawn, label).keys())).toEqual([1, 3]);
  });

  it('ignores MeshCore nodes, missing nodeNums, and a manual ignore without age-out', () => {
    const drawn: TrailEligibleNode[] = [
      { nodeNum: 0, likelyAircraft: true, isMeshCore: true },
      { nodeNum: null, likelyAircraft: true },
      { nodeNum: 5, likelyAircraft: false, isIgnored: true, aircraftAgedOutAt: null },
    ];
    expect(collectVisibleAircraft(drawn, label).size).toBe(0);
  });

  it('coerces BIGINT-string nodeNums', () => {
    const visible = collectVisibleAircraft([{ nodeNum: '4276993775', likelyAircraft: true }], label);
    expect(visible.has(4276993775)).toBe(true);
  });

  /**
   * The panels hand in the list they draw markers from, so Hide mode and
   * "Show aged-out" apply to trails by construction. Model both panels'
   * marker filter here to pin that a node absent from the drawn list gets no
   * trail.
   */
  it('follows the marker filters: Hide drops non-favourites, aged-out needs Show aged-out', () => {
    const all: Array<TrailEligibleNode & { isFavorite?: boolean }> = [
      { nodeNum: 1, likelyAircraft: true },
      { nodeNum: 2, likelyAircraft: true, isFavorite: true },
      { nodeNum: 3, likelyAircraft: true, isIgnored: true, aircraftAgedOutAt: 1 },
    ];
    const drawn = (mode: 'show' | 'mark' | 'hide', showAgedOut: boolean) =>
      all.filter((n) => {
        if (n.isIgnored && n.aircraftAgedOutAt != null) return showAgedOut;
        return !(mode === 'hide' && n.likelyAircraft === true && !n.isFavorite);
      });

    expect(Array.from(collectVisibleAircraft(drawn('mark', false), label).keys())).toEqual([1, 2]);
    expect(Array.from(collectVisibleAircraft(drawn('hide', false), label).keys())).toEqual([2]);
    expect(Array.from(collectVisibleAircraft(drawn('hide', true), label).keys())).toEqual([2, 3]);
    expect(Array.from(collectVisibleAircraft(drawn('show', true), label).keys())).toEqual([1, 2, 3]);
  });
});

describe('buildAircraftTrailDescriptors', () => {
  const visible = new Map([
    [1, 'Plane One'],
    [2, 'Plane Two'],
  ]);

  it('per-source: keeps only that source and only visible aircraft', () => {
    const trails = [trail('a', 1, [0, 1000]), trail('b', 1, [0, 1000]), trail('a', 9, [0, 1000])];
    const out = buildAircraftTrailDescriptors(trails, visible, { kind: 'source', sourceId: 'a' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: 'aircraft-trail-1', label: 'Plane One', color: colorForKey('1') });
    expect(out[0].positions).toEqual([[10, 20], [11, 21]]);
    expect(out[0].times).toEqual([0, 1000]);
  });

  it('per-source: keeps close points (no dedupe inside one source)', () => {
    const out = buildAircraftTrailDescriptors([trail('a', 1, [0, 1000, 2000])], visible, {
      kind: 'source',
      sourceId: 'a',
    });
    expect(out[0].times).toEqual([0, 1000, 2000]);
  });

  it('unified: merges a node across sources, sorts, and drops points within 5 s of the last kept one', () => {
    const trails = [trail('a', 1, [0, 60_000, 120_000]), trail('b', 1, [2_000, 61_000, 90_000])];
    const out = buildAircraftTrailDescriptors(trails, visible, { kind: 'unified' });
    expect(out).toHaveLength(1);
    expect(out[0].times).toEqual([0, 60_000, 90_000, 120_000]);
    expect(out[0].key).toBe('aircraft-trail-1');
  });

  it('unified: a point exactly at the dedupe window is kept', () => {
    const out = buildAircraftTrailDescriptors(
      [trail('a', 2, [0]), trail('b', 2, [AIRCRAFT_TRAIL_DEDUPE_MS])],
      visible,
      { kind: 'unified' },
    );
    expect(out[0].times).toEqual([0, AIRCRAFT_TRAIL_DEDUPE_MS]);
  });

  it('drops a trail with fewer than two points after filtering', () => {
    const out = buildAircraftTrailDescriptors(
      [trail('a', 1, [0]), trail('b', 1, [1_000])],
      visible,
      { kind: 'unified' },
    );
    expect(out).toEqual([]);
  });

  it('colours by nodeNum, so the same aircraft matches across views', () => {
    const perSource = buildAircraftTrailDescriptors([trail('a', 2, [0, 10_000])], visible, {
      kind: 'source',
      sourceId: 'a',
    });
    const unified = buildAircraftTrailDescriptors([trail('b', 2, [0, 10_000])], visible, { kind: 'unified' });
    expect(perSource[0].color).toBe(unified[0].color);
  });
});

describe('nearestPointIndex', () => {
  it('finds the closest point, and -1 for none', () => {
    const pts: [number, number][] = [[0, 0], [1, 1], [2, 2]];
    expect(nearestPointIndex(pts, 1.1, 0.9)).toBe(1);
    expect(nearestPointIndex(pts, 5, 5)).toBe(2);
    expect(nearestPointIndex([], 0, 0)).toBe(-1);
  });
});

describe('arrowIndices', () => {
  it('returns every index for short trails and keeps the last for long ones', () => {
    expect(arrowIndices(3, 12)).toEqual([0, 1, 2]);
    const idx = arrowIndices(500, 12);
    expect(idx.length).toBeLessThanOrEqual(12);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(499);
    expect(arrowIndices(0, 12)).toEqual([]);
  });
});

describe('aircraftNodeLabel', () => {
  it('prefers long name, then short name, then node id, then hex nodeNum', () => {
    expect(aircraftNodeLabel({ longName: 'Long', shortName: 'S' })).toBe('Long');
    expect(aircraftNodeLabel({ user: { longName: 'Nested' } })).toBe('Nested');
    expect(aircraftNodeLabel({ shortName: 'S' })).toBe('S');
    expect(aircraftNodeLabel({ nodeId: '!abc' })).toBe('!abc');
    expect(aircraftNodeLabel({ nodeNum: 255 })).toBe('!000000ff');
  });
});

describe('trail lookback slider stops', () => {
  it('span 1..168 with 6 h available', () => {
    expect(AIRCRAFT_TRAIL_HOUR_STOPS[0]).toBe(1);
    expect(AIRCRAFT_TRAIL_HOUR_STOPS[AIRCRAFT_TRAIL_HOUR_STOPS.length - 1]).toBe(168);
    expect(AIRCRAFT_TRAIL_HOUR_STOPS[nearestTrailHourStopIndex(6)]).toBe(6);
    expect(AIRCRAFT_TRAIL_HOUR_STOPS[nearestTrailHourStopIndex(200)]).toBe(168);
  });
});
