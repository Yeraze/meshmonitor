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
