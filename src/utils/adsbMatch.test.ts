import { describe, it, expect } from 'vitest';
import {
  matchAircraft,
  searchRadiusKm,
  radiusToNm,
  aircraftAltitudeM,
  type AdsbAircraft,
  type AdsbMatchInput,
} from './adsbMatch.js';
import { ADSB_FEEDS, isAdsbFeed, resolveAdsbFeed, DEFAULT_ADSB_FEED } from './adsbFeeds.js';

const NOW = 1_800_000_000_000;
// ~0.009° of latitude is ~1 km.
const KM_LAT = 1 / 111.2;

function input(over: Partial<AdsbMatchInput> = {}): AdsbMatchInput {
  return { latitude: 25.8, longitude: -80.3, altitudeM: 3000, positionTimestampMs: NOW, nowMs: NOW, ...over };
}

function ac(over: Partial<AdsbAircraft> = {}): AdsbAircraft {
  return {
    hex: 'a1b2c3',
    flight: 'UAL123  ',
    t: 'B738',
    r: 'N12345',
    lat: 25.8,
    lon: -80.3,
    alt_baro: 9800,
    alt_geom: 9843, // 3000 m
    gs: 450,
    track: 270,
    seen_pos: 1.2,
    ...over,
  };
}

describe('searchRadiusKm', () => {
  it('is 5 km for a fresh fix', () => {
    expect(searchRadiusKm(NOW, NOW)).toBe(5);
  });
  it('grows 0.13 km per second of fix age', () => {
    expect(searchRadiusKm(NOW - 100_000, NOW)).toBeCloseTo(18, 5);
  });
  it('clamps at 90 km', () => {
    expect(searchRadiusKm(NOW - 3_600_000, NOW)).toBe(90);
  });
  it('treats an unknown or future timestamp as age 0', () => {
    expect(searchRadiusKm(null, NOW)).toBe(5);
    expect(searchRadiusKm(NOW + 60_000, NOW)).toBe(5);
  });
});

describe('radiusToNm / aircraftAltitudeM', () => {
  it('rounds the radius up to whole nautical miles', () => {
    expect(radiusToNm(5)).toBe(3);
    expect(radiusToNm(90)).toBe(49);
  });
  it('prefers alt_geom, falls back to numeric alt_baro, converts feet to metres', () => {
    expect(aircraftAltitudeM({ alt_geom: 1000, alt_baro: 2000 })).toBeCloseTo(304.8, 5);
    expect(aircraftAltitudeM({ alt_baro: 1000 })).toBeCloseTo(304.8, 5);
    expect(aircraftAltitudeM({ alt_baro: 'ground' })).toBeNull();
    expect(aircraftAltitudeM({})).toBeNull();
  });
});

