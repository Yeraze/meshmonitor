import { describe, expect, it } from 'vitest';
import { detectMcoImage } from '../detect.js';
import { planAutoFit, type AutoFitJob } from './autoFit.js';
import { encodeCandidate } from './encodeCandidate.js';
import { encodeV3 } from './encoderBinding.js';
import { SIZE_LADDER } from './profiles.js';
import type { RgbaImage } from './types.js';

/** Deterministic 160x120 test picture: gradient sky, a disc, a bar and a diagonal. */
function picture(): RgbaImage {
  const width = 160;
  const height = 120;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 40 + Math.round((y / height) * 120);
      let g = 90 + Math.round((x / width) * 100);
      let b = 200 - Math.round((y / height) * 90);
      if ((x - 50) ** 2 + (y - 55) ** 2 < 26 ** 2) [r, g, b] = [230, 190, 40];
      if (y > 90 && x > 70) [r, g, b] = [30, 120, 50];
      if (Math.abs(x - y - 20) < 2) [r, g, b] = [250, 250, 250];
      const o = (y * width + x) * 4;
      rgba.set([r, g, b, 255], o);
    }
  }
  return { width, height, rgba };
}

describe('auto-fit with the real encoder', () => {
  it('finds a Normal winner that fits at limit 158 whose next size does not', () => {
    const src = picture();
    const limit = 158;
    const plan = planAutoFit({ srcLongest: 160, gray: false, limit });
    const normalOnly: AutoFitJob[] = [];
    for (let guard = 0; guard < 200; guard++) {
      const jobs = plan.next();
      if (jobs.length === 0) break;
      for (const j of jobs) {
        if (j.level === 'high') {
          plan.fail(j.jobId); // the refinement is covered by the unit tests
          continue;
        }
        normalOnly.push(j);
        plan.accept(j.jobId, encodeCandidate(src, j.candidate, 'normal', () => 0, { encodeV3 }));
      }
    }
    const w = plan.winners();
    expect(w.im3).toBeDefined();
    expect(w.im3!.bytes).toBeLessThanOrEqual(limit);
    expect(detectMcoImage(w.im3!.text)?.format).toBe('im3');
    expect(w.im4).toBeDefined();
    expect(w.im4!.bytes).toBeLessThanOrEqual(limit);
    expect(detectMcoImage(w.im4!.text)?.format).toBe('im4');
    expect(normalOnly.length).toBeLessThanOrEqual(6 * 6);
    // next ladder step of the same palette does not fit (at Normal)
    const win = w.im3!.result;
    const next = SIZE_LADDER.find((s) => s > Math.max(win.w, win.h));
    if (next !== undefined) {
      const r = encodeCandidate(src, { longest: next, profile: win.profile, dither: false }, 'normal', () => 0, { encodeV3 });
      expect(r.im3Bytes).toBeGreaterThan(limit);
    }
  }, 60_000);
});
