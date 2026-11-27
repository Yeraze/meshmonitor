import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectMcoImage } from '../detect.js';
import { PaletteProfile, type PaletteProfileId } from '../v3/constants.js';
import { McoImageV4InvalidPayloadError } from './errors.js';
import { decodeV4Body, decodeV4Text } from './decoder.js';
import { im4BodyFromV3Body, im4TextFromV3Body } from './rasterEncoder.js';
import { V4TestDoc } from './testBuilders.js';

interface V3Fixture {
  name: string;
  width: number;
  height: number;
  paletteProfile: keyof typeof PaletteProfile;
  pixels: number[];
  bodyBase64: string;
}
const fixtures = (
  JSON.parse(
    readFileSync(new URL('../__fixtures__/v3-js-encoder-fixtures.json', import.meta.url), 'utf8'),
  ) as { fixtures: V3Fixture[] }
).fixtures;

function innerBody(f: V3Fixture): Uint8Array {
  return Uint8Array.from(Buffer.from(f.bodyBase64, 'base64')).subarray(1);
}

describe('im4TextFromV3Body', () => {
  it.each(fixtures.map((f) => [f.name, f] as const))('%s: document decodes to one raster figure with the input pixels', (_n, f) => {
    const profile = PaletteProfile[f.paletteProfile] as PaletteProfileId;
    const text = im4TextFromV3Body({ width: f.width, height: f.height, profile, v3BodyWithoutNonce: innerBody(f), nonce: 77 });
    expect(detectMcoImage(text)?.format).toBe('im4');
    const { document } = decodeV4Text(text);
    expect(document.width).toBe(f.width);
    expect(document.height).toBe(f.height);
    expect(document.figures).toHaveLength(1);
    const fig = document.figures[0] as unknown as { kind: string; x: number; y: number; pixels: number[] };
    expect(fig.kind).toBe('raster');
    expect([fig.x, fig.y]).toEqual([0, 0]);
    expect(Array.from(fig.pixels)).toEqual(f.pixels);
  });

  it.each([
    ['square64', 16, 16],
    ['small32', 20, 10],
    ['medium64', 40, 30],
    ['extended square', 100, 100],
    ['extended', 120, 60],
    ['largest', 256, 256],
    ['wide', 256, 1 + 11],
  ])('canvas %s %ix%i round-trips', (_n, cw, ch) => {
    const f = fixtures.find((x) => x.width <= 12 && x.height <= 10) as V3Fixture;
    const profile = PaletteProfile[f.paletteProfile] as PaletteProfileId;
    const body = im4BodyFromV3Body({ width: cw, height: ch, profile, v3BodyWithoutNonce: innerBody(f), nonce: 3 });
    const { document } = decodeV4Body(body);
    expect([document.width, document.height]).toEqual([cw, ch]);
    expect(document.mode).toBe('mixed');
    expect(document.figures).toHaveLength(1);
  });

  it.each([16, 32, 64])('matches the V4TestDoc builder on a %i px square canvas', (size) => {
    const f = fixtures[1];
    const profile = PaletteProfile[f.paletteProfile] as PaletteProfileId;
    const inner = innerBody(f);
    const expected = new V4TestDoc({ mixed: true, profile, size }).rasterLayer(0, 0, inner[0] >> 4, inner.subarray(1)).end().body(9);
    const actual = im4BodyFromV3Body({ width: size, height: size, profile, v3BodyWithoutNonce: inner, nonce: 9 });
    expect(Buffer.from(actual).toString('hex')).toBe(Buffer.from(expected).toString('hex'));
  });

  it('rejects bad input', () => {
    const f = fixtures[0];
    const profile = PaletteProfile[f.paletteProfile] as PaletteProfileId;
    const inner = innerBody(f);
    const base = { width: 16, height: 16, profile, v3BodyWithoutNonce: inner, nonce: 1 };
    expect(() => im4TextFromV3Body({ ...base, profile: PaletteProfile.master16 })).toThrow(McoImageV4InvalidPayloadError);
    expect(() => im4TextFromV3Body({ ...base, v3BodyWithoutNonce: inner.subarray(0, 1) })).toThrow(McoImageV4InvalidPayloadError);
    expect(() => im4TextFromV3Body({ ...base, width: 0 })).toThrow(McoImageV4InvalidPayloadError);
    expect(() => im4TextFromV3Body({ ...base, height: 257 })).toThrow(McoImageV4InvalidPayloadError);
    expect(() => im4TextFromV3Body({ ...base, nonce: 256 })).toThrow(McoImageV4InvalidPayloadError);
  });
});

interface DartFx {
  name: string;
  width: number;
  height: number;
  paletteProfile: keyof typeof PaletteProfile;
  compressionLevel: 'normal' | 'high';
  nonce: number;
  pixels: number[];
  v3HeaderHigh: number;
  v3PayloadHex: string;
  text: string;
  jsV3Agrees: boolean;
}
const dartFixtures = (
  JSON.parse(
    readFileSync(new URL('../__fixtures__/v4-raster-encode-fixtures.json', import.meta.url), 'utf8'),
  ) as { entries: DartFx[] }
).entries;

describe('Dart reference documents', () => {
  it('covers every dimension mode', () => {
    const modes = new Set(
      dartFixtures.map((f) =>
        f.width === f.height && f.width <= 64 ? 'square64' : f.width <= 32 && f.height <= 32 ? 'small32' : f.width <= 64 && f.height <= 64 ? 'medium64' : f.width === f.height ? 'extSquare' : 'extended',
      ),
    );
    expect([...modes].sort()).toEqual(['extSquare', 'extended', 'medium64', 'small32', 'square64']);
  });

  it.each(dartFixtures.map((f) => [f.name, f] as const))('%s: wrapper reproduces the Dart text from the Dart inner body', (_n, f) => {
    const profile = PaletteProfile[f.paletteProfile] as PaletteProfileId;
    const inner = Uint8Array.from([(f.v3HeaderHigh << 4) | profile, ...Buffer.from(f.v3PayloadHex, 'hex')]);
    const text = im4TextFromV3Body({ width: f.width, height: f.height, profile, v3BodyWithoutNonce: inner, nonce: f.nonce });
    expect(text).toBe(f.text);
  });
});
