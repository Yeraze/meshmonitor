import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PaletteProfile, type PaletteProfileId } from '../v3/constants.js';
import { encodeV3 } from '../v3/encoder/encode.js';
import { im4TextFromV3Body } from './rasterEncoder.js';

interface DartFx {
  name: string;
  width: number;
  height: number;
  paletteProfile: keyof typeof PaletteProfile;
  compressionLevel: 'normal' | 'high';
  nonce: number;
  pixels: number[];
  text: string;
  jsV3Agrees: boolean;
}
const entries = (
  JSON.parse(readFileSync(new URL('../__fixtures__/v4-raster-encode-fixtures.json', import.meta.url), 'utf8')) as {
    entries: DartFx[];
  }
).entries.filter((f) => f.jsV3Agrees && (f.compressionLevel === 'normal' || f.width * f.height <= 1000)); // High on larger images takes over a minute; the wrapper test covers them

describe('encodeV3 + IM4 wrapper reproduce the Dart text where JS and Dart agree', () => {
  it.each(entries.map((f) => [f.name, f] as const))('%s', (_n, f) => {
    const profile = PaletteProfile[f.paletteProfile] as PaletteProfileId;
    const r = encodeV3(
      { width: f.width, height: f.height, paletteProfile: profile, pixels: f.pixels, transparentColor: null },
      { level: f.compressionLevel, packetNonce: 0 },
    );
    expect(im4TextFromV3Body({ width: f.width, height: f.height, profile, v3BodyWithoutNonce: r.bodyWithoutNonce, nonce: f.nonce })).toBe(f.text);
  }, 60_000);
});
