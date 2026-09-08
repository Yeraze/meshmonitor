/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { formatCount } from './numberFormat';

// These assert the pinned en-US separators *regardless of host locale* — the
// whole point of the helper. On a de_DE host, bare toLocaleString() would yield
// `2.134`/`2.000`, which is exactly the regression these guard against.
describe('formatCount', () => {
  it('adds en-US thousands separators', () => {
    expect(formatCount(2134)).toBe('2,134');
    expect(formatCount(2000)).toBe('2,000');
    expect(formatCount(1234567)).toBe('1,234,567');
  });

  it('does not add a separator below 1,000', () => {
    expect(formatCount(999)).toBe('999');
    expect(formatCount(2)).toBe('2');
    expect(formatCount(50)).toBe('50');
  });

  it('returns empty string for non-finite input', () => {
    expect(formatCount(NaN)).toBe('');
    expect(formatCount(Infinity)).toBe('');
    expect(formatCount(-Infinity)).toBe('');
  });
});
