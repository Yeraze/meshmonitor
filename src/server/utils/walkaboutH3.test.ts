import { describe, it, expect } from 'vitest';
import { cellToBoundary, cellToChildren, cellToParent, latLngToCell } from 'h3-js';
import { parseWalkaboutCell, walkaboutCellBBox, walkaboutCellOf } from './walkaboutH3.js';

/** Find a point where direct res-7 binning and res-9-then-parent disagree. */
function findDisagreement(res: 7 | 8): [number, number] {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let i = 0; i < 200_000; i++) {
    const lat = 40 + rnd() * 0.5;
    const lon = -105 + rnd() * 0.5;
    if (latLngToCell(lat, lon, res) !== cellToParent(latLngToCell(lat, lon, 9), res)) return [lat, lon];
  }
  throw new Error('no disagreement found');
}

describe('walkaboutCellOf', () => {
  it.each([7, 8] as const)('uses res 9 then the parent at res %i (the single rule)', (res) => {
    const [lat, lon] = findDisagreement(res);
    const viaParent = cellToParent(latLngToCell(lat, lon, 9), res);
    expect(latLngToCell(lat, lon, res)).not.toBe(viaParent);
    expect(walkaboutCellOf(lat, lon, res)).toBe(viaParent);
  });

  it('returns the res-9 cell at res 9', () => {
    expect(walkaboutCellOf(40.1, -105.1, 9)).toBe(latLngToCell(40.1, -105.1, 9));
  });
});

describe('parseWalkaboutCell', () => {
  it('accepts res 7..9 and reports the resolution', () => {
    for (const res of [7, 8, 9] as const) {
      const c = latLngToCell(40, -105, res);
      expect(parseWalkaboutCell(c)).toEqual({ cell: c, res });
    }
  });
  it('rejects res 6 and 10, junk and non-strings', () => {
    expect(parseWalkaboutCell(latLngToCell(40, -105, 6))).toBeNull();
    expect(parseWalkaboutCell(latLngToCell(40, -105, 10))).toBeNull();
    expect(parseWalkaboutCell('nope')).toBeNull();
    expect(parseWalkaboutCell('')).toBeNull();
    expect(parseWalkaboutCell('ffffffffffffff0')).toBeNull();
    expect(parseWalkaboutCell(12345)).toBeNull();
    expect(parseWalkaboutCell(null)).toBeNull();
  });
});

describe('walkaboutCellBBox', () => {
  it('contains every vertex of every res-9 child', () => {
    for (const res of [7, 8, 9] as const) {
      const cell = latLngToCell(40, -105, res);
      const b = walkaboutCellBBox(cell)!;
      expect(b).not.toBeNull();
      for (const child of cellToChildren(cell, 9)) {
        for (const [lat, lng] of cellToBoundary(child)) {
          expect(lat).toBeGreaterThanOrEqual(b.south);
          expect(lat).toBeLessThanOrEqual(b.north);
          expect(lng).toBeGreaterThanOrEqual(b.west);
          expect(lng).toBeLessThanOrEqual(b.east);
        }
      }
    }
  });
  it('is null for a cell on the antimeridian', () => {
    expect(walkaboutCellBBox(latLngToCell(10, 180, 7))).toBeNull();
  });
});
