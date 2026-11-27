import { describe, expect, it } from 'vitest';
import { v3ToRgba } from './rgba.js';
import { DYNAMIC_GLOBAL512_RGB } from './palettes.js';
import { PaletteProfile } from './constants.js';
import { decodeV3AppPayload } from './decoder.js';
import decoderFixtures from '../__fixtures__/v3-js-decoder-fixtures.json';

describe('v3ToRgba', () => {
  it('maps mono 2x1 [0,1] to white, black', () => {
    const rgba = v3ToRgba({ width: 2, height: 1, paletteProfile: PaletteProfile.mono, pixels: [0, 1], transparentColor: null });
    expect(Array.from(rgba)).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
  });

  it('uses alpha 0 for the transparent colour', () => {
    const f = decoderFixtures.fixtures.find((x) => x.name === 'transparentSolid');
    expect(f).toBeDefined();
    if (!f) return;
    const image = decodeV3AppPayload(Buffer.from(f.appPayloadBase64, 'base64'));
    expect(image.transparentColor).toBe(3);
    const rgba = v3ToRgba(image);
    expect(rgba.length).toBe(image.width * image.height * 4);
    image.pixels.forEach((px, i) => expect(rgba[i * 4 + 3]).toBe(px === 3 ? 0 : 255));
  });

  it('zeroes alpha only for pixels equal to the transparent colour', () => {
    const rgba = v3ToRgba({ width: 2, height: 1, paletteProfile: PaletteProfile.mono, pixels: [0, 1], transparentColor: 1 });
    expect(Array.from(rgba)).toEqual([255, 255, 255, 255, 0, 0, 0, 0]);
  });

  it('dynamic profiles read DYNAMIC_GLOBAL512_RGB by index', () => {
    const rgba = v3ToRgba({ width: 2, height: 1, paletteProfile: PaletteProfile.dynamicGlobal512, pixels: [5, 300], transparentColor: null });
    const rgb = (px: number): number[] => [(px >> 16) & 255, (px >> 8) & 255, px & 255];
    expect(Array.from(rgba.slice(0, 3))).toEqual(rgb(DYNAMIC_GLOBAL512_RGB[5]));
    expect(Array.from(rgba.slice(4, 7))).toEqual(rgb(DYNAMIC_GLOBAL512_RGB[300]));
  });

  it('throws on a pixel with no RGB entry', () => {
    expect(() => v3ToRgba({ width: 1, height: 1, paletteProfile: PaletteProfile.mono, pixels: [9], transparentColor: null })).toThrow();
  });
});
