import { describe, it, expect } from 'vitest';
import {
  precisionCellSizeMeters,
  precisionCellSizeDegrees,
  shouldOffsetForPrecision,
  hasAccuracyCell,
  offsetWithinPrecisionCell,
  occupancyOffsetScale,
  precisionCellKey,
  applyPrecisionCellOffsets,
  OBSCURED_PRECISION_MAX_BITS,
  OFFSET_MAGNITUDE_CAP_BITS,
  OFFSET_SPREAD_SATURATION_OCCUPANCY,
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

  it('spread=0 leaves the marker at its true center', () => {
    expect(offsetWithinPrecisionCell(lat, lng, bits, 'node-a', 0)).toEqual([lat, lng]);
  });

  it('offset magnitude scales linearly with spread', () => {
    const [full] = offsetWithinPrecisionCell(lat, lng, bits, 'node-a', 1);
    const [half] = offsetWithinPrecisionCell(lat, lng, bits, 'node-a', 0.5);
    expect(Math.abs(half - lat)).toBeCloseTo(Math.abs(full - lat) / 2, 12);
  });
});

// #4155 — cap the jitter magnitude so coarse-precision (few-bit) nodes, whose
// true cell can span kilometers to continents, don't scatter far from the point
// they reported. Everything at/above the cap is unchanged.
describe('offsetWithinPrecisionCell — magnitude cap (#4155)', () => {
  const lat = 40;
  const lng = -105;
  const id = 'coarse-node';

  it('never jitters a coarse-precision marker past the OFFSET_MAGNITUDE_CAP_BITS half-cell', () => {
    const capHalfLat = precisionCellSizeDegrees(OFFSET_MAGNITUDE_CAP_BITS) / 2;
    const capHalfLng = capHalfLat / Math.cos((lat * Math.PI) / 180);
    for (const bits of [1, 5, 10, 14]) {
      const [oLat, oLng] = offsetWithinPrecisionCell(lat, lng, bits, id);
      expect(Math.abs(oLat - lat)).toBeLessThanOrEqual(capHalfLat + 1e-12);
      expect(Math.abs(oLng - lng)).toBeLessThanOrEqual(capHalfLng + 1e-12);
    }
  });

  it('gives every precision below the cap the identical (clamped) offset', () => {
    // bits 1, 5, 14 all clamp to the same 15-bit cell → same jitter for one id.
    const at1 = offsetWithinPrecisionCell(lat, lng, 1, id);
    const at5 = offsetWithinPrecisionCell(lat, lng, 5, id);
    const at14 = offsetWithinPrecisionCell(lat, lng, 14, id);
    expect(at5).toEqual(at1);
    expect(at14).toEqual(at1);
  });

  it('leaves bits at/above the cap scaling with their own (smaller) true cell', () => {
    // 16 and 18 bits are finer than the cap, so their offsets stay distinct and
    // strictly smaller than a cap-sized one.
    const capHalf = precisionCellSizeDegrees(OFFSET_MAGNITUDE_CAP_BITS) / 2;
    const [o16] = offsetWithinPrecisionCell(lat, lng, 16, id);
    const [o18] = offsetWithinPrecisionCell(lat, lng, 18, id);
    expect(Math.abs(o16 - lat)).toBeLessThan(capHalf);
    expect(Math.abs(o18 - lat)).toBeLessThan(Math.abs(o16 - lat)); // finer → smaller
  });
});

describe('occupancyOffsetScale (#4155)', () => {
  it('is 0 for an empty or lone cell', () => {
    expect(occupancyOffsetScale(0)).toBe(0);
    expect(occupancyOffsetScale(1)).toBe(0);
  });

  it('grows monotonically with occupancy up to saturation', () => {
    expect(occupancyOffsetScale(2)).toBeGreaterThan(0);
    expect(occupancyOffsetScale(3)).toBeGreaterThan(occupancyOffsetScale(2));
    expect(occupancyOffsetScale(4)).toBeGreaterThan(occupancyOffsetScale(3));
  });

  it('scales logarithmically — the 2→3 step is gentler than the 1→2 jump', () => {
    const jump1to2 = occupancyOffsetScale(2) - occupancyOffsetScale(1); // 0 → base
    const step2to3 = occupancyOffsetScale(3) - occupancyOffsetScale(2);
    expect(step2to3).toBeLessThan(jump1to2);
  });

  it('saturates at 1 by OFFSET_SPREAD_SATURATION_OCCUPANCY and stays clamped', () => {
    expect(occupancyOffsetScale(OFFSET_SPREAD_SATURATION_OCCUPANCY)).toBeCloseTo(1, 10);
    expect(occupancyOffsetScale(OFFSET_SPREAD_SATURATION_OCCUPANCY * 4)).toBe(1);
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

  it('spreads a more crowded cell wider than a barely-shared one (#4155 log scaling)', () => {
    // Same target node 'a' at the same cell; only the occupancy differs, so its
    // offset magnitude reflects the occupancy scale (2 → base, 8 → saturated).
    const pos: [number, number] = [30, -90];
    const shared2 = applyPrecisionCellOffsets([inp('a', pos, 16), inp('b', pos, 16)]);
    const crowded8 = applyPrecisionCellOffsets(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => inp(n, pos, 16)),
    );
    const dA2 = Math.abs(shared2.find((o) => o.item === 'a')!.latLng[0] - 30);
    const dA8 = Math.abs(crowded8.find((o) => o.item === 'a')!.latLng[0] - 30);
    expect(dA2).toBeGreaterThan(0);
    expect(dA8).toBeGreaterThan(dA2);
  });

  it('caps the offset for a coarse-precision shared cell (#4155)', () => {
    // Two 6-bit nodes share a cell (true side ~745 km); the marker must still
    // land within the 15-bit cap, not its own enormous cell.
    const capHalf = precisionCellSizeDegrees(OFFSET_MAGNITUDE_CAP_BITS) / 2;
    const out = applyPrecisionCellOffsets([inp('a', [10, 20], 6), inp('b', [10, 20], 6)]);
    for (const o of out) {
      expect(o.latLng).not.toEqual([10, 20]); // it was offset...
      expect(Math.abs(o.latLng[0] - 10)).toBeLessThanOrEqual(capHalf + 1e-12); // ...but capped
    }
  });

  it('never pushes two overlapping, differently-sized nodes closer than their true centers (#4155)', () => {
    // Same reported point, different precision → different cells → each is alone
    // → neither is offset, so their separation is exactly preserved (not worsened
    // by a flat per-node jitter, the regression this refinement guards against).
    const out = applyPrecisionCellOffsets([inp('big', [30, -90], 12), inp('small', [30, -90], 17)]);
    expect(out.find((o) => o.item === 'big')!.latLng).toEqual([30, -90]);
    expect(out.find((o) => o.item === 'small')!.latLng).toEqual([30, -90]);
  });
});