describe('matchAircraft', () => {
  it('matches the nearest aircraft and trims the callsign', () => {
    const m = matchAircraft(input(), [ac({ lat: 25.8 + KM_LAT })]);
    expect(m).not.toBeNull();
    expect(m!.hex).toBe('a1b2c3');
    expect(m!.callsign).toBe('UAL123');
    expect(m!.type).toBe('B738');
    expect(m!.registration).toBe('N12345');
    expect(m!.gsKt).toBe(450);
    expect(m!.trackDeg).toBe(270);
    expect(m!.altM).toBeCloseTo(3000, 0);
    expect(m!.distanceKm).toBeCloseTo(1, 1);
  });

  it('lowercases the hex', () => {
    expect(matchAircraft(input(), [ac({ hex: 'A1B2C3' })])!.hex).toBe('a1b2c3');
  });

  it('returns null for an empty list', () => {
    expect(matchAircraft(input(), [])).toBeNull();
  });

  it('drops aircraft with no position', () => {
    expect(matchAircraft(input(), [ac({ lat: undefined, lon: undefined })])).toBeNull();
  });

  it('drops aircraft on the ground', () => {
    expect(matchAircraft(input(), [ac({ alt_baro: 'ground', alt_geom: 9843 })])).toBeNull();
  });

  it('applies the ±300 m altitude window', () => {
    // 3000 m node vs 3290 m aircraft: inside; vs 3310 m: outside.
    expect(matchAircraft(input(), [ac({ alt_geom: 3290 / 0.3048 })])).not.toBeNull();
    expect(matchAircraft(input(), [ac({ alt_geom: 3310 / 0.3048 })])).toBeNull();
    expect(matchAircraft(input(), [ac({ alt_geom: 2690 / 0.3048 })])).toBeNull();
  });

  it('uses alt_baro when alt_geom is missing', () => {
    expect(matchAircraft(input(), [ac({ alt_geom: undefined, alt_baro: 9843 })])).not.toBeNull();
  });

  it('respects the radius, which grows with fix age', () => {
    const far = ac({ lat: 25.8 + 10 * KM_LAT });
    expect(matchAircraft(input(), [far])).toBeNull();
    // 60 s old → 12.8 km radius.
    expect(matchAircraft(input({ positionTimestampMs: NOW - 60_000 }), [far])).not.toBeNull();
  });

  it('is ambiguous (null) when a second candidate is within 1.25× of the nearest', () => {
    const a = ac({ hex: 'aaaaaa', lat: 25.8 + 2 * KM_LAT });
    const b = ac({ hex: 'bbbbbb', lat: 25.8 - 2.4 * KM_LAT });
    expect(matchAircraft(input(), [a, b])).toBeNull();
  });

  it('picks the nearest when the runner-up is beyond 1.25×', () => {
    const a = ac({ hex: 'aaaaaa', lat: 25.8 + 1 * KM_LAT });
    const b = ac({ hex: 'bbbbbb', lat: 25.8 - 3 * KM_LAT });
    expect(matchAircraft(input(), [b, a])!.hex).toBe('aaaaaa');
  });

  it('ignores filtered-out aircraft when judging ambiguity', () => {
    const a = ac({ hex: 'aaaaaa', lat: 25.8 + 1 * KM_LAT });
    const grounded = ac({ hex: 'bbbbbb', lat: 25.8 + 1.1 * KM_LAT, alt_baro: 'ground' });
    expect(matchAircraft(input(), [a, grounded])!.hex).toBe('aaaaaa');
  });

  it('leaves missing optional fields null', () => {
    const m = matchAircraft(input(), [{ hex: 'abc123', lat: 25.8, lon: -80.3, alt_geom: 9843 }]);
    expect(m).toMatchObject({ callsign: null, type: null, registration: null, gsKt: null, trackDeg: null });
  });

  it('returns null when the node has no usable altitude', () => {
    expect(matchAircraft(input({ altitudeM: NaN }), [ac()])).toBeNull();
  });
});

describe('adsbFeeds', () => {
  it('knows adsb.lol and adsb.fi, and not airplanes.live', () => {
    expect(isAdsbFeed('adsb.lol')).toBe(true);
    expect(isAdsbFeed('adsb.fi')).toBe(true);
    expect(isAdsbFeed('airplanes.live')).toBe(false);
  });
  it('falls back to the default feed', () => {
    expect(resolveAdsbFeed('nope').id).toBe(DEFAULT_ADSB_FEED);
    expect(resolveAdsbFeed(undefined).id).toBe('adsb.lol');
  });
  it('builds the point and flight URLs', () => {
    expect(ADSB_FEEDS['adsb.lol'].pointUrl(25.8, -80.3, 3)).toBe('https://api.adsb.lol/v2/point/25.8000/-80.3000/3');
    expect(ADSB_FEEDS['adsb.fi'].pointUrl(25.8, -80.3, 3)).toBe(
      'https://opendata.adsb.fi/api/v3/lat/25.8000/lon/-80.3000/dist/3',
    );
    expect(ADSB_FEEDS['adsb.lol'].flightUrl('a1b2c3')).toBe('https://adsb.lol/?icao=a1b2c3');
    expect(ADSB_FEEDS['adsb.fi'].flightUrl('a1b2c3')).toBe('https://globe.adsb.fi/?icao=a1b2c3');
  });
});
