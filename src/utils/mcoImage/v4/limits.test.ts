import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeMcoImageText } from '../decode.js';
import { base91Encode } from '../base91.js';
import { MCO_V4_DEFAULT_LIMITS } from './constants.js';
import type { McoV4Limits } from './constants.js';
import { decodeV4Body } from './decoder.js';
import { McoImageV4TooLargeError } from './errors.js';
import { V4TestDoc } from './testBuilders.js';

const tooLarge = (body: Uint8Array, limits?: McoV4Limits): McoImageV4TooLargeError => {
  try {
    decodeV4Body(body, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(McoImageV4TooLargeError);
    return error as McoImageV4TooLargeError;
  }
  throw new Error('expected TooLarge');
};

const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
};

/** G_k = GROUP(2) { G_(k-1), REPEAT_LAST }: leaf count doubles per level. */
function doubling(doc: V4TestDoc, k: number): void {
  doc.group(2, () => {
    if (k === 1) doc.dot(10, 10);
    else doubling(doc, k - 1);
    doc.repeatLast();
  });
}

function nested(doc: V4TestDoc, depth: number): void {
  doc.group(1, () => {
    if (depth === 1) doc.dot(10, 10);
    else nested(doc, depth - 1);
  });
}

describe('exponential groups', () => {
  it('stops a figure-count explosion before copying (k = 16)', () => {
    const doc = new V4TestDoc();
    doubling(doc, 16);
    const body = doc.end().body();
    const { ms, value } = timed(() => tooLarge(body));
    expect(value.message).toContain('figures');
    expect(ms).toBeLessThan(50);
  });

  it('stops a 40-level payload at the depth limit quickly', () => {
    const doc = new V4TestDoc();
    doubling(doc, 40);
    const body = doc.end().body();
    const { ms, value } = timed(() => tooLarge(body));
    expect(value.message).toContain('nested too deep');
    expect(ms).toBeLessThan(50);
  });

  it('decodeMcoImageText returns null for it', () => {
    const doc = new V4TestDoc();
    doubling(doc, 16);
    const text = `im4:${base91Encode(doc.end().body())}`;
    expect(decodeMcoImageText(text)).toBeNull();
  });
});

describe('group depth', () => {
  it('accepts depth 16 and rejects 17', () => {
    const ok = new V4TestDoc();
    nested(ok, 16);
    expect(decodeV4Body(ok.end().body()).document.figures).toHaveLength(1);
    const bad = new V4TestDoc();
    nested(bad, 17);
    expect(tooLarge(bad.end().body()).message).toContain('nested too deep');
  });
});

describe('REPEAT_COLOR_RUN', () => {
  it('rejects 2^30 copies before the loop (fast)', () => {
    const doc = new V4TestDoc().dot(5, 5).colorRun(2 ** 30);
    const body = doc.end().body();
    const { ms } = timed(() => tooLarge(body));
    expect(ms).toBeLessThan(50);
  });

  it('accepts a run that lands exactly on the figure cap', () => {
    const doc = new V4TestDoc().dot(5, 5).colorRun(MCO_V4_DEFAULT_LIMITS.maxFigures - 1);
    expect(decodeV4Body(doc.end().body()).document.figures).toHaveLength(MCO_V4_DEFAULT_LIMITS.maxFigures);
  });

  it('rejects a run one past the figure cap', () => {
    const doc = new V4TestDoc().dot(5, 5).colorRun(MCO_V4_DEFAULT_LIMITS.maxFigures);
    expect(tooLarge(doc.end().body()).message).toContain('figures');
  });
});

describe('path points', () => {
  it('accepts a path at the point cap and rejects one over it', () => {
    const cap = MCO_V4_DEFAULT_LIMITS.maxPathPoints;
    const ok = new V4TestDoc().path(cap, 3, 3);
    expect(decodeV4Body(ok.end().body()).document.figures).toHaveLength(1);
    const bad = new V4TestDoc().path(cap + 1, 3, 3);
    expect(tooLarge(bad.end().body()).message).toContain('path points');
  });

  it('counts repeated paths together', () => {
    const doc = new V4TestDoc().path(10000, 3, 3).repeatLast(1, 1);
    expect(tooLarge(doc.end().body()).message).toContain('path points');
  });
});

describe('raster layers', () => {
  // 256 x 256 solid mono layer: header nibble 0, body bytes [251, 15, 1].
  const layer = Uint8Array.of(251, 15, 1);
  const build = (n: number): Uint8Array => {
    const doc = new V4TestDoc({ mixed: true, profile: 0 });
    for (let i = 0; i < n; i++) doc.rasterLayer(0, 0, 0, layer);
    return doc.end().body();
  };
  const raised: McoV4Limits = { ...MCO_V4_DEFAULT_LIMITS, maxRasterPixels: 2 ** 31 };

  it('accepts 4 full layers and rejects the 5th by pixel count', () => {
    expect(decodeV4Body(build(4)).document.figures).toHaveLength(4);
    expect(tooLarge(build(5)).message).toContain('pixels');
  });

  it('accepts 16 layers and rejects 17 by layer count (pixel limit raised)', () => {
    expect(decodeV4Body(build(16), raised).document.figures).toHaveLength(16);
    expect(tooLarge(build(17), raised).message).toContain('raster layers');
  });
});

describe('text code points', () => {
  const entries = (
    JSON.parse(
      readFileSync(new URL('../__fixtures__/mcotxt-reference-fixtures.json', import.meta.url), 'utf8'),
    ) as { entries: Array<{ dataHex: string; bitLength: number; text: string | null }> }
  ).entries;
  const sample = entries.find((e) => e.text !== null && [...e.text].length >= 20 && [...e.text].length <= 60);
  const hex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

  it('has a usable sample', () => {
    expect(sample).toBeDefined();
  });

  it('accepts copies up to the cap and rejects the next one', () => {
    if (!sample || sample.text === null) throw new Error('no sample');
    const length = [...sample.text].length;
    const fit = Math.floor(MCO_V4_DEFAULT_LIMITS.maxTextCodePoints / length);
    const build = (copies: number): Uint8Array => {
      const doc = new V4TestDoc().text(2, 2, hex(sample.dataHex), sample.bitLength);
      for (let i = 1; i < copies; i++) doc.repeatLast(0, 0);
      return doc.end().body();
    };
    expect(decodeV4Body(build(fit)).document.figures).toHaveLength(fit);
    expect(tooLarge(build(fit + 1)).message).toContain('text');
  });
});
