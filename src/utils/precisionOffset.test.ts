import { describe, it, expect } from 'vitest';
import {
  precisionCellSizeMeters,
  precisionCellSizeDegrees,
  shouldOffsetForPrecision,
  hasAccuracyCell,
  offsetWithinPrecisionCell,
  OBSCURED_PRECISION_MAX_BITS,
} from './precisionOffset';

describe('precisionCellSizeMeters', () => {
  it('matches the accuracy-region formula at representative bit widths', () => {
    // 18 bits → ~182m cell side.
    expect(precisionCellSizeMeters(18)).toBeCloseTo(182.0, 0);
    // 16 bits → ~728m.
    expect(precisionCellSizeMeters(16)).toBeCloseTo(728.2, 0);
    // Each bit lost doubles the cell.
    expect(precisionCellSizeMeters(17) / precisionCellSizeMeters(18)).toBeCloseTo(2, 5);
  });

  it('degrees and meters agree via 111111 m/deg', () => {
    expect(precisionCellSizeDegrees(18) * 111_111).toBeCloseTo(precisionCellSizeMeters(18), 6);
  });
});

describe('shouldOffsetForPrecision', () => {
  it('offsets only defined low precision (1..18) that is not overridden', () => {
    expect(shouldOffsetForPrecision(16, false)).toBe(true);
    expect(shouldOffsetForPrecision(1, false)).toBe(true);
    expect(shouldOffsetForPrecision(OBSCURED_PRECISION_MAX_BITS, false)).toBe(true);
  });

  it('does not offset fine precision, missing, zero, or overridden nodes', () => {
    expect(shouldOffsetForPrecision(19, false)).toBe(false); // just above threshold
    expect(shouldOffsetForPrecision(32, false)).toBe(false); // full precision
    expect(shouldOffsetForPrecision(0, false)).toBe(false);  // disabled/unknown cell
    expect(shouldOffsetForPrecision(null, false)).toBe(false);
    expect(shouldOffsetForPrecision(undefined, false)).toBe(false);
    expect(shouldOffsetForPrecision(16, true)).toBe(false);  // user-overridden position
  });
});

describe('hasAccuracyCell', () => {
  it('is true for any defined non-full precision (1..31), excluding overrides', () => {
    expect(hasAccuracyCell(31, false)).toBe(true);   // medium precision still has a cell
    expect(hasAccuracyCell(19, false)).toBe(true);   // above the offset threshold but still drawn
    expect(hasAccuracyCell(16, false)).toBe(true);
    expect(hasAccuracyCell(1, false)).toBe(true);
  });

  it('is false for full precision, zero, missing, or overridden nodes', () => {
    expect(hasAccuracyCell(32, false)).toBe(false);
    expect(hasAccuracyCell(0, false)).toBe(false);
    expect(hasAccuracyCell(null, false)).toBe(false);
    expect(hasAccuracyCell(undefined, false)).toBe(false);
    expect(hasAccuracyCell(16, true)).toBe(false);
  });

  it('is a superset of shouldOffsetForPrecision', () => {
    for (const bits of [1, 10, 18, 19, 25, 31]) {
      if (shouldOffsetForPrecision(bits, false)) expect(hasAccuracyCell(bits, false)).toBe(true);
    }
  });
});

describe('offsetWithinPrecisionCell', () => {
  const lat = 40;
  const lng = -105;
  const bits = 16;

  it('is deterministic for a given id', () => {
    const a = offsetWithinPrecisionCell(lat, lng, bits, 'node-a');
    const b = offsetWithinPrecisionCell(lat, lng, bits, 'node-a');
    expect(a).toEqual(b);
  });

  it('produces different offsets for different ids', () => {
    const a = offsetWithinPrecisionCell(lat, lng, bits, 'node-a');
    const b = offsetWithinPrecisionCell(lat, lng, bits, 'node-b');
    expect(a).not.toEqual(b);
  });

  it('keeps the marker inside the ± half-cell accuracy rectangle', () => {
    const halfLat = precisionCellSizeDegrees(bits) / 2;
    const halfLng = halfLat / Math.cos((lat * Math.PI) / 180);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'long-node-id-123', '']) {
      const [oLat, oLng] = offsetWithinPrecisionCell(lat, lng, bits, id);
      expect(Math.abs(oLat - lat)).toBeLessThanOrEqual(halfLat);
      expect(Math.abs(oLng - lng)).toBeLessThanOrEqual(halfLng);
    }
  });

  it('larger cells (fewer bits) produce larger offsets', () => {
    const near = offsetWithinPrecisionCell(lat, lng, 18, 'same-id');
    const far = offsetWithinPrecisionCell(lat, lng, 10, 'same-id');
    const dNear = Math.abs(near[0] - lat);
    const dFar = Math.abs(far[0] - lat);
    expect(dFar).toBeGreaterThan(dNear);
  });
});
