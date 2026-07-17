import { describe, it, expect } from 'vitest';
import {
  precisionCellSizeMeters,
  precisionCellSizeDegrees,
  shouldOffsetForPrecision,
  hasAccuracyCell,
  offsetWithinPrecisionCell,
  precisionCellKey,
  applyPrecisionCellOffsets,
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

describe('precisionCellKey', () => {
  it('is identical for the same reported position and precision (same cell)', () => {
    expect(precisionCellKey(30, -90, 16)).toBe(precisionCellKey(30, -90, 16));
  });

  it('differs when the precision differs (different cell size = different cell)', () => {
    expect(precisionCellKey(30, -90, 16)).not.toBe(precisionCellKey(30, -90, 14));
  });

  it('differs for positions in different cells', () => {
    const size = precisionCellSizeDegrees(16);
    // Two points more than a full cell apart fall in different cells.
    expect(precisionCellKey(30, -90, 16)).not.toBe(precisionCellKey(30 + size * 2, -90, 16));
  });

  it('groups two near-center points of the same snapped cell together', () => {
    const size = precisionCellSizeDegrees(16);
    // Points within the same cell (both < one cell apart, same grid index).
    const baseLatIdx = Math.floor(30 / size);
    const a = (baseLatIdx + 0.25) * size;
    const b = (baseLatIdx + 0.75) * size;
    expect(precisionCellKey(a, -90, 16)).toBe(precisionCellKey(b, -90, 16));
  });
});

describe('applyPrecisionCellOffsets', () => {
  const inp = (item: string, latLng: [number, number], bits: number | null | undefined, isOverride = false) =>
    ({ item, id: item, latLng, bits, isOverride });

  it('leaves a lone offsettable node at its true center', () => {
    const out = applyPrecisionCellOffsets([inp('a', [30, -90], 16)]);
    expect(out).toEqual([{ item: 'a', latLng: [30, -90] }]);
  });

  it('spreads 2+ nodes sharing a cell to distinct in-cell spots', () => {
    const out = applyPrecisionCellOffsets([inp('a', [30, -90], 16), inp('b', [30, -90], 16)]);
    const a = out.find((o) => o.item === 'a')!.latLng;
    const b = out.find((o) => o.item === 'b')!.latLng;
    expect(a).not.toEqual([30, -90]);
    expect(b).not.toEqual([30, -90]);
    expect(a).not.toEqual(b);
    const half = precisionCellSizeDegrees(16) / 2;
    expect(Math.abs(a[0] - 30)).toBeLessThanOrEqual(half);
    expect(Math.abs(b[0] - 30)).toBeLessThanOrEqual(half);
  });

  it('does NOT merge same-position nodes of different precision (different cells)', () => {
    const out = applyPrecisionCellOffsets([inp('a', [30, -90], 16), inp('b', [30, -90], 14)]);
    // Each is alone in its own (differently-sized) cell -> both stay centered.
    expect(out.find((o) => o.item === 'a')!.latLng).toEqual([30, -90]);
    expect(out.find((o) => o.item === 'b')!.latLng).toEqual([30, -90]);
  });

  it('never offsets full-precision, missing-precision, or overridden nodes even when co-located', () => {
    const out = applyPrecisionCellOffsets([
      inp('full', [30, -90], 32),
      inp('missing', [30, -90], null),
      inp('override', [30, -90], 16, true),
    ]);
    expect(out).toEqual([
      { item: 'full', latLng: [30, -90] },
      { item: 'missing', latLng: [30, -90] },
      { item: 'override', latLng: [30, -90] },
    ]);
  });

  it('preserves input order and item identity', () => {
    const out = applyPrecisionCellOffsets([inp('x', [10, 10], 32), inp('y', [20, 20], 32)]);
    expect(out.map((o) => o.item)).toEqual(['x', 'y']);
  });

  it('is deterministic across calls', () => {
    const args = [inp('a', [30, -90], 16), inp('b', [30, -90], 16)];
    expect(applyPrecisionCellOffsets(args)).toEqual(applyPrecisionCellOffsets(args));
  });
});
