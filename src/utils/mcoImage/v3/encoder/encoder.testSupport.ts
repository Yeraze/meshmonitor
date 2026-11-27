/**
 * Shared helpers for the encoder fixture tests (see encoder.public.test.ts for the fixture sources).
 */
import { describe, expect, it } from 'vitest';
import { PaletteProfile } from '../constants.js';
import type { PaletteProfileId } from '../constants.js';
import { DynamicGlobalIndices, isDynamicProfile } from '../palettes.js';
import { encodeV3 } from './encode.js';
import type { McoV3EncodeInput, McoV3Level } from './encode.js';
import type { V3Image } from './types.js';

export interface Fixture {
  name: string;
  bodyBase64: string;
  text: string;
  width: number;
  height: number;
  paletteProfile: string;
  pixels: number[];
  transparentColor?: number | null;
  compressionLevel?: string;
  packetNonce?: number;
}

export const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
export const profileId = (name: string): PaletteProfileId => {
  const id = PaletteProfile[name as keyof typeof PaletteProfile];
  expect(id).toBeDefined();
  return id;
};
export const toInput = (f: Fixture): McoV3EncodeInput => ({
  width: f.width,
  height: f.height,
  paletteProfile: profileId(f.paletteProfile),
  pixels: f.pixels,
  transparentColor: f.transparentColor ?? null,
});
export const toImage = (f: Fixture): V3Image => ({
  width: f.width,
  height: f.height,
  paletteProfile: profileId(f.paletteProfile),
  pixels: [...f.pixels],
  transparentColor: f.transparentColor ?? null,
});
/** Colour 0 of the profile (upstream generators call this `val(p, 0)`). */
export const backgroundOf = (profile: number): number => (isDynamicProfile(profile) ? DynamicGlobalIndices[profile][0] : 0);

// High-level encodes are slow; each one gets its own limit instead of a raised global one.
export const HIGH_TIMEOUT_MS = 120_000;
export const timeoutFor = (level: string | undefined): number => (level === 'high' ? HIGH_TIMEOUT_MS : 30_000);

export function publicApiSuite(label: string, fixtures: Fixture[]) {
  describe(label, () => {
    it('is non-empty', () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });
    for (const f of fixtures) {
      it(
        f.name,
        () => {
          const expected = b64(f.bodyBase64);
          const level = (f.compressionLevel ?? 'high') as McoV3Level;
          const result = encodeV3(toInput(f), { level, packetNonce: f.packetNonce ?? expected[0] });
          expect(Buffer.from(result.body).toString('base64')).toBe(f.bodyBase64);
          expect(result.text).toBe(f.text);
          expect(Array.from(result.bodyWithoutNonce)).toEqual(Array.from(expected.subarray(1)));
        },
        timeoutFor(f.compressionLevel),
      );
    }
  });
}

