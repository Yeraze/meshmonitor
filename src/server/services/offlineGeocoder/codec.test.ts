import { describe, it, expect } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  decodeAdmin1,
  decodeCities,
  encodeAdmin1,
  encodeCities,
  type CityRecord,
} from './codec.js';
import { locateFeature, pointInFeature } from './pip.js';

describe('varints', () => {
  it('round-trips unsigned and zigzag values past 2^31', () => {
    const vals = [0, 1, 127, 128, 300, 2 ** 31 - 1, 2 ** 31, 2 ** 32 + 5, 2 ** 40];
    const signed = [0, -1, 1, -64, 64, -18_000_000, 18_000_000, -(2 ** 33)];
    const w = new ByteWriter();
    vals.forEach((v) => w.varint(v));
    signed.forEach((v) => w.zigzag(v));
    const r = new ByteReader(w.finish());
    expect(vals.map(() => r.varint())).toEqual(vals);
    expect(signed.map(() => r.zigzag())).toEqual(signed);
  });

  it('rejects negative and fractional unsigned values', () => {
    const w = new ByteWriter();
    expect(() => w.varint(-1)).toThrow();
    expect(() => w.varint(1.5)).toThrow();
  });

  it('throws on truncated input', () => {
    expect(() => new ByteReader(new Uint8Array([0x80])).varint()).toThrow(/truncated/);
  });
});

// Two unit squares side by side; the left one has a square hole.
const square = (x0: number, y0: number, s: number): Array<[number, number]> => [
  [x0, y0],
  [x0 + s, y0],
  [x0 + s, y0 + s],
  [x0, y0 + s],
];
const admin1 = () =>
  decodeAdmin1(
    encodeAdmin1({
      version: 'test-1',
      features: [
        { cc: 'AA', code: 'AA-L', name: 'Left', rings: [square(0, 0, 100), square(40, 40, 20)] },
        { cc: 'AA', code: 'AA-R', name: 'Right', rings: [square(100, 0, 100)] },
        { cc: 'BB', rings: [square(1000, 1000, 10), square(2000, 2000, 10)] },
      ],
    }),
  );

describe('admin1 encode/decode', () => {
  it('round-trips features, rings, coordinates and boxes', () => {
    const d = admin1();
    expect(d.version).toBe('test-1');
    expect(d.features).toEqual([
      { cc: 'AA', code: 'AA-L', name: 'Left' },
      { cc: 'AA', code: 'AA-R', name: 'Right' },
      { cc: 'BB' },
    ]);
    expect([...d.featRing]).toEqual([0, 2, 3, 5]);
    expect([...d.ringStart]).toEqual([0, 4, 8, 12, 16, 20]);
    expect([...d.coords.subarray(16, 18)]).toEqual([100, 0]); // first vertex of feature 1
    expect([...d.bbox.subarray(8, 12)]).toEqual([1000, 1000, 2010, 2010]);
  });

  it('rejects wrong magic and trailing bytes', () => {
    expect(() => decodeAdmin1(new TextEncoder().encode('NOPE\u0000'))).toThrow(/expected MMA1/);
    const ok = encodeAdmin1({ version: 'v', features: [] });
    const extra = new Uint8Array(ok.length + 1);
    extra.set(ok);
    expect(() => decodeAdmin1(extra)).toThrow(/trailing/);
  });

  it('refuses non-integer coordinates', () => {
    expect(() =>
      encodeAdmin1({ version: 'v', features: [{ cc: 'AA', rings: [[[0.5, 0], [1, 0], [1, 1]]] }] }),
    ).toThrow(/integers/);
  });
});

describe('point in polygon', () => {
  it('honours holes and multipolygons (even-odd)', () => {
    const d = admin1();
    expect(pointInFeature(d, 0, 10, 10)).toBe(true);
    expect(pointInFeature(d, 0, 50, 50)).toBe(false); // in the hole
    expect(pointInFeature(d, 2, 1005, 1005)).toBe(true);
    expect(pointInFeature(d, 2, 2005, 2005)).toBe(true);
    expect(pointInFeature(d, 2, 1500, 1500)).toBe(false);
  });

  it('a point in a hole falls back to the nearest edge only within the distance', () => {
    const d = admin1();
    // 1 unit = 1e-5 degrees, about 1.1 m: the hole edge is ~11 m away.
    expect(locateFeature(d, 50, 50, 0)).toBe(-1);
    expect(locateFeature(d, 50, 50, 1)).toBe(0);
  });

  it('a point on a shared edge resolves the same way every time', () => {
    const d = admin1();
    const first = locateFeature(d, 100, 50, 10);
    for (let i = 0; i < 100; i++) expect(locateFeature(d, 100, 50, 10)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
  });

  it('a fallback tie goes to the lowest code, whatever the feature order', () => {
    // A point in the middle of a 10-unit gap is equidistant to both squares.
    const gap = (first: 'AA-Z' | 'AA-B') =>
      decodeAdmin1(
        encodeAdmin1({
          version: 't',
          features: [
            { cc: 'AA', code: first, rings: [square(0, 0, 100)] },
            { cc: 'AA', code: first === 'AA-Z' ? 'AA-B' : 'AA-Z', rings: [square(110, 0, 100)] },
          ],
        }),
      );
    const za = gap('AA-Z');
    expect(za.features[locateFeature(za, 105, 50, 1)].code).toBe('AA-B');
    const bz = gap('AA-B');
    expect(bz.features[locateFeature(bz, 105, 50, 1)].code).toBe('AA-B');
  });
});

describe('cities encode/decode', () => {
  const cities: CityRecord[] = [
    { id: 5, name: 'A', lat: 10, lon: 10, population: 20000, feature: 0 },
    { id: 9, name: 'Bé', lat: -10, lon: 15, population: 0, feature: 0 },
    { id: 2, name: '東京', lat: 3_568_120, lon: 13_976_710, population: 9_733_276, feature: 2 },
  ];

  it('round-trips and builds per-feature ranges, including empty features', () => {
    const c = decodeCities(encodeCities('test-1', 4, cities));
    expect(c.version).toBe('test-1');
    expect(c.names).toEqual(['A', 'Bé', '東京']);
    expect([...c.featCity]).toEqual([0, 2, 2, 3, 3]);
    expect([...c.lat]).toEqual([10, -10, 3_568_120]);
    expect([...c.lon]).toEqual([10, 15, 13_976_710]);
    expect([...c.population]).toEqual([20000, 0, 9_733_276]);
    expect([...c.id]).toEqual([5, 9, 2]);
  });

  it('handles a first city in a later feature', () => {
    const c = decodeCities(encodeCities('v', 3, [{ ...cities[0], feature: 2 }]));
    expect([...c.featCity]).toEqual([0, 0, 0, 1]);
  });

  it('refuses unsorted input and out-of-range features', () => {
    expect(() => encodeCities('v', 4, [cities[1], cities[0]])).toThrow(/sorted/);
    expect(() => decodeCities(encodeCities('v', 2, cities))).toThrow(/out of range/);
  });
});
