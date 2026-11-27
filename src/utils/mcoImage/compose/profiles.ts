/**
 * Palette profiles and size ladders offered by the compose pipeline (spec D3/D4).
 * Dynamic profiles are not offered: they reach the same sizes as master8/16.
 */
import { PaletteProfile, type PaletteProfileId } from '../v3/constants.js';
import { paletteSize } from '../v3/palettes.js';

/** Manual-mode palette order. */
export const COMPOSE_PROFILES: readonly PaletteProfileId[] = [
  PaletteProfile.mono,
  PaletteProfile.master4,
  PaletteProfile.master8,
  PaletteProfile.master16,
  PaletteProfile.master32,
  PaletteProfile.master64,
  PaletteProfile.grayscale8,
  PaletteProfile.grayscale16,
  PaletteProfile.grayscale32,
];

/** Auto-fit palette order for a colour source. */
export const COLOR_LADDER: readonly PaletteProfileId[] = [
  PaletteProfile.master64,
  PaletteProfile.master32,
  PaletteProfile.master16,
  PaletteProfile.master8,
  PaletteProfile.master4,
  PaletteProfile.mono,
];

/** Auto-fit palette order for a near-grey source. */
export const GRAY_LADDER: readonly PaletteProfileId[] = [
  PaletteProfile.grayscale32,
  PaletteProfile.grayscale16,
  PaletteProfile.grayscale8,
  PaletteProfile.mono,
];

/** Longest-side ladder (pixels). */
export const SIZE_LADDER: readonly number[] = [8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 80, 96, 128];

/** Number of colours in the profile. */
export function profileColours(profile: PaletteProfileId): number {
  return paletteSize(profile);
}

/** Fit ranking (decision H.2): width x height x log2(colours); mono counts as 1 bit. */
export function score(w: number, h: number, profile: PaletteProfileId): number {
  return w * h * Math.log2(profileColours(profile));
}
