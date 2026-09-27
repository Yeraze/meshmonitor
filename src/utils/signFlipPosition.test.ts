import { describe, it, expect } from 'vitest';
import {
  detectSignFlip,
  parseSignFlipSettings,
  clampSignFlipRangeKm,
  SIGN_FLIP_DEFAULT_RANGE_KM,
  SIGN_FLIP_RANGE_KM,
  isSignFlipReferenceValid,
} from './signFlipPosition';

const TAMPA = { latitude: 27.95, longitude: -82.46 };
const SYDNEY = { latitude: -33.87, longitude: 151.21 };
const BUENOS_AIRES = { latitude: -34.6, longitude: -58.4 };

describe('detectSignFlip', () => {
  it('corrects a dropped longitude sign (western hemisphere)', () => {
    const r = detectSignFlip(27.9, 82.5, TAMPA, 500);
    expect(r).toEqual({ latitude: 27.9, longitude: -82.5, variant: 'longitude' });
  });

  it('corrects a dropped latitude sign (southern hemisphere)', () => {
    const r = detectSignFlip(33.8, 151.2, SYDNEY, 500);
    expect(r).toEqual({ latitude: -33.8, longitude: 151.2, variant: 'latitude' });
  });

  it('corrects both signs dropped', () => {
    const r = detectSignFlip(34.5, 58.5, BUENOS_AIRES, 500);
    expect(r).toEqual({ latitude: -34.5, longitude: -58.5, variant: 'both' });
  });

  it('leaves a position that is already within range alone', () => {
    expect(detectSignFlip(28.0, -82.0, TAMPA, 500)).toBeNull();
  });

  it('leaves a far position alone when no variant is within range', () => {
    // London: none of its mirrors is near Tampa.
    expect(detectSignFlip(51.5, -0.12, TAMPA, 500)).toBeNull();
  });

  it('skips when two or more variants match (near the equator / prime meridian)', () => {
    // Reference on the equator: (3, 10) and (-3, 10) are both ~330 km away.
    const ref = { latitude: 0, longitude: 10 };
    expect(detectSignFlip(3, -10, ref, 500)).toBeNull();
  });

  it('honours the range boundary', () => {
    // Mirror point is ~55 km from the reference.
    expect(detectSignFlip(27.95, 82.96, TAMPA, 40)).toBeNull();
    expect(detectSignFlip(27.95, 82.96, TAMPA, 60)).not.toBeNull();
  });

  it('skips when the reference is unknown or unusable', () => {
    expect(detectSignFlip(27.9, 82.5, null, 500)).toBeNull();
    expect(detectSignFlip(27.9, 82.5, undefined, 500)).toBeNull();
    expect(detectSignFlip(27.9, 82.5, { latitude: 0, longitude: 0 }, 500)).toBeNull();
    expect(detectSignFlip(27.9, 82.5, { latitude: 120, longitude: 0 }, 500)).toBeNull();
  });

  it('skips missing, out-of-range and Null Island positions', () => {
    expect(detectSignFlip(null, 82.5, TAMPA, 500)).toBeNull();
    expect(detectSignFlip(27.9, undefined, TAMPA, 500)).toBeNull();
    expect(detectSignFlip(NaN, 82.5, TAMPA, 500)).toBeNull();
    expect(detectSignFlip(95, 82.5, TAMPA, 500)).toBeNull();
    expect(detectSignFlip(0, 0, { latitude: 0.5, longitude: 0.5 }, 500)).toBeNull();
  });

  it('skips a precision-obscured Null Island fix', () => {
    // 14-bit precision re-centres (0, 0) to (~0.0131, ~0.0131).
    const offset = Math.pow(2, 31 - 14) * 1e-7;
    // A reference sitting exactly on the (-,-) mirror, with a 1 km range, so
    // only that one variant matches.
    const ref = { latitude: -offset, longitude: -offset };
    // Without precision bits the point looks real and gets "corrected"...
    expect(detectSignFlip(offset, offset, ref, 1)?.variant).toBe('both');
    // ...with them, it is recognised as a re-centred (0, 0) and left alone.
    expect(detectSignFlip(offset, offset, ref, 1, 14)).toBeNull();
  });

  it('rejects a non-positive or non-finite range', () => {
    expect(detectSignFlip(27.9, 82.5, TAMPA, 0)).toBeNull();
    expect(detectSignFlip(27.9, 82.5, TAMPA, -5)).toBeNull();
    expect(detectSignFlip(27.9, 82.5, TAMPA, NaN)).toBeNull();
  });
});

describe('clampSignFlipRangeKm', () => {
  it('defaults junk and clamps to the range', () => {
    expect(clampSignFlipRangeKm(undefined)).toBe(SIGN_FLIP_DEFAULT_RANGE_KM);
    expect(clampSignFlipRangeKm('')).toBe(SIGN_FLIP_DEFAULT_RANGE_KM);
    expect(clampSignFlipRangeKm('abc')).toBe(SIGN_FLIP_DEFAULT_RANGE_KM);
    expect(clampSignFlipRangeKm('1')).toBe(SIGN_FLIP_RANGE_KM.min);
    expect(clampSignFlipRangeKm(99999)).toBe(SIGN_FLIP_RANGE_KM.max);
    expect(clampSignFlipRangeKm('250.4')).toBe(250);
  });
});

describe('parseSignFlipSettings', () => {
  it('is off with defaults when nothing is stored', () => {
    expect(parseSignFlipSettings({})).toEqual({
      enabled: false,
      rangeKm: SIGN_FLIP_DEFAULT_RANGE_KM,
      manualReference: null,
    });
  });

  it('reads enabled as true only for true/1', () => {
    expect(parseSignFlipSettings({ enabled: 'true' }).enabled).toBe(true);
    expect(parseSignFlipSettings({ enabled: '1' }).enabled).toBe(true);
    expect(parseSignFlipSettings({ enabled: 'false' }).enabled).toBe(false);
    expect(parseSignFlipSettings({ enabled: 'yes' }).enabled).toBe(false);
  });

  it('uses a manual reference only when both halves form a usable point', () => {
    expect(parseSignFlipSettings({ referenceLat: '27.9', referenceLon: '-82.4' }).manualReference)
      .toEqual({ latitude: 27.9, longitude: -82.4 });
    expect(parseSignFlipSettings({ referenceLat: '27.9', referenceLon: '' }).manualReference).toBeNull();
    expect(parseSignFlipSettings({ referenceLat: '0', referenceLon: '0' }).manualReference).toBeNull();
    expect(parseSignFlipSettings({ referenceLat: '200', referenceLon: '10' }).manualReference).toBeNull();
  });
});

describe('isSignFlipReferenceValid', () => {
  it('accepts blank or a full valid pair only', () => {
    expect(isSignFlipReferenceValid('', '')).toBe(true);
    expect(isSignFlipReferenceValid('  ', '  ')).toBe(true);
    expect(isSignFlipReferenceValid('27.9', '-82.4')).toBe(true);
    expect(isSignFlipReferenceValid('27.9', '')).toBe(false);
    expect(isSignFlipReferenceValid('', '-82.4')).toBe(false);
    expect(isSignFlipReferenceValid('91', '0')).toBe(false);
    expect(isSignFlipReferenceValid('abc', '1')).toBe(false);
  });
});
