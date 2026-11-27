import { describe, expect, it } from 'vitest';
import { PaletteProfile } from '../v3/constants.js';
import type { PaletteProfileId } from '../v3/constants.js';
import { DYNAMIC_GLOBAL512_RGB, PALETTE_RGB, isDynamicProfile } from '../v3/palettes.js';
import { V4BitReader } from './bitReader.js';
import {
  blackIndexFor,
  colorFromProfileRef,
  coordinateBits,
  coordinateMargin,
  coordinateValueCount,
  ellipseThirdFromDepth,
  isCoordinateInRange,
  localCoordinateBits,
  readCoordinate,
  readDimensions,
  scalarBits,
  zigZagDecode,
} from './primitives.js';

describe('coordinates', () => {
  it.each([
    [1, 1, 3, 2],
    [8, 1, 10, 4],
    [9, 2, 13, 4],
    [64, 8, 80, 7],
    [65, 9, 83, 7],
    [128, 16, 160, 8],
    [256, 16, 288, 9],
  ])('size %i: margin %i, %i codes, %i bits', (size, margin, count, bits) => {
    expect(coordinateMargin(size)).toBe(margin);
    expect(coordinateValueCount(size)).toBe(count);
    expect(coordinateBits(size)).toBe(bits);
  });

  it('rejects spare coordinate codes and accepts the overscan range', () => {
    const size = 64;
    const bits = coordinateBits(size);
    const spare = coordinateValueCount(size);
    expect(spare).toBeLessThan(2 ** bits);
    const b = new Uint8Array([spare & 0xff, spare >> 8]);
    expect(() => readCoordinate(new V4BitReader(b), bits, size)).toThrow('MCOimg v4 coordinate is out of range');
    expect(isCoordinateInRange(-8, size)).toBe(true);
    expect(isCoordinateInRange(-9, size)).toBe(false);
    expect(isCoordinateInRange(71, size)).toBe(true);
    expect(isCoordinateInRange(72, size)).toBe(false);
  });

  it('local and scalar widths', () => {
    expect(localCoordinateBits(1)).toBe(1);
    expect(localCoordinateBits(5)).toBe(3);
    expect(scalarBits(1, 1)).toBe(1);
    expect(scalarBits(48, 33)).toBe(6);
    expect(scalarBits(256, 3)).toBe(8);
  });

  it('zigzag', () => {
    expect([0, 1, 2, 3, 4].map(zigZagDecode)).toEqual([0, -1, 1, -2, 2]);
  });
});

describe('blackIndexFor', () => {
  const all = Object.values(PaletteProfile) as PaletteProfileId[];
  it('names black in every profile', () => {
    expect(all.length).toBe(16);
    for (const profile of all) {
      const index = blackIndexFor(profile);
      const rgb = isDynamicProfile(profile) ? DYNAMIC_GLOBAL512_RGB[index] : PALETTE_RGB[profile][index];
      expect(rgb, `profile ${profile}`).toBe(0);
    }
  });
});

describe('colorFromProfileRef', () => {
  it('maps dynamic refs to global indices and rejects out-of-range refs', () => {
    expect(colorFromProfileRef(PaletteProfile.master4, 3)).toBe(3);
    expect(colorFromProfileRef(PaletteProfile.dynamicGlobal8, 1)).toBe(83);
    expect(() => colorFromProfileRef(PaletteProfile.master4, 4)).toThrow('Color reference 4 is outside master4');
  });
});

describe('readDimensions', () => {
  const dims = (bits: number[]): { width: number; height: number } => {
    const bytes = new Uint8Array(4);
    bits.forEach((b, i) => {
      bytes[i >> 3] |= b << (i & 7);
    });
    return readDimensions(new V4BitReader(bytes));
  };
  it('reads a canonical square and rejects a non-canonical small square', () => {
    expect(dims([0, 0, 1, 0, 0, 0, 0, 0])).toEqual({ width: 2, height: 2 });
    expect(() => dims([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toThrow('Non-canonical v4 small square dimensions');
  });
});

describe('ellipseThirdFromDepth', () => {
  it('lands on integer points only', () => {
    // axis (0,0)-(6,8), L = 10: depth 5 moves (-8,6)/10 * 5 = (-4,3) from mid (3,4)
    expect(ellipseThirdFromDepth({ x: 0, y: 0 }, { x: 6, y: 8 }, 5)).toEqual({ x: -1, y: 7 });
    expect(ellipseThirdFromDepth({ x: 0, y: 0 }, { x: 6, y: 8 }, 1)).toBeNull();
    expect(ellipseThirdFromDepth({ x: 0, y: 0 }, { x: 1, y: 1 }, 1)).toBeNull(); // L not an integer
    expect(ellipseThirdFromDepth({ x: 2, y: 2 }, { x: 2, y: 2 }, 1)).toBeNull();
    expect(ellipseThirdFromDepth({ x: 0, y: 0 }, { x: 4, y: 0 }, -3)).toEqual({ x: 2, y: -3 });
  });
});
