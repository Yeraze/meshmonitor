import { describe, it, expect } from 'vitest';
import { snapToPrecisionCell, precisionCellSizeDegrees } from './precisionOffset.js';

describe('snapToPrecisionCell', () => {
  it('matches firmware integer math at 14 bits', () => {
    const cell = 2 ** 18;
    const half = 2 ** 17;
    const i = 402_345_678;
    expect(snapToPrecisionCell(i, 14, true)).toBe(Math.floor(i / cell) * cell + half);
  });
  it('floors negatives toward -infinity', () => {
    const cell = 2 ** 18;
    const i = -1_000_000_000 + 5;
    const out = snapToPrecisionCell(i, 14, true);
    expect(out).toBe(Math.floor(i / cell) * cell + cell / 2);
    expect(Number.isInteger(out)).toBe(true);
    expect(Math.abs(out - i)).toBeLessThanOrEqual(cell / 2);
  });
  it('is idempotent', () => {
    const once = snapToPrecisionCell(123_456_789, 14, true);
    expect(snapToPrecisionCell(once, 14, true)).toBe(once);
  });
  it('degrees mode agrees with integer mode and stays within the cell', () => {
    const deg = 40.2345678;
    const out = snapToPrecisionCell(deg, 14, false);
    expect(out).toBeCloseTo(snapToPrecisionCell(Math.round(deg * 1e7), 14, true) / 1e7, 9);
    expect(Math.abs(out - deg)).toBeLessThanOrEqual(precisionCellSizeDegrees(14) / 2 + 1e-9);
  });
  it('leaves non-finite and out-of-range bits unchanged', () => {
    expect(snapToPrecisionCell(NaN, 14, true)).toBeNaN();
    expect(snapToPrecisionCell(1234, 0, true)).toBe(1234);
    expect(snapToPrecisionCell(1234, 32, true)).toBe(1234);
  });
});
