import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DYNAMIC_GLOBAL512_RGB, DynamicGlobalIndices, PALETTE_RGB, dynamicProfilePalette, globalBits, isDynamicProfile, isGrayscaleProfile, paletteRgb, paletteSize, profileFromId } from './palettes.js';
import { PaletteProfile, PaletteProfileName } from './constants.js';
import { McoImageV3InvalidPayloadError } from './errors.js';

// Expected [length, sha256(JSON.stringify(table))], computed once from the upstream file
// (docs/mcoimg-js/mcoimg-v3-codec.global.js @ c38c1650fe8394835e333b5b4a1ac84ead2d5e5a,
// lines 99-107 and 2541-2552) by evaluating those lines in a vm.
const EXPECTED: Record<string, [number, string]> = {
  dyn9: [8, '52f13107ff7f4ebcc0dfc1e672c414831d2821be9d00c21b0b546c8a77af29f4'],
  dyn10: [16, '348d4eb40aaae4894ff9f5a5e0533ff8e87d62fd198d262623f70e71adaff6d1'],
  dyn11: [32, '27e5a0ce6bc11ff560c9eaaa983b1d3ff4594c5ee4df29b6c294b1c4b0f5fcef'],
  dyn12: [64, 'dde4dfdbbac60a944575fb42ce3ebedfa3548d77aa2958ae23fe3b614541a777'],
  dyn13: [128, '9ad879c96395cfa731a4a194327eb85ad8480efbb4b07f87cc0e166f20fcbb74'],
  dyn14: [256, '08535b008d7654870f89ec14530645923c19bb8fd82a19bdd9c3afcd7b72d7bb'],
  dyn15: [512, '61f3f6fd3aa109e05aa31cc4d74f333d17c8f73ced22284db2209e96a39884af'],
  rgb0: [2, 'c34037c05683b96af899dec98a49bf464039b42deab92c82e8775910d96752ab'],
  rgb1: [4, 'c78fc49ef76bd449c32d59d4c8b411fa132e64148aa46771e73d437b283e6e1f'],
  rgb2: [8, '8f3642179855a9a43319bf17502319474696769c9c6df86bcb6f4ac737c080ef'],
  rgb3: [16, 'dc116576019d459e67b1efdcabc3a5574afe235a8854b6e65863e032aca9d67b'],
  rgb4: [32, 'c24bf6977fa8466b2ced85200f0d98ccccccea25ebaad3ac64edc26a82b50cfa'],
  rgb5: [64, '6af5653bfaad9b24bd321010ff049dd2a3f76dc4495bd8a58c7a4008d2851a4b'],
  rgb6: [16, '81c8f11b9e5b085ffd2269837cbafd30086c8f393e9ebba71eef4f0a4968a362'],
  rgb7: [32, 'cb0ff11f2d66cdcc3cec962ef3849a859cff9badcda6b17abda1b1678b7fde05'],
  rgb8: [8, '95383e308f9a611c1aca6c9168c747c0110991348c78f0b47e7522767adc8607'],
  global512: [512, 'b627400378f3859a80695695fac2d5e0ccdcb290ed51f2e0552500cb99270c00'],
};

const sha = (x: readonly number[]): string => createHash('sha256').update(JSON.stringify(Array.from(x))).digest('hex');

describe('palette tables match upstream byte for byte', () => {
  for (const [k, v] of Object.entries(DynamicGlobalIndices)) {
    it(`dynamic index table ${k}`, () => {
      expect([v.length, sha(v)]).toEqual(EXPECTED[`dyn${k}`]);
    });
  }
  for (const [k, v] of Object.entries(PALETTE_RGB)) {
    it(`fixed RGB table ${k}`, () => {
      expect([v.length, sha(v)]).toEqual(EXPECTED[`rgb${k}`]);
    });
  }
  it('dynamic global 512 RGB table', () => {
    expect([DYNAMIC_GLOBAL512_RGB.length, sha(DYNAMIC_GLOBAL512_RGB)]).toEqual(EXPECTED.global512);
  });
});

describe('palette helpers', () => {
  it('paletteSize / globalBits per profile', () => {
    const sizes = [2, 4, 8, 16, 32, 64, 16, 32, 8, 8, 16, 32, 64, 128, 256, 512];
    PaletteProfileName.forEach((_n, id) => {
      expect(paletteSize(id)).toBe(sizes[id]);
      expect(2 ** globalBits(id)).toBe(sizes[id]);
    });
  });
  it('classifies profiles', () => {
    expect(isDynamicProfile(PaletteProfile.dynamicGlobal8)).toBe(true);
    expect(isDynamicProfile(PaletteProfile.master64)).toBe(false);
    expect(isGrayscaleProfile(PaletteProfile.grayscale16)).toBe(true);
    expect(isGrayscaleProfile(PaletteProfile.mono)).toBe(false);
  });
  it('dynamicProfilePalette copies the index table and rejects fixed profiles', () => {
    expect(dynamicProfilePalette(PaletteProfile.dynamicGlobal8)).toEqual([0, 83, 63, 91, 210, 283, 401, 484]);
    expect(() => dynamicProfilePalette(PaletteProfile.mono)).toThrow(McoImageV3InvalidPayloadError);
  });
  it('profileFromId rejects out-of-range ids', () => {
    expect(() => profileFromId(16)).toThrow('Unknown MCOimg v3 profile 16');
    expect(() => profileFromId(-1)).toThrow(McoImageV3InvalidPayloadError);
  });
  it('paletteRgb', () => {
    expect(paletteRgb(PaletteProfile.mono, 0)).toBe(0xffffff);
    expect(paletteRgb(PaletteProfile.mono, 1)).toBe(0);
    expect(paletteRgb(PaletteProfile.dynamicGlobal512, 0)).toBe(DYNAMIC_GLOBAL512_RGB[0]);
  });
});
