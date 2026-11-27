import { describe, expect, it } from 'vitest';
import { PaletteProfile } from '../v3/constants.js';
import { PALETTE_RGB } from '../v3/palettes.js';
import { COMPOSE_PROFILES } from './profiles.js';
import { isNearGray, matteWhite, quantize } from './quantize.js';
import type { RgbaImage, RgbImage } from './types.js';

const rgbImg = (w: number, h: number, px: number[][]): RgbImage => ({ width: w, height: h, rgb: Uint8ClampedArray.from(px.flat()) });

describe('matteWhite', () => {
  it('composites on white: alpha 0, 128 and 255', () => {
    const out = matteWhite({
      width: 3,
      height: 1,
      rgba: Uint8ClampedArray.from([10, 20, 30, 0, 10, 20, 30, 128, 10, 20, 30, 255]),
    });
    const a = 128 / 255;
    expect(Array.from(out.rgb)).toEqual([
      255, 255, 255,
      Math.round(10 * a + 255 * (1 - a)), Math.round(20 * a + 255 * (1 - a)), Math.round(30 * a + 255 * (1 - a)),
      10, 20, 30,
    ]);
  });
});

describe('quantize', () => {
  it('maps every palette colour of every offered profile to itself', () => {
    for (const p of COMPOSE_PROFILES) {
      const table = PALETTE_RGB[p];
      const px = table.map((v) => [(v >> 16) & 255, (v >> 8) & 255, v & 255]);
      const out = quantize(rgbImg(table.length, 1, px), p);
      // duplicates in a palette would resolve to the first index; compare by colour
      expect(Array.from(out).map((i) => table[i])).toEqual(Array.from(table));
    }
  });

  it('picks the nearest colour and the first index on a tie', () => {
    // mono: white (255) vs black (0); mid grey 127.5 is not integer; 127 is nearer black, 128 nearer white
    expect(Array.from(quantize(rgbImg(2, 1, [[127, 127, 127], [128, 128, 128]]), PaletteProfile.mono))).toEqual([1, 0]);
    // master4: silver 0xc0 (index 1) and gray 0x56 (index 2) are both 53 away from 139
    expect(quantize(rgbImg(1, 1, [[139, 139, 139]]), PaletteProfile.master4)[0]).toBe(1);
    expect(quantize(rgbImg(1, 1, [[255, 0, 0]]), PaletteProfile.mono)[0]).toBe(1);
  });

  it('does not dither by default and dithers deterministically on request', () => {
    const px: number[][] = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const v = Math.round(((x + y) / 14) * 255);
      px.push([v, v, v]);
    }
    const img = rgbImg(8, 8, px);
    const plain = quantize(img, PaletteProfile.mono);
    expect(Array.from(quantize(img, PaletteProfile.mono, { dither: false }))).toEqual(Array.from(plain));
    const d1 = Array.from(quantize(img, PaletteProfile.mono, { dither: true }));
    expect(Array.from(quantize(img, PaletteProfile.mono, { dither: true }))).toEqual(d1);
    expect(d1.join('')).toMatchInlineSnapshot(`"1111101011101101110101001011010111010000010101001010000001001000"`);
    expect(d1).not.toEqual(Array.from(plain));
  });
});

describe('isNearGray', () => {
  const mk = (px: number[][]): RgbaImage => ({ width: px.length, height: 1, rgba: Uint8ClampedArray.from(px.flat()) });
  it('accepts grey and rejects colour; ignores transparent pixels', () => {
    expect(isNearGray(mk([[100, 100, 100, 255], [110, 105, 100, 255]]))).toBe(true);
    expect(isNearGray(mk([[255, 0, 0, 255], [100, 100, 100, 255]]))).toBe(false);
    expect(isNearGray(mk([[255, 0, 0, 0], [100, 100, 100, 255]]))).toBe(true);
  });
  it('tolerates up to 2% colour pixels', () => {
    const grey = Array.from({ length: 98 }, () => [90, 90, 90, 255]);
    expect(isNearGray(mk([...grey, [255, 0, 0, 255], [0, 0, 255, 255]]))).toBe(true);
    expect(isNearGray(mk([...grey, [255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 255]]))).toBe(false);
  });
});
