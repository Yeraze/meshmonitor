/**
 * Aircraft Phase 2 pure helpers: age-out settings parse, fixed anchor in the
 * classifier, and the stationary-fix rule (AIRCRAFT_P2_SPEC.md).
 */
import { describe, it, expect } from 'vitest';
import {
  classifyAircraft,
  parseAircraftSettings,
  parseAircraftAgeOutSettings,
  parseAircraftAgeOutLastResult,
  isAircraftAgeOutAction,
  isStationaryFix,
  distanceMeters,
  AIRCRAFT_AGE_OUT_HOURS_DEFAULT,
  AIRCRAFT_AGE_OUT_HOURS_RANGE,
  AIRCRAFT_FIXED_RELEASE_M,
  aircraftMarkActions,
  normalizeAircraftManualMark,
} from './aircraftClassification.js';

const settings = parseAircraftSettings({});
// ~1 m of latitude in degrees.
const M = 1 / 111_320;

describe('parseAircraftAgeOutSettings', () => {
  it('defaults: off, 24 h, ignore', () => {
    expect(parseAircraftAgeOutSettings({})).toEqual({ enabled: false, hours: AIRCRAFT_AGE_OUT_HOURS_DEFAULT, action: 'ignore' });
  });
  it('only an explicit "true" enables it', () => {
    expect(parseAircraftAgeOutSettings({ enabled: 'true' }).enabled).toBe(true);
    expect(parseAircraftAgeOutSettings({ enabled: '1' }).enabled).toBe(false);
    expect(parseAircraftAgeOutSettings({ enabled: 'false' }).enabled).toBe(false);
  });
  it('clamps hours into range and falls back on garbage', () => {
    expect(parseAircraftAgeOutSettings({ hours: '2' }).hours).toBe(AIRCRAFT_AGE_OUT_HOURS_RANGE.min);
    expect(parseAircraftAgeOutSettings({ hours: '999' }).hours).toBe(AIRCRAFT_AGE_OUT_HOURS_RANGE.max);
    expect(parseAircraftAgeOutSettings({ hours: 'abc' }).hours).toBe(AIRCRAFT_AGE_OUT_HOURS_DEFAULT);
    expect(parseAircraftAgeOutSettings({ hours: '48' }).hours).toBe(48);
  });
  it('delete only on an explicit "delete"', () => {
    expect(parseAircraftAgeOutSettings({ action: 'delete' }).action).toBe('delete');
    expect(parseAircraftAgeOutSettings({ action: 'purge' }).action).toBe('ignore');
  });
  it('isAircraftAgeOutAction', () => {
    expect(isAircraftAgeOutAction('ignore')).toBe(true);
    expect(isAircraftAgeOutAction('delete')).toBe(true);
    expect(isAircraftAgeOutAction('nope')).toBe(false);
    expect(isAircraftAgeOutAction(1)).toBe(false);
  });
});

describe('parseAircraftAgeOutLastResult', () => {
  it('parses valid JSON and zero-fills missing counts', () => {
    expect(parseAircraftAgeOutLastResult('{"agedOut":2,"fixed":1}')).toEqual({ agedOut: 2, fixed: 1, lifted: 0, deleted: 0 });
  });
  it('null on missing or malformed input', () => {
    expect(parseAircraftAgeOutLastResult(null)).toBeNull();
    expect(parseAircraftAgeOutLastResult('')).toBeNull();
    expect(parseAircraftAgeOutLastResult('{nope')).toBeNull();
    expect(parseAircraftAgeOutLastResult('42')).toBeNull();
  });
});

describe('isStationaryFix', () => {
  const base = { lat: 40, lon: -105 };
  it('false with fewer than 3 fixes', () => {
    expect(isStationaryFix([])).toBe(false);
    expect(isStationaryFix([base, base])).toBe(false);
  });
  it('true with 3 fixes inside 200 m', () => {
    expect(isStationaryFix([base, { lat: 40 + 50 * M, lon: -105 }, { lat: 40 + 100 * M, lon: -105 }])).toBe(true);
  });
  it('false when the spread reaches 200 m', () => {
    expect(isStationaryFix([base, base, { lat: 40 + 250 * M, lon: -105 }])).toBe(false);
  });
  it('uses the bounding-box diagonal, not a single axis', () => {
    // 150 m north + 150 m east ⇒ ~212 m diagonal.
    const east = 150 / (111_320 * Math.cos((40 * Math.PI) / 180));
    expect(isStationaryFix([base, { lat: 40 + 150 * M, lon: -105 }, { lat: 40, lon: -105 + east }])).toBe(false);
  });
  it('drops non-finite fixes before counting', () => {
    expect(isStationaryFix([base, base, { lat: NaN, lon: -105 }])).toBe(false);
  });
});

