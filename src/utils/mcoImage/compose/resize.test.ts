import { describe, expect, it } from 'vitest';
import { resizeArea, targetDims } from './resize.js';
import type { RgbaImage } from './types.js';

const img = (w: number, h: number, px: number[][]): RgbaImage => ({
  width: w,
  height: h,
  rgba: Uint8ClampedArray.from(px.flat()),
});

describe('targetDims', () => {
  it('keeps aspect, longest side exact, short side rounded and at least 1', () => {
    expect(targetDims(512, 256, 32)).toEqual({ w: 32, h: 16 });
    expect(targetDims(100, 300, 32)).toEqual({ w: 11, h: 32 });
    expect(targetDims(1000, 3, 16)).toEqual({ w: 16, h: 1 });
    expect(targetDims(40, 40, 24)).toEqual({ w: 24, h: 24 });
  });
});

describe('resizeArea', () => {
  it('averages 2x2 blocks for 4x4 -> 2x2', () => {
    const px: number[][] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) px.push([x * 10 + y * 40, 0, 0, 255]);
    const out = resizeArea(img(4, 4, px), 2, 2);
    // block (0,0): x in {0,1}, y in {0,1}: mean(0,10,40,50) = 25
    expect(Array.from(out.rgba.slice(0, 4))).toEqual([25, 0, 0, 255]);
    expect(out.rgba[4]).toBe(45); // block (1,0): mean(20,30,60,70)
    expect(out.rgba[8]).toBe(105); // block (0,1): mean(80,90,120,130)
  });

  it('uses fractional coverage for 3x3 -> 2x2', () => {
    const v = [0, 90, 180];
    const px: number[][] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) px.push([v[x], 0, 0, 255]);
    const out = resizeArea(img(3, 3, px), 2, 2);
    // x range [0,1.5): 0*1 + 90*0.5 over 1.5 = 30 ; [1.5,3): 90*0.5 + 180*1 over 1.5 = 150
    expect(out.rgba[0]).toBe(30);
    expect(out.rgba[4]).toBe(150);
  });

  it('weights colour by alpha so transparent pixels do not darken', () => {
    // opaque white next to fully transparent black
    const out = resizeArea(img(2, 1, [[255, 255, 255, 255], [0, 0, 0, 0]]), 1, 1);
    expect(Array.from(out.rgba)).toEqual([255, 255, 255, 128]);
  });

  it('upscales by nearest sampling', () => {
    const out = resizeArea(img(2, 1, [[10, 0, 0, 255], [200, 0, 0, 255]]), 4, 2);
    expect(Array.from({ length: 4 }, (_, i) => out.rgba[i * 4])).toEqual([10, 10, 200, 200]);
    expect(out.rgba[(4 + 0) * 4]).toBe(10);
  });

  it('is the identity at equal size', () => {
    const src = img(2, 2, [[1, 2, 3, 255], [4, 5, 6, 255], [7, 8, 9, 255], [10, 11, 12, 255]]);
    expect(Array.from(resizeArea(src, 2, 2).rgba)).toEqual(Array.from(src.rgba));
  });
});
