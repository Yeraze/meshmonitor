import { describe, it, expect } from 'vitest';
import {
  WALKABOUT_MAX_DURATION_MS,
  walkaboutEndsAt,
  isWalkaboutLive,
  walkaboutBucket,
  walkaboutResForZoom,
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
