import { describe, it, expect } from 'vitest';
import { WALKABOUT_MAX_DURATION_MS, walkaboutEndsAt, isWalkaboutLive } from './walkabout.js';

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