describe('classifyAircraft fixed anchor', () => {
  const anchor = { lat: 40, lon: -105 };
  const high = { altitudeM: 9000, groundElevationM: null, settings };

  it('no anchor: normal verdict, no releaseFixed', () => {
    const r = classifyAircraft({ ...high, fixedAnchor: null, position: anchor });
    expect(r.likelyAircraft).toBe(true);
    expect(r.releaseFixed).toBeUndefined();
  });

  it('within 1 km of the anchor: not aircraft, basis unchanged', () => {
    const r = classifyAircraft({ ...high, fixedAnchor: anchor, position: { lat: 40 + 500 * M, lon: -105 } });
    expect(r.likelyAircraft).toBe(false);
    expect(r.basis).toBe('msl');
    expect(r.releaseFixed).toBeUndefined();
  });

  it('beyond 1 km: releaseFixed and the normal verdict', () => {
    const pos = { lat: 40 + 1500 * M, lon: -105 };
    expect(distanceMeters(anchor, pos)).toBeGreaterThan(AIRCRAFT_FIXED_RELEASE_M);
    const r = classifyAircraft({ ...high, fixedAnchor: anchor, position: pos });
    expect(r.likelyAircraft).toBe(true);
    expect(r.releaseFixed).toBe(true);
  });

  it('no usable position: the mark holds', () => {
    const r = classifyAircraft({ ...high, fixedAnchor: anchor, position: null });
    expect(r.likelyAircraft).toBe(false);
    expect(r.releaseFixed).toBeUndefined();
  });

  it('unknown altitude stays null under the mark', () => {
    const r = classifyAircraft({ altitudeM: null, groundElevationM: null, settings, fixedAnchor: anchor, position: anchor });
    expect(r.likelyAircraft).toBeNull();
  });
});

// #5715: manual marks.
describe('classifyAircraft — manual mark', () => {
  const ground = { altitudeM: 210, groundElevationM: 200, settings };
  it("'aircraft' forces true over a ground-level verdict and over an anchor", () => {
    expect(classifyAircraft({ ...ground }).likelyAircraft).toBe(false);
    expect(classifyAircraft({ ...ground, manualMark: 'aircraft' }).likelyAircraft).toBe(true);
    const anchored = classifyAircraft({
      ...ground, manualMark: 'aircraft', fixedAnchor: { lat: 0.1, lon: 0.1 }, position: { lat: 0.1, lon: 0.1 },
    });
    expect(anchored.likelyAircraft).toBe(true);
    expect(anchored.releaseFixed).toBeUndefined();
  });
  it("'aircraft' holds with no altitude at all, and keeps the computed basis", () => {
    const c = classifyAircraft({ altitudeM: null, groundElevationM: null, settings, manualMark: 'aircraft' });
    expect(c).toMatchObject({ likelyAircraft: true, basis: 'unknown' });
  });
  it("'not_aircraft' works through the anchor: false within 1 km, released beyond", () => {
    const high = { altitudeM: 9000, groundElevationM: 0, settings, manualMark: 'not_aircraft' as const, fixedAnchor: { lat: 10, lon: 10 } };
    expect(classifyAircraft({ ...high, position: { lat: 10 + 900 * M, lon: 10 } }).likelyAircraft).toBe(false);
    const moved = classifyAircraft({ ...high, position: { lat: 10 + 1100 * M, lon: 10 } });
    expect(moved).toMatchObject({ likelyAircraft: true, releaseFixed: true });
  });
});

describe('normalizeAircraftManualMark', () => {
  it('keeps the two marks and drops anything else', () => {
    expect(normalizeAircraftManualMark('aircraft')).toBe('aircraft');
    expect(normalizeAircraftManualMark('not_aircraft')).toBe('not_aircraft');
    for (const v of [null, undefined, '', 'fixed', 1]) expect(normalizeAircraftManualMark(v)).toBeNull();
  });
});

describe('aircraftMarkActions', () => {
  it('flagged: offers "not aircraft"; with a manual aircraft mark also "clear"', () => {
    expect(aircraftMarkActions({ likelyAircraft: true })).toEqual({ notAircraft: true, aircraft: false, clear: false });
    expect(aircraftMarkActions({ likelyAircraft: true, aircraftManualMark: 'aircraft' }))
      .toEqual({ notAircraft: true, aircraft: false, clear: true });
  });
  it('not flagged: offers "aircraft"; a fixed anchor (manual or automatic) adds "clear"', () => {
    expect(aircraftMarkActions({ likelyAircraft: false })).toEqual({ notAircraft: false, aircraft: true, clear: false });
    expect(aircraftMarkActions({ likelyAircraft: false, aircraftFixedAt: 1 })).toEqual({ notAircraft: false, aircraft: true, clear: true });
    expect(aircraftMarkActions({ likelyAircraft: false, aircraftManualMark: 'not_aircraft', aircraftFixedAt: 1 }).clear).toBe(true);
  });
  it('never classified (no altitude, or detection off): offers nothing', () => {
    expect(aircraftMarkActions({ likelyAircraft: null })).toEqual({ notAircraft: false, aircraft: false, clear: false });
    expect(aircraftMarkActions({})).toEqual({ notAircraft: false, aircraft: false, clear: false });
  });
});
