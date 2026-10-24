import { describe, it, expect } from 'vitest';
import { mergeSourceLines, MERGE_WINDOW_MS } from './mergeSourceLines';

const T = 1_760_000_000_000;
const line = (sourceName: string, pts: Array<[number, number]>) => ({
  sourceName,
  points: pts.map(([dt, value]) => ({ timestamp: T + dt, value })),
});

describe('mergeSourceLines (#5931)', () => {
  it('fills one source\'s gaps from another', () => {
    const out = mergeSourceLines([line('A', [[0, 1], [120_000, 3]]), line('B', [[60_000, 2]])]);
    expect(out.map((p) => p.value)).toEqual([1, 2, 3]);
    expect(out.map((p) => p.sources)).toEqual([['A'], ['B'], ['A']]);
  });

  it('plots a bucket both sources hold once, at the mean', () => {
    const out = mergeSourceLines([line('A', [[0, 20]]), line('B', [[0, 21]])]);
    expect(out).toEqual([{ timestamp: T, value: 20.5, sources: ['A', 'B'] }]);
  });

  it('treats one packet heard by two sources a few seconds apart as one reading', () => {
    const out = mergeSourceLines([line('A', [[0, 4.1]]), line('B', [[7_000, 4.1]])]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ timestamp: T, sources: ['A', 'B'] });
    expect(out[0].value).toBeCloseTo(4.1);
  });

  it('keeps two sources\' adjacent 1-minute buckets apart', () => {
    const out = mergeSourceLines([line('A', [[0, 1]]), line('B', [[MERGE_WINDOW_MS, 2]])]);
    expect(out).toHaveLength(2);
  });

  it('never merges a source with its own points', () => {
    const out = mergeSourceLines([line('A', [[0, 1], [10_000, 2]])]);
    expect(out.map((p) => p.value)).toEqual([1, 2]);
  });

  it('lists sources in line order, whatever order the points arrive in', () => {
    const out = mergeSourceLines([line('A', [[5_000, 1]]), line('B', [[0, 1]])]);
    expect(out[0].sources).toEqual(['A', 'B']);
    expect(out[0].timestamp).toBe(T);
  });

  it('returns nothing for no points', () => {
    expect(mergeSourceLines([line('A', []), line('B', [])])).toEqual([]);
  });
});
