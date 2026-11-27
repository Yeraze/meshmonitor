import { paletteRgb } from './palettes.js';
import type { McoImageV3 } from './decoder.js';

/**
 * RGBA8888 from decoded palette indexes. Alpha is 0 where the pixel equals the
 * transparent colour, otherwise 255.
 */
export function v3ToRgba(image: McoImageV3): Uint8ClampedArray {
  const { width, height, paletteProfile, pixels, transparentColor } = image;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const px = pixels[i];
    const rgb = paletteRgb(paletteProfile, px);
    if (rgb === undefined) throw new Error(`No RGB entry for pixel value ${px}`);
    const o = i * 4;
    rgba[o] = (rgb >> 16) & 255;
    rgba[o + 1] = (rgb >> 8) & 255;
    rgba[o + 2] = rgb & 255;
    rgba[o + 3] = px === transparentColor ? 0 : 255;
  }
  return rgba;
}
