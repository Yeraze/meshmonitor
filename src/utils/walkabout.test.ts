import { describe, it, expect } from 'vitest';
import {
  WALKABOUT_MAX_DURATION_MS,
  walkaboutEndsAt,
  isWalkaboutLive,
  walkaboutBucket,
  walkaboutResForZoom,
  WALKABOUT_DEFAULT_SNR_BANDS,
  validateWalkaboutSnrBands,
  parseWalkaboutSnrBands,
  parseWalkaboutSnrBandsText,
  formatWalkaboutSnrBands,
} from './walkabout.js';

describe('walkaboutEndsAt', () => {
  it('is startedAt + cap while open', () => {
    expect(walkaboutEndsAt({ startedAt: 1000, endedAt: null })).toBe(1000 + WALKABOUT_MAX_DURATION_MS);
  });
  it('is endedAt once ended', () => {
    expect(walkaboutEndsAt({ startedAt: 1000, endedAt: 5000 })).toBe(5000);
  });
});

describe('isWalkaboutLive', () => {
  const s = { startedAt: 1000, endedAt: null };
  it('is live before the cap', () => {
    expect(isWalkaboutLive(s, 1000)).toBe(true);
    expect(isWalkaboutLive(s, 1000 + WALKABOUT_MAX_DURATION_MS - 1)).toBe(true);
  });
  it('is not live at or after the cap', () => {
    expect(isWalkaboutLive(s, 1000 + WALKABOUT_MAX_DURATION_MS)).toBe(false);
    expect(isWalkaboutLive(s, 1000 + WALKABOUT_MAX_DURATION_MS + 1)).toBe(false);
  });
  it('is not live once ended, even before the cap', () => {
    expect(isWalkaboutLive({ startedAt: 1000, endedAt: 2000 }, 1500)).toBe(false);
  });
});

describe('walkaboutBucket', () => {
  const b = (bestSnr: number | null, receptionCount = 1) => walkaboutBucket({ bestSnr, receptionCount });
  it('puts a value equal to a bound in the band above', () => {
    expect(b(0)).toBe('strong');
    expect(b(-0.01)).toBe('medium');
    expect(b(-5)).toBe('medium');
    expect(b(-5.01)).toBe('weak');
    expect(b(-10)).toBe('weak');
    expect(b(-10.01)).toBe('none');
  });
  it('maps no receptions to none and receptions without SNR to unknown', () => {
    expect(b(5, 0)).toBe('none');
    expect(b(null, 0)).toBe('none');
    expect(b(null, 3)).toBe('unknown');
  });
});

describe('walkaboutBucket with per-source bands (#6571)', () => {
  const slow = { strong: -10, medium: -15, weak: -20 };
  const b = (bestSnr: number | null, receptionCount = 1) => walkaboutBucket({ bestSnr, receptionCount }, slow);
  it('uses the given edges, a value equal to an edge going up', () => {
    expect(b(-10)).toBe('strong');
    expect(b(-10.5)).toBe('medium');
    expect(b(-15)).toBe('medium');
    expect(b(-18)).toBe('weak');
    expect(b(-20)).toBe('weak');
    expect(b(-20.01)).toBe('none');
  });
  it('still maps no receptions to none and null SNR to unknown', () => {
    expect(b(5, 0)).toBe('none');
    expect(b(null, 2)).toBe('unknown');
  });
});

describe('SNR band setting helpers (#6571)', () => {
  it('defaults to 0 / -5 / -10', () => {
    expect(WALKABOUT_DEFAULT_SNR_BANDS).toEqual({ strong: 0, medium: -5, weak: -10 });
  });
  it('accepts strictly descending edges in range', () => {
    expect(validateWalkaboutSnrBands({ strong: 0, medium: -5, weak: -10 })).toBeNull();
    expect(validateWalkaboutSnrBands({ strong: 20, medium: 0, weak: -30 })).toBeNull();
    expect(validateWalkaboutSnrBands({ strong: -7.5, medium: -12.5, weak: -20 })).toBeNull();
  });
  it('rejects equal or ascending edges', () => {
    expect(validateWalkaboutSnrBands({ strong: 0, medium: 0, weak: -10 })).toBe('not_descending');
    expect(validateWalkaboutSnrBands({ strong: -10, medium: -5, weak: -20 })).toBe('not_descending');
    expect(validateWalkaboutSnrBands({ strong: 0, medium: -5, weak: -5 })).toBe('not_descending');
  });
  it('rejects edges out of range', () => {
    expect(validateWalkaboutSnrBands({ strong: 21, medium: 0, weak: -5 })).toBe('out_of_range');
    expect(validateWalkaboutSnrBands({ strong: 0, medium: -5, weak: -31 })).toBe('out_of_range');
  });
  it('rejects non-numbers', () => {
    expect(validateWalkaboutSnrBands({ strong: NaN, medium: -5, weak: -10 })).toBe('not_number');
    expect(validateWalkaboutSnrBands({ strong: 0, medium: Infinity, weak: -10 })).toBe('not_number');
  });
  it('parses text, needing exactly three values', () => {
    expect(parseWalkaboutSnrBandsText(' -10, -15 ,-20 ')).toEqual({ strong: -10, medium: -15, weak: -20 });
    expect(parseWalkaboutSnrBandsText('0,-5')).toBeNull();
    expect(parseWalkaboutSnrBandsText('0,,-5')).toBeNull();
    expect(parseWalkaboutSnrBandsText('0,-5,-10,-15')).toBeNull();
  });
  it('reads a stored value, falling back to defaults when blank or invalid', () => {
    expect(parseWalkaboutSnrBands('-10,-15,-20')).toEqual({ strong: -10, medium: -15, weak: -20 });
    for (const raw of [undefined, null, '', '  ', 'junk', '0,0,0', '0,-5,-50']) {
      expect(parseWalkaboutSnrBands(raw)).toEqual(WALKABOUT_DEFAULT_SNR_BANDS);
    }
  });
  it('round-trips through format', () => {
    const v = { strong: -2.5, medium: -8, weak: -15 };
    expect(parseWalkaboutSnrBands(formatWalkaboutSnrBands(v))).toEqual(v);
  });
});

describe('walkaboutResForZoom', () => {
  it('switches resolution at zoom 14 and 12', () => {
    expect(walkaboutResForZoom(18)).toBe(9);
    expect(walkaboutResForZoom(14)).toBe(9);
    expect(walkaboutResForZoom(13)).toBe(8);
    expect(walkaboutResForZoom(12)).toBe(8);
    expect(walkaboutResForZoom(11)).toBe(7);
    expect(walkaboutResForZoom(3)).toBe(7);
  });
});
