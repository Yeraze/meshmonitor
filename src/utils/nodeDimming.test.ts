import { describe, it, expect } from 'vitest';
import { calculateNodeOpacity } from './nodeDimming';

const NOW = 1_700_000_000_000;
const hoursAgoSec = (h: number) => (NOW - h * 3_600_000) / 1000;

describe('calculateNodeOpacity', () => {
  it('returns 1 when disabled', () => {
    expect(calculateNodeOpacity(hoursAgoSec(20), false, 1, 0.3, 24, NOW)).toBe(1);
  });
  it('returns 1 when lastHeard is missing', () => {
    expect(calculateNodeOpacity(undefined, true, 1, 0.3, 24, NOW)).toBe(1);
    expect(calculateNodeOpacity(0, true, 1, 0.3, 24, NOW)).toBe(1);
  });
  it('returns 1 within the start threshold', () => {
    expect(calculateNodeOpacity(hoursAgoSec(1), true, 1, 0.3, 24, NOW)).toBe(1);
  });
  it('interpolates linearly between start and window end', () => {
    // start 2h, end 12h, min 0.5: at 7h progress 0.5 -> 0.75
    expect(calculateNodeOpacity(hoursAgoSec(7), true, 2, 0.5, 12, NOW)).toBeCloseTo(0.75);
  });
  it('clamps to minOpacity past the window end', () => {
    expect(calculateNodeOpacity(hoursAgoSec(100), true, 2, 0.4, 12, NOW)).toBeCloseTo(0.4);
  });
  it('returns 1 when the window is not wider than the start (incl. 0 = show all)', () => {
    expect(calculateNodeOpacity(hoursAgoSec(50), true, 2, 0.4, 2, NOW)).toBe(1);
    expect(calculateNodeOpacity(hoursAgoSec(50), true, 2, 0.4, 0, NOW)).toBe(1);
  });
});
