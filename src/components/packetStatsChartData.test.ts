import { describe, it, expect } from 'vitest';
import { toChartEntries, DISTRIBUTION_COLORS } from './packetStatsChartData';

describe('toChartEntries', () => {
  it('maps rows and cycles palette colours', () => {
    const rows = Array.from({ length: DISTRIBUTION_COLORS.length + 1 }, (_, i) => ({ n: `r${i}`, c: i }));
    const out = toChartEntries(rows, r => r.n, r => r.c);
    expect(out[0]).toEqual({ name: 'r0', value: 0, color: DISTRIBUTION_COLORS[0] });
    expect(out[DISTRIBUTION_COLORS.length].color).toBe(DISTRIBUTION_COLORS[0]);
  });
  it('honours a colour override', () => {
    expect(toChartEntries([{ n: 'a' }], r => r.n, () => 1, () => 'var(--x)')[0].color).toBe('var(--x)');
  });
});
