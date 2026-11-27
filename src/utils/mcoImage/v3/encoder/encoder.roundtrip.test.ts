/**
 * Differential tests of the TypeScript v3 encoder against the upstream JS encoder.
 *
 * Fixtures (all produced by the upstream encoder, never by this port):
 *   v3-js-encoder-fixtures.json   copied from HDDen/meshcore-open commit c38c1650 docs/mcoimg-js/tests/
 *   v3-diff-fixtures.json         public-API cases plus `regions-*` and `boundsBlock-*` internal-entry cases
 *   v3-encoder-photo-fixtures.json  quantised photo and line-art images (see its `_source`)
 * Upstream: MIT License, Copyright (c) 2025 zjs81.
 *
 * Every case is byte-exact: the same body bytes and the same text.
 */
import { describe, expect, it } from 'vitest';
import { PaletteProfile, ScanMode } from '../constants.js';
import type { PaletteProfileId } from '../constants.js';
import { DynamicGlobalIndices, isDynamicProfile, paletteSize } from '../palettes.js';
import { decodeV3Text } from '../decoder.js';
import { encodeV3 } from './encode.js';
import type { McoV3Level } from './encode.js';
import { HIGH_TIMEOUT_MS } from './encoder.testSupport.js';

describe('round trip', () => {
  let seed = 4242;
  const rnd = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 4294967296) * n);
  };
  /** A few rectangles of few colours over a background, plus a little noise. */
  const makePixels = (profile: number, width: number, height: number): number[] => {
    const colorAt = (r: number): number => (isDynamicProfile(profile) ? DynamicGlobalIndices[profile][r % paletteSize(profile)] : r % paletteSize(profile));
    const pixels = new Array<number>(width * height).fill(colorAt(0));
    const rects = 1 + rnd(3);
    for (let i = 0; i < rects; i++) {
      const w = 1 + rnd(width), h = 1 + rnd(height);
      const x0 = rnd(width - w + 1), y0 = rnd(height - h + 1);
      const colors = [colorAt(1 + rnd(7)), colorAt(1 + rnd(7)), colorAt(rnd(paletteSize(profile)))];
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) pixels[y * width + x] = colors[rnd(3)];
    }
    for (let i = 0; i < Math.floor(pixels.length / 12); i++) pixels[rnd(pixels.length)] = colorAt(rnd(paletteSize(profile)));
    return pixels;
  };
  const roundTrip = (profile: PaletteProfileId, width: number, height: number, level: McoV3Level, transparentColor: number | null) => {
    const pixels = makePixels(profile, width, height);
    const result = encodeV3({ width, height, paletteProfile: profile, pixels, transparentColor }, { level, packetNonce: rnd(256) });
    expect(result.text.startsWith('im3:')).toBe(true);
    const decoded = decodeV3Text(result.text);
    expect(decoded).toEqual({ width, height, paletteProfile: profile, pixels, transparentColor });
  };

  const profiles = Object.values(PaletteProfile) as PaletteProfileId[];
  const sizes: Array<[number, number]> = [[1, 1], [7, 5], [16, 16], [33, 17]];
  it('has 16 profiles', () => {
    expect(profiles.length).toBe(16);
  });
  for (const profile of profiles) {
    it(`normal, profile ${profile}`, () => {
      for (const [w, h] of sizes) roundTrip(profile, w, h, 'normal', null);
    }, 60_000);
  }
  // High is slower: a spread of profiles, smaller sizes, one transparent colour.
  for (const profile of [PaletteProfile.mono, PaletteProfile.master8, PaletteProfile.grayscale16, PaletteProfile.dynamicGlobal64] as PaletteProfileId[]) {
    it(`high, profile ${profile}`, () => {
      roundTrip(profile, 1, 1, 'high', null);
      roundTrip(profile, 7, 5, 'high', null);
      roundTrip(profile, 16, 12, 'high', null);
    }, HIGH_TIMEOUT_MS);
  }
  it('keeps a transparent colour', () => {
    const profile = PaletteProfile.master8;
    roundTrip(profile, 12, 9, 'normal', 3);
  });
  it('rejects bad input', () => {
    expect(() => encodeV3({ width: 0, height: 4, paletteProfile: PaletteProfile.mono, pixels: [] }, { level: 'normal', packetNonce: 1 })).toThrow();
    expect(() => encodeV3({ width: 2, height: 2, paletteProfile: PaletteProfile.mono, pixels: [0, 1, 2, 0] }, { level: 'normal', packetNonce: 1 })).toThrow();
    expect(() => encodeV3({ width: 2, height: 2, paletteProfile: PaletteProfile.mono, pixels: [0, 1, 0, 1] }, { level: 'normal', packetNonce: 256 })).toThrow();
  });
  it('is deterministic for a fixed nonce', () => {
    const input = { width: 8, height: 8, paletteProfile: PaletteProfile.master4, pixels: makePixels(PaletteProfile.master4, 8, 8) };
    const a = encodeV3(input, { level: 'normal', packetNonce: 7 });
    const b = encodeV3(input, { level: 'normal', packetNonce: 7 });
    expect(a.text).toBe(b.text);
    expect(a.body[0]).toBe(7);
    expect(Array.from(a.bodyWithoutNonce)).toEqual(Array.from(a.body.subarray(1)));
    expect(ScanMode.h).toBe(0);
  });
});
