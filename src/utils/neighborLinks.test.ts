/**
 * Runs in the default node environment — neighborLinks.ts is pure and
 * leaflet-free (#4047 P7 WP1).
 */
import { describe, it, expect } from 'vitest';
import {
  snrToNeighborOpacity,
  dedupByUnorderedPair,
  bearingBetween,
  neighborArrowFractions,
  pairNeighborRecords,
  neighborHeardAtMs,
  formatNeighborAge,
} from './neighborLinks';

describe('snrToNeighborOpacity', () => {
  it('returns 0.4 for null (no SNR reported)', () => {
    expect(snrToNeighborOpacity(null)).toBe(0.4);
  });

  it('floors at 0.2 for very poor SNR', () => {
    expect(snrToNeighborOpacity(-10)).toBeCloseTo(0.2);
    expect(snrToNeighborOpacity(-50)).toBeCloseTo(0.2);
  });

  it('ceils at 1 for very good SNR', () => {
    expect(snrToNeighborOpacity(10)).toBeCloseTo(1);
    expect(snrToNeighborOpacity(30)).toBeCloseTo(1);
  });

  it('linearly interpolates mid-range SNR', () => {
    // (0 + 10) / 20 = 0.5
    expect(snrToNeighborOpacity(0)).toBeCloseTo(0.5);
    // (-5 + 10) / 20 = 0.25
    expect(snrToNeighborOpacity(-5)).toBeCloseTo(0.25);
  });
});

describe('dedupByUnorderedPair', () => {
  interface Edge {
    id: string;
    a: number;
    b: number;
  }

  it('collapses A~B and B~A to a single entry, keeping the first', () => {
    const edges: Edge[] = [
      { id: 'first', a: 1, b: 2 },
      { id: 'reverse-dup', a: 2, b: 1 },
      { id: 'unique', a: 3, b: 4 },
    ];
    const result = dedupByUnorderedPair(edges, (e) => e.a, (e) => e.b);
    expect(result.map((e) => e.id)).toEqual(['first', 'unique']);
  });

  it('keeps distinct pairs with a shared endpoint', () => {
    const edges: Edge[] = [
      { id: 'a-b', a: 1, b: 2 },
      { id: 'a-c', a: 1, b: 3 },
    ];
    const result = dedupByUnorderedPair(edges, (e) => e.a, (e) => e.b);
    expect(result).toHaveLength(2);
  });

  it('works with string keys (e.g. MeshCore public keys)', () => {
    interface McEdge { id: string; pk: string; npk: string }
    const edges: McEdge[] = [
      { id: 'first', pk: 'aaa', npk: 'bbb' },
      { id: 'reverse-dup', pk: 'bbb', npk: 'aaa' },
    ];
    const result = dedupByUnorderedPair(edges, (e) => e.pk, (e) => e.npk);
    expect(result.map((e) => e.id)).toEqual(['first']);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupByUnorderedPair<Edge, number>([], (e) => e.a, (e) => e.b)).toEqual([]);
  });
});

describe('bearingBetween', () => {
  it('returns 0 degrees due north', () => {
    expect(bearingBetween([0, 0], [1, 0])).toBeCloseTo(0);
  });

  it('returns 90 degrees due east', () => {
    expect(bearingBetween([0, 0], [0, 1])).toBeCloseTo(90);
  });

  it('returns 180 degrees due south', () => {
    expect(bearingBetween([0, 0], [-1, 0])).toBeCloseTo(180);
  });

  it('returns -90 degrees due west', () => {
    expect(bearingBetween([0, 0], [0, -1])).toBeCloseTo(-90);
  });
});

describe('neighborArrowFractions', () => {
  it('defaults to 25%/50%/75% along the line', () => {
    expect(neighborArrowFractions).toEqual([0.25, 0.5, 0.75]);
  });
});

describe('pairNeighborRecords (#6403)', () => {
  const NOW = 1_700_000_000_000;
  // The report from the issue: A lists B heard ~12 h ago, B lists A heard 4 min ago,
  // both fetched at the same time.
  const aToB = { id: 118, publicKey: 'f4204044', neighborPublicKey: '9ec21d42', snr: 12.75, lastHeardSecs: 43320, timestamp: NOW };
  const bToA = { id: 120, publicKey: '9ec21d42', neighborPublicKey: 'f4204044', snr: -10.25, lastHeardSecs: 240, timestamp: NOW };

  it('picks the freshest direction as primary and keeps the other as reverse', () => {
    const [pair] = pairNeighborRecords([aToB, bToA]);
    expect(pair.primary.id).toBe(120);
    expect(pair.reverse?.id).toBe(118);
  });

  it('does not depend on row order', () => {
    const one = pairNeighborRecords([aToB, bToA]);
    const two = pairNeighborRecords([bToA, aToB]);
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(1);
    expect(one[0].primary.id).toBe(two[0].primary.id);
    expect(one[0].pairKey).toBe(two[0].pairKey);
  });

  it('accounts for the fetch timestamp, not just lastHeardSecs', () => {
    // Small lastHeardSecs, but fetched a day ago: really heard ~24 h ago.
    const oldFetch = { ...bToA, lastHeardSecs: 60, timestamp: NOW - 86_400_000 };
    const [pair] = pairNeighborRecords([aToB, oldFetch]);
    expect(pair.primary.id).toBe(118);
  });

  it('prefers a record with a known age over one without', () => {
    const unknown = { ...aToB, lastHeardSecs: null };
    const [pair] = pairNeighborRecords([unknown, { ...bToA, lastHeardSecs: 80000 }]);
    expect(pair.primary.id).toBe(120);
  });

  it('keeps the freshest record when one direction is reported more than once', () => {
    const stale = { ...bToA, id: 99, snr: 3, lastHeardSecs: 9000 };
    const [pair] = pairNeighborRecords([stale, bToA]);
    expect(pair.primary.id).toBe(120);
    expect(pair.reverse).toBeNull();
  });

  it('returns one entry per unordered pair', () => {
    const c = { id: 5, publicKey: 'cccc', neighborPublicKey: 'f4204044', snr: 1, lastHeardSecs: 10, timestamp: NOW };
    expect(pairNeighborRecords([aToB, bToA, c])).toHaveLength(2);
  });
});

describe('neighborHeardAtMs', () => {
  it('subtracts lastHeardSecs from the fetch timestamp', () => {
    expect(neighborHeardAtMs({ publicKey: 'a', neighborPublicKey: 'b', snr: 0, lastHeardSecs: 10, timestamp: 50_000 })).toBe(40_000);
  });
  it('returns null when a part is missing', () => {
    expect(neighborHeardAtMs({ publicKey: 'a', neighborPublicKey: 'b', snr: 0, lastHeardSecs: null, timestamp: 1 })).toBeNull();
    expect(neighborHeardAtMs({ publicKey: 'a', neighborPublicKey: 'b', snr: 0, lastHeardSecs: 1 })).toBeNull();
  });
});

describe('formatNeighborAge', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(formatNeighborAge(45)).toBe('45 s');
    expect(formatNeighborAge(240)).toBe('4 min');
    expect(formatNeighborAge(43320)).toBe('12 h');
    expect(formatNeighborAge(3 * 86400)).toBe('3 d');
    expect(formatNeighborAge(null)).toBeNull();
  });
});
