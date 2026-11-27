import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PaletteProfile } from '../v3/constants.js';
import { PALETTE_RGB } from '../v3/palettes.js';
import { createEncodeHandler } from './workerProtocol.js';
import type { EncodeV3Fn, RgbaImage } from './types.js';

interface Fx {
  width: number;
  height: number;
  paletteProfile: keyof typeof PaletteProfile;
  pixels: number[];
  bodyBase64: string;
}
const f = (
  JSON.parse(readFileSync(new URL('../__fixtures__/v3-js-encoder-fixtures.json', import.meta.url), 'utf8')) as { fixtures: Fx[] }
).fixtures.find((x) => x.paletteProfile === 'master8') as Fx;

const table = PALETTE_RGB[PaletteProfile[f.paletteProfile]];
const rgba = new Uint8ClampedArray(f.width * f.height * 4);
f.pixels.forEach((p, i) => rgba.set([(table[p] >> 16) & 255, (table[p] >> 8) & 255, table[p] & 255, 255], i * 4));
const source: RgbaImage = { width: f.width, height: f.height, rgba };
const fake: EncodeV3Fn = () => {
  const body = Uint8Array.from(Buffer.from(f.bodyBase64, 'base64'));
  return { body, bodyWithoutNonce: body.subarray(1), text: '' };
};
const candidate = { longest: Math.max(f.width, f.height), profile: PaletteProfile.master8, dither: false };

describe('createEncodeHandler', () => {
  it('encodes after setSource and echoes gen, job and level', () => {
    const h = createEncodeHandler({ encodeV3: fake, rng: () => 0 });
    expect(h({ type: 'setSource', source })).toEqual({ type: 'sourceSet' });
    const res = h({ type: 'encode', gen: 4, jobId: 9, candidate, level: 'normal' });
    expect(res.type).toBe('result');
    if (res.type === 'result') {
      expect([res.gen, res.jobId, res.level]).toEqual([4, 9, 'normal']);
      expect(res.result.im3Text.startsWith('im3:')).toBe(true);
    }
  });

  it('answers with an error before a source is set', () => {
    const h = createEncodeHandler({ encodeV3: fake });
    const res = h({ type: 'encode', gen: 1, jobId: 1, candidate, level: 'normal' });
    expect(res.type).toBe('error');
  });

  it('reports encoder failures and self-check mismatches as errors', () => {
    const boom: EncodeV3Fn = () => {
      throw new Error('boom');
    };
    const h = createEncodeHandler({ encodeV3: boom });
    h({ type: 'setSource', source });
    const res = h({ type: 'encode', gen: 1, jobId: 2, candidate, level: 'high' });
    expect(res).toMatchObject({ type: 'error', jobId: 2, message: 'boom' });
    // a body for different pixels fails the self-check
    const other = createEncodeHandler({ encodeV3: fake, rng: () => 0 });
    const flipped: RgbaImage = { ...source, rgba: Uint8ClampedArray.from(source.rgba).fill(255) };
    other({ type: 'setSource', source: flipped });
    const bad = other({ type: 'encode', gen: 1, jobId: 3, candidate, level: 'normal' });
    expect(bad.type).toBe('error');
  });
});
