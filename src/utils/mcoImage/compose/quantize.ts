import type { PaletteProfileId } from '../v3/constants.js';
import { PALETTE_RGB } from '../v3/palettes.js';
import type { RgbaImage, RgbImage } from './types.js';

/** Composite on white with the demo formula: round(c * a + 255 * (1 - a)), a = alpha / 255. */
export function matteWhite(img: RgbaImage): RgbImage {
  const n = img.width * img.height;
  const rgb = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const a = img.rgba[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) {
      rgb[i * 3 + c] = Math.round(img.rgba[i * 4 + c] * a + 255 * (1 - a));
    }
  }
  return { width: img.width, height: img.height, rgb };
}

function paletteChannels(profile: PaletteProfileId): Int32Array {
  const table = PALETTE_RGB[profile];
  if (!table) throw new RangeError(`quantize: profile ${profile} has no fixed palette`);
  const out = new Int32Array(table.length * 3);
  table.forEach((v, i) => {
    out[i * 3] = (v >> 16) & 255;
    out[i * 3 + 1] = (v >> 8) & 255;
    out[i * 3 + 2] = v & 255;
  });
  return out;
}

/** Nearest palette entry by squared RGB distance; strict `<`, so the first index wins ties. */
function nearest(pal: Int32Array, r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pal.length / 3; i++) {
    const dr = r - pal[i * 3];
    const dg = g - pal[i * 3 + 1];
    const db = b - pal[i * 3 + 2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Map an RGB image to indexes of a fixed profile. `dither` adds Floyd-Steinberg error diffusion
 * (left to right, error clamped per channel to 0..255 before matching); off by default.
 */
export function quantize(img: RgbImage, profile: PaletteProfileId, opts: { dither?: boolean } = {}): Uint16Array {
  const pal = paletteChannels(profile);
  const { width: w, height: h, rgb } = img;
  const out = new Uint16Array(w * h);
  if (!opts.dither) {
    for (let i = 0; i < w * h; i++) out[i] = nearest(pal, rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    return out;
  }
  const err = new Float64Array(w * h * 3);
  const spread = (x: number, y: number, c: number, e: number, k: number): void => {
    if (x < 0 || x >= w || y >= h) return;
    err[(y * w + x) * 3 + c] += e * k;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 3;
      const r = clamp255(rgb[p] + err[p]);
      const g = clamp255(rgb[p + 1] + err[p + 1]);
      const b = clamp255(rgb[p + 2] + err[p + 2]);
      const idx = nearest(pal, r, g, b);
      out[y * w + x] = idx;
      const adj = [r, g, b];
      for (let c = 0; c < 3; c++) {
        const e = adj[c] - pal[idx * 3 + c];
        spread(x + 1, y, c, e, 7 / 16);
        spread(x - 1, y + 1, c, e, 3 / 16);
        spread(x, y + 1, c, e, 5 / 16);
        spread(x + 1, y + 1, c, e, 1 / 16);
      }
    }
  }
  return out;
}

/** True when at least 98% of the opaque pixels have max-min channel <= 12. */
export function isNearGray(img: RgbaImage): boolean {
  let opaque = 0;
  let gray = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.rgba[i * 4 + 3] < 128) continue;
    opaque++;
    const r = img.rgba[i * 4];
    const g = img.rgba[i * 4 + 1];
    const b = img.rgba[i * 4 + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 12) gray++;
  }
  return opaque > 0 && gray >= opaque * 0.98;
}
