/**
 * Offline geocoder over the real embedded data (#6336). Fixed coordinates,
 * invariants, a seeded snapshot, cost bounds, and the no-logging rule.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { gunzipSync } from 'zlib';

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../../utils/logger.js';
import { ADMIN1_DATA_GZ_B64 } from '../../data/geo/admin1.data.js';
import { CITIES_DATA_GZ_B64 } from '../../data/geo/cities.data.js';
import { ADMIN1_DATA_SHA256, CITIES_DATA_SHA256, GEO_DATA_VERSION } from '../../data/geo/geoDataVersion.js';
import { getDirectory } from '../mqttRootFinder/directory.js';
import { buildLadder, cityRootFor, rankHeard, type HeardRoot } from '../mqttRootFinder/ladder.js';
import { COORD_SCALE, decodeAdmin1, decodeCities, type Admin1Data } from './codec.js';
import { locateFeature } from './pip.js';
import { createHash } from 'crypto';
import {
  createReverseGeocoder,
  reverseGeocode,
  sharedReverseGeocoder,
  type GeoPlace,
} from './reverseGeocode.js';

const unpack = (b64: string) => new Uint8Array(gunzipSync(Buffer.from(b64, 'base64')));
const at = (lat: number, lon: number) => reverseGeocode({ lat, lon });

let admin1: Admin1Data;
beforeAll(() => {
  admin1 = decodeAdmin1(unpack(ADMIN1_DATA_GZ_B64));
});

describe('embedded data', () => {
  it('matches its pinned sha256 and data version', () => {
    const sha = (b64: string) => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
    expect(sha(ADMIN1_DATA_GZ_B64)).toBe(ADMIN1_DATA_SHA256);
    expect(sha(CITIES_DATA_GZ_B64)).toBe(CITIES_DATA_SHA256);
    expect(admin1.version).toBe(GEO_DATA_VERSION);
    expect(decodeCities(unpack(CITIES_DATA_GZ_B64)).version).toBe(GEO_DATA_VERSION);
  });

  it('every feature has a 2-letter country and, when coded, a CC-XXX top-level code', () => {
    for (const f of admin1.features) {
      expect(f.cc).toMatch(/^[A-Z]{2}$/);
      if (f.code !== undefined) {
        expect(f.code).toMatch(/^[A-Z]{2}-[A-Z0-9]{1,3}$/);
        expect(f.code.startsWith(`${f.cc}-`)).toBe(true);
        expect(f.name).toBeTruthy();
      }
    }
  });

  it('carries no Natural Earth placeholder codes', () => {
    const codes = admin1.features.map((f) => f.code ?? '');
    // NE's placeholders are `-99-X16~`, `XK-X01~`, `AI-X00`. CU-99 (Isla de la Juventud) is real ISO.
    expect(codes.filter((c) => c.startsWith('-99') || c.includes('~') || /-X\d/.test(c))).toEqual([]);
    expect(new Set(codes.filter(Boolean)).size).toBe(codes.filter(Boolean).length);
  });

  it('has one subdivision per GB nation and per FR/IT/ES region, not counties or provinces', () => {
    const of = (cc: string) => admin1.features.filter((f) => f.cc === cc && f.code).map((f) => f.code).sort();
    expect(of('GB')).toEqual(['GB-ENG', 'GB-NIR', 'GB-SCT', 'GB-WLS']);
    expect(of('FR')).toHaveLength(18);
    expect(of('IT')).toHaveLength(20);
    expect(of('ES')).toHaveLength(19);
    expect(of('BE')).toEqual(['BE-BRU', 'BE-VLG', 'BE-WAL']);
    expect(of('IE')).toEqual(['IE-C', 'IE-L', 'IE-M', 'IE-U']);
  });

  it('every US subdivision name is a key in the bundled directory', () => {
    const segs = getDirectory().subdivisionSegments.US;
    const us = admin1.features.filter((f) => f.cc === 'US' && f.name);
    expect(us.length).toBeGreaterThanOrEqual(51);
    for (const f of us) expect(segs[f.name!.toLowerCase()], f.name).toBeTruthy();
  });
});

describe('reverseGeocode: fixed places', () => {
  const cases: Array<[string, number, number, GeoPlace | undefined]> = [
    ['Seattle', 47.6062, -122.3321, { cc: 'US', subdivisionIso: 'US-WA', subdivisionName: 'Washington', city: 'Seattle' }],
    ['Texarkana, TX side', 33.4251, -94.0477, { cc: 'US', subdivisionIso: 'US-TX', subdivisionName: 'Texas', city: 'Texarkana' }],
    ['Kiel', 54.3233, 10.1228, { cc: 'DE', subdivisionIso: 'DE-SH', subdivisionName: 'Schleswig-Holstein', city: 'Kiel' }],
    ['Edinburgh', 55.9533, -3.1883, { cc: 'GB', subdivisionIso: 'GB-SCT', subdivisionName: 'Scotland', city: 'Edinburgh' }],
    ['Paris', 48.8566, 2.3522, { cc: 'FR', subdivisionIso: 'FR-IDF', subdivisionName: 'Île-de-France', city: 'Paris' }],
    ['Tokyo Station', 35.6812, 139.7671, { cc: 'JP', subdivisionIso: 'JP-13', subdivisionName: 'Tokyo', city: 'Tokyo' }],
    ['Washington, DC', 38.9072, -77.0369, { cc: 'US', subdivisionIso: 'US-DC', subdivisionName: 'District of Columbia', city: 'Washington' }],
    ['Maseru (Lesotho, a hole in ZA)', -29.31, 27.48, { cc: 'LS', subdivisionIso: 'LS-A', subdivisionName: 'Maseru', city: 'Maseru' }],
    ['San Juan (US-PR, not cc PR)', 18.4655, -66.1057, { cc: 'US', subdivisionIso: 'US-PR', subdivisionName: 'Puerto Rico', city: 'San Juan' }],
    ['Pristina (no ISO subdivision)', 42.66, 21.16, { cc: 'XK', city: 'Pristina' }],
    ['mid-Atlantic', 30, -40, undefined],
  ];
  for (const [label, lat, lon, want] of cases) {
    it(label, () => expect(at(lat, lon)).toEqual(want));
  }

  it('Fiji and Chukotka resolve on both sides of the antimeridian', () => {
    expect(at(-16.85, 179.97)?.subdivisionIso).toBe('FJ-N');
    expect(at(-16.85, -179.97)?.subdivisionIso).toBe('FJ-N');
    expect(at(65.0, 179.5)?.subdivisionIso).toBe('RU-CHU');
    expect(at(66.0, -175.0)?.subdivisionIso).toBe('RU-CHU');
  });

  it('a point just offshore of Miami takes US-FL through the 10 km fallback', () => {
    const lat = 25.79;
    const lon = -80.1;
    const x = Math.round(lon * COORD_SCALE);
    const y = Math.round(lat * COORD_SCALE);
    expect(locateFeature(admin1, x, y, 0)).toBe(-1); // in no polygon
    expect(at(lat, lon)).toMatchObject({ cc: 'US', subdivisionIso: 'US-FL' });
  });

  it('a WA/OR border point gives one answer over 1,000 calls', () => {
    const first = at(45.6, -122.67);
    expect(first?.subdivisionIso).toMatch(/^US-(WA|OR)$/);
    for (let i = 0; i < 1000; i++) expect(at(45.6, -122.67)).toEqual(first);
  });

  it('returns undefined for bad input', () => {
    expect(at(Number.NaN, 0)).toBeUndefined();
    expect(at(91, 0)).toBeUndefined();
    expect(at(0, 181)).toBeUndefined();
    expect(reverseGeocode(undefined as never)).toBeUndefined();
  });
});

describe('reverseGeocode feeds the ladder', () => {
  const dir = getDirectory();
  const h = (root: string): HeardRoot => ({ root, nodes: 1, messages: 1, retainedOnly: false });

  it('Seattle gives msh/US/WA and msh/US/WA/seattle', () => {
    const place = at(47.6062, -122.3321)!;
    const rows = buildLadder({ regionRoot: 'msh/US', place, heard: [], directory: dir });
    expect(rows.map((r) => [r.kind, r.root])).toEqual(
      expect.arrayContaining([
        ['subdivision', 'msh/US/WA'],
        ['city', 'msh/US/WA/seattle'],
      ]),
    );
  });

  it('Texarkana (TX side) ranks msh/US/AR as a tier 2 neighbour', () => {
    const userPos = { lat: 33.4251, lon: -94.0477 };
    const ranked = rankHeard({
      regionRoot: 'msh/US',
      place: at(userPos.lat, userPos.lon),
      userPos,
      heard: [h('msh/US/AR'), h('msh/US/TX'), h('msh/US/OR')],
      directory: dir,
    });
    expect(ranked.map((r) => [r.root, r.tier])).toEqual([
      ['msh/US/TX', 1],
      ['msh/US/AR', 2],
      ['msh/US/OR', 3],
    ]);
  });

  it('Kiel gives the ISO suffix segment msh/EU_868/DE/SH (upstream S-H is not patched)', () => {
    const place = at(54.3233, 10.1228)!;
    const rows = buildLadder({ regionRoot: 'msh/EU_868', place, heard: [], directory: dir });
    expect(rows.map((r) => r.root)).toContain('msh/EU_868/DE/SH');
    expect(cityRootFor('msh/EU_868', place, dir)).toBe('msh/EU_868/DE/SH/kiel');
  });

  it('a Tokyo city row fits in 31 bytes', () => {
    const root = cityRootFor('msh/JP', at(35.6812, 139.7671), dir);
    expect(root).toBeTruthy();
    expect(Buffer.byteLength(root!)).toBeLessThanOrEqual(31);
  });
});

describe('determinism', () => {
  // mulberry32: a fixed seed gives the same points everywhere.
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it(`matches the snapshot over 200 seeded land points (${GEO_DATA_VERSION})`, () => {
    const next = rng(6336);
    const out: string[] = [];
    let tries = 0;
    while (out.length < 200 && tries < 20_000) {
      tries++;
      // Five decimals, so the snapshot holds the exact inputs.
      const lat = Math.round((next() * 140 - 60) * 1e5) / 1e5;
      const lon = Math.round((next() * 360 - 180) * 1e5) / 1e5;
      const p = at(lat, lon);
      if (p) out.push(`${lat},${lon} ${p.cc} ${p.subdivisionIso ?? '-'} ${p.city ?? '-'}`);
    }
    expect(out).toHaveLength(200);
    expect(out).toMatchSnapshot();
  });
});

// V8 coverage instrumentation (`npm run test:coverage`, run by the release
// pipeline) slows these hot loops several-fold: 10k lookups took 2.5 s on a
// Node 22 runner and failed the v4.17.3 release. The budgets guard against a
// real regression, so keep them tight for plain runs and scale them only
// under coverage. Memory is unaffected by instrumentation.
const TIME_SCALE = process.env.npm_lifecycle_event === 'test:coverage' ? 4 : 1;

describe('cost', () => {
  it('decodes under 1 s, 10k lookups under 2 s, under 30 MB', () => {
    const g = createReverseGeocoder({ admin1: () => ADMIN1_DATA_GZ_B64, cities: () => CITIES_DATA_GZ_B64 });
    const m0 = process.memoryUsage();
    const t0 = performance.now();
    expect(g.load()).toBe(true);
    const decodeMs = performance.now() - t0;
    const m1 = process.memoryUsage();

    const t1 = performance.now();
    let found = 0;
    for (let i = 0; i < 10_000; i++) {
      if (g.lookup({ lat: 25 + (i % 100) * 0.25, lon: -125 + Math.floor(i / 100) * 0.6 })) found++;
    }
    const lookupMs = performance.now() - t1;
    // Typed arrays live outside the V8 heap, so count arrayBuffers too.
    const deltaMb = (m1.heapUsed - m0.heapUsed + m1.arrayBuffers - m0.arrayBuffers) / 2 ** 20;
    expect(decodeMs).toBeLessThan(1000 * TIME_SCALE);
    expect(lookupMs).toBeLessThan(2000 * TIME_SCALE);
    expect(deltaMb).toBeLessThan(30);
    expect(found).toBeGreaterThan(1000);
    g.drop();
  });
});

describe('lifecycle and privacy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('decodes lazily and drops the tables after the idle time', () => {
    vi.useFakeTimers();
    const g = createReverseGeocoder(
      { admin1: () => ADMIN1_DATA_GZ_B64, cities: () => CITIES_DATA_GZ_B64 },
      { idleMs: 1000 },
    );
    expect(g.isLoaded()).toBe(false);
    expect(g.lookup({ lat: 47.6062, lon: -122.3321 })?.city).toBe('Seattle');
    expect(g.isLoaded()).toBe(true);
    vi.advanceTimersByTime(999);
    expect(g.isLoaded()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(g.isLoaded()).toBe(false);
    expect(g.lookup({ lat: 47.6062, lon: -122.3321 })?.city).toBe('Seattle');
  });

  it('works without the city module', () => {
    const g = createReverseGeocoder({ admin1: () => ADMIN1_DATA_GZ_B64 });
    expect(g.lookup({ lat: 47.6062, lon: -122.3321 })).toEqual({
      cc: 'US',
      subdivisionIso: 'US-WA',
      subdivisionName: 'Washington',
    });
    g.drop();
  });

  it('turns itself off on corrupt data, logging no position', () => {
    vi.mocked(logger.error).mockClear();
    const g = createReverseGeocoder({ admin1: () => 'not gzip' });
    expect(g.lookup({ lat: 47.6062, lon: -122.3321 })).toBeUndefined();
    expect(g.lookup({ lat: 47.6062, lon: -122.3321 })).toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('47.6');
  });

  it('logs nothing on a lookup', () => {
    for (const fn of Object.values(logger)) vi.mocked(fn).mockClear();
    sharedReverseGeocoder.drop();
    at(47.6062, -122.3321);
    at(30, -40);
    for (const fn of Object.values(logger)) expect(fn).not.toHaveBeenCalled();
  });
});
