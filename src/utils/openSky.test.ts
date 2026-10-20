import { describe, it, expect } from 'vitest';
import { pointToBbox, openSkyStatesUrl, parseOpenSkyStates, normalizeOpenSkyState, OPENSKY_STATES_URL } from './openSky.js';
import { matchAircraft } from './adsbMatch.js';

describe('pointToBbox (#5877)', () => {
  it('converts a point + radius at the equator', () => {
    // 60 nm = 111.12 km ≈ 1.001° each way.
    const b = pointToBbox(0, 10, 60);
    expect(b.lamin).toBeCloseTo(-1.001, 3);
    expect(b.lamax).toBeCloseTo(1.001, 3);
    expect(b.lomin).toBeCloseTo(8.999, 3);
    expect(b.lomax).toBeCloseTo(11.001, 3);
  });

  it('widens longitude by 1/cos(lat) at high latitude', () => {
    const b = pointToBbox(60, 10, 60);
    const dLat = b.lamax - 60;
    expect(b.lomax - 10).toBeCloseTo(dLat * 2, 6); // cos 60° = 0.5
  });

  it('takes every longitude when the box would reach a pole', () => {
    const b = pointToBbox(88.5, 20, 60);
    expect(b).toMatchObject({ lomin: -180, lomax: 180 });
    expect(b.lamax).toBeLessThanOrEqual(90);
  });

  it('clamps latitude to ±90', () => {
    expect(pointToBbox(-89.9, 0, 60).lamin).toBe(-90);
  });

  it('clamps at the antimeridian instead of wrapping', () => {
    const east = pointToBbox(0, 179.8, 60);
    expect(east.lomax).toBe(180);
    expect(east.lomin).toBeCloseTo(178.799, 3);
    const west = pointToBbox(0, -179.8, 60);
    expect(west.lomin).toBe(-180);
    expect(west.lomin).toBeLessThan(west.lomax);
  });

  it('builds the states/all URL with 4-decimal bounds', () => {
    expect(openSkyStatesUrl(0, 10, 60)).toBe(
      `${OPENSKY_STATES_URL}?lamin=-1.0011&lomin=8.9989&lamax=1.0011&lomax=11.0011`,
    );
  });
});

// Shaped like a real states/all response (time + positional arrays).
const FIXTURE = {
  time: 1_790_500_000,
  states: [
    // icao24, callsign, origin, time_position, last_contact, lon, lat, baro_m, on_ground, vel_m/s, track, vrate, sensors, geo_m, squawk, spi, source
    ['A3F1C2', 'AAL1498 ', 'United States', 1_790_499_998, 1_790_499_999, -80.3, 25.81, 3000, false, 128.6, 92.5, 0, null, 3050, '1200', false, 0],
    ['abc123', '', 'United States', null, 1_790_499_990, null, null, null, true, 0, null, null, null, null, null, false, 0],
    ['def456', 'N1GND   ', 'United States', 1_790_499_900, 1_790_499_900, -80.29, 25.8, 10, true, 5, 180, 0, null, 15, null, false, 0],
    'not-an-array',
    [null, 'NOHEX'],
  ],
};

describe('parseOpenSkyStates (#5877)', () => {
  it('normalises units, trims the callsign and lower-cases the hex', () => {
    const [a] = parseOpenSkyStates(FIXTURE);
    expect(a.hex).toBe('a3f1c2');
    expect(a.flight).toBe('AAL1498');
    expect(a.lat).toBe(25.81);
    expect(a.lon).toBe(-80.3);
    expect(a.alt_baro).toBe(Math.round(3000 / 0.3048)); // 9843 ft
    expect(a.alt_geom).toBe(Math.round(3050 / 0.3048));
    expect(a.gs).toBeCloseTo(250, 0); // 128.6 m/s ≈ 250 kt
    expect(a.track).toBe(92.5);
    expect(a.seen_pos).toBe(2);
    expect(a.t).toBeUndefined();
    expect(a.r).toBeUndefined();
  });

  it('leaves nulls unset and reads on_ground as "ground"', () => {
    const [, b, c] = parseOpenSkyStates(FIXTURE);
    expect(b).toEqual({ hex: 'abc123', alt_baro: 'ground', gs: 0 });
    expect(c.alt_baro).toBe('ground');
    expect(c.flight).toBe('N1GND');
  });

  it('skips rows that are not arrays or have no icao24', () => {
    expect(parseOpenSkyStates(FIXTURE)).toHaveLength(3);
    expect(normalizeOpenSkyState('x', 1)).toBeNull();
  });

  it('omits seen_pos when the response has no time', () => {
    const [a] = parseOpenSkyStates({ states: [FIXTURE.states[0]] });
    expect(a.seen_pos).toBeUndefined();
  });

  it('treats states: null as an empty sky', () => {
    expect(parseOpenSkyStates({ time: 1, states: null })).toEqual([]);
  });

  it('throws on a body that is not the OpenSky shape', () => {
    expect(() => parseOpenSkyStates('nope')).toThrow();
    expect(() => parseOpenSkyStates({ states: 'x' })).toThrow();
  });

  it('feeds the matcher like a readsb feed does', () => {
    const match = matchAircraft(
      { latitude: 25.8, longitude: -80.3, altitudeM: 3002, positionTimestampMs: 1_790_500_000_000, nowMs: 1_790_500_000_000 },
      parseOpenSkyStates(FIXTURE),
    );
    expect(match).toMatchObject({ hex: 'a3f1c2', callsign: 'AAL1498', type: null, registration: null });
  });
});
