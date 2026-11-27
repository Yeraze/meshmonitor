import type { RgbaImage } from './types.js';

/** Target size for a source: longest side = `longest`, short side rounded, at least 1. */
export function targetDims(srcW: number, srcH: number, longest: number): { w: number; h: number } {
  if (srcW >= srcH) return { w: longest, h: Math.max(1, Math.round((srcH * longest) / srcW)) };
  return { w: Math.max(1, Math.round((srcW * longest) / srcH)), h: longest };
}

interface Taps {
  index: Int32Array;
  weight: Float64Array;
  /** First tap of output i is `start[i]`, last is `start[i + 1] - 1`. */
  start: Int32Array;
}

/** Per-axis taps: box filter when shrinking, nearest sample when growing or equal. */
function buildTaps(srcSize: number, dstSize: number): Taps {
  const index: number[] = [];
  const weight: number[] = [];
  const start = new Int32Array(dstSize + 1);
  const scale = srcSize / dstSize;
  for (let o = 0; o < dstSize; o++) {
    start[o] = index.length;
    if (dstSize >= srcSize) {
      index.push(Math.min(srcSize - 1, Math.floor((o + 0.5) * scale)));
      weight.push(1);
      continue;
    }
    const lo = o * scale;
    const hi = (o + 1) * scale;
    for (let s = Math.floor(lo); s < Math.min(srcSize, Math.ceil(hi)); s++) {
      const w = Math.min(hi, s + 1) - Math.max(lo, s);
      if (w > 1e-9) {
        index.push(s);
        weight.push(w);
      }
    }
  }
  start[dstSize] = index.length;
  return { index: Int32Array.from(index), weight: Float64Array.from(weight), start };
}

/**
 * Area-average (box) downscale with alpha-weighted (premultiplied) averaging, so transparent edges
 * do not darken. A target larger than the source on an axis uses nearest sampling on that axis.
 */
export function resizeArea(src: RgbaImage, w: number, h: number): RgbaImage {
  if (w < 1 || h < 1) throw new RangeError('resizeArea: target must be at least 1x1');
  const tx = buildTaps(src.width, w);
  const ty = buildTaps(src.height, h);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let total = 0;
      for (let j = ty.start[y]; j < ty.start[y + 1]; j++) {
        const row = ty.index[j] * src.width;
        for (let i = tx.start[x]; i < tx.start[x + 1]; i++) {
          const wt = tx.weight[i] * ty.weight[j];
          const o = (row + tx.index[i]) * 4;
          const wa = wt * src.rgba[o + 3];
          r += src.rgba[o] * wa;
          g += src.rgba[o + 1] * wa;
          b += src.rgba[o + 2] * wa;
          a += wa;
          total += wt;
        }
      }
      const p = (y * w + x) * 4;
      if (a > 0) {
        out[p] = Math.round(r / a);
        out[p + 1] = Math.round(g / a);
        out[p + 2] = Math.round(b / a);
      }
      out[p + 3] = Math.round(a / total);
    }
  }
  return { width: w, height: h, rgba: out };
}
