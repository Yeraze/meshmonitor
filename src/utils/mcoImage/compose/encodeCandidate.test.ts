import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectMcoImage } from '../detect.js';
import { PaletteProfile, type PaletteProfileId } from '../v3/constants.js';
import { PALETTE_RGB } from '../v3/palettes.js';
import { encodeCandidate, McoComposeSelfCheckError } from './encodeCandidate.js';
import type { EncodeV3Fn, RgbaImage } from './types.js';

interface Fx {
  name: string;
  width: number;
  height: number;
  paletteProfile: keyof typeof PaletteProfile;
  pixels: number[];
  bodyBase64: string;
}
const fixtures = (
  JSON.parse(readFileSync(new URL('../__fixtures__/v3-js-encoder-fixtures.json', import.meta.url), 'utf8')) as {
    fixtures: Fx[];
  }
).fixtures.filter((f) => PALETTE_RGB[PaletteProfile[f.paletteProfile]] !== undefined);

/** A source whose palette quantization reproduces the fixture pixels exactly (no resize). */
function sourceFor(f: Fx): RgbaImage {
  const table = PALETTE_RGB[PaletteProfile[f.paletteProfile]];
  const rgba = new Uint8ClampedArray(f.width * f.height * 4);
  f.pixels.forEach((p, i) => {
    const v = table[p];
    rgba.set([(v >> 16) & 255, (v >> 8) & 255, v & 255, 255], i * 4);
  });
  return { width: f.width, height: f.height, rgba };
}

const fakeFor =
  (f: Fx): EncodeV3Fn =>
  () => {
    const body = Uint8Array.from(Buffer.from(f.bodyBase64, 'base64'));
    return { body, bodyWithoutNonce: body.subarray(1), text: '' };
  };

describe('encodeCandidate', () => {
  it.each(fixtures.map((f) => [f.name, f] as const))('%s: both texts are detected and decode to the pixels', (_n, f) => {
    const profile = PaletteProfile[f.paletteProfile] as PaletteProfileId;
    const r = encodeCandidate(sourceFor(f), { longest: Math.max(f.width, f.height), profile, dither: false }, 'normal', () => 0.5, {
      encodeV3: fakeFor(f),
    });
    expect([r.w, r.h]).toEqual([f.width, f.height]);
    expect(detectMcoImage(r.im3Text)?.format).toBe('im3');
    expect(detectMcoImage(r.im4Text)?.format).toBe('im4');
    expect(r.im3Bytes).toBe(r.im3Text.length);
    expect(r.im4Bytes).toBe(r.im4Text.length);
    expect(r.im4Bytes).toBeGreaterThanOrEqual(r.im3Bytes);
    expect(r.level).toBe('normal');
  });

  it('rejects a tampered encoder', () => {
    const f = fixtures[0];
    const profile = PaletteProfile[f.paletteProfile] as PaletteProfileId;
    const src = sourceFor(f);
    src.rgba.fill(0, 0, 4); // first pixel becomes black: no longer what the body encodes
    src.rgba[3] = 255;
    const first = f.pixels[0];
    const black = PALETTE_RGB[profile].indexOf(0);
    expect(first).not.toBe(black);
    expect(() =>
      encodeCandidate(src, { longest: Math.max(f.width, f.height), profile, dither: false }, 'normal', () => 0, {
        encodeV3: fakeFor(f),
      }),
    ).toThrow(McoComposeSelfCheckError);
  });
});
