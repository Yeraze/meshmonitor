import { describe, it, expect } from 'vitest';
import { LINK_QUALITY, initialLinkQuality, hopAdjustment, nextLinkQuality, replayLinkQuality } from './linkQuality.js';

describe('linkQuality', () => {
  it('initial quality is 8 - hops clamped to 1..7', () => {
    expect(initialLinkQuality(0)).toBe(7);
    expect(initialLinkQuality(1)).toBe(7);
    expect(initialLinkQuality(3)).toBe(5);
    expect(initialLinkQuality(7)).toBe(1);
    expect(initialLinkQuality(20)).toBe(1);
  });

  it('adjusts +1 when stable or better, 0 for +1 hop, -1 for +2 or more', () => {
    expect(hopAdjustment(3, 3)).toBe(1);
    expect(hopAdjustment(3, 1)).toBe(1);
    expect(hopAdjustment(3, 4)).toBe(0);
    expect(hopAdjustment(3, 5)).toBe(-1);
    expect(LINK_QUALITY.MAX).toBe(10);
  });

  it('first message initialises then applies the stable bonus', () => {
    expect(nextLinkQuality(null, 2)).toEqual({ quality: 7, lastHops: 2 });
  });

  it('clamps to 0..10', () => {
    expect(nextLinkQuality({ quality: 10, lastHops: 1 }, 1).quality).toBe(10);
    expect(nextLinkQuality({ quality: 0, lastHops: 1 }, 5).quality).toBe(0);
  });

  it('replays samples into change points from emitFrom', () => {
    const s = [
      { timestamp: 1, value: 3 }, // init 5 -> 6
      { timestamp: 2, value: 3 }, // 7
      { timestamp: 3, value: 4 }, // +1 hop: 7 (no change)
      { timestamp: 4, value: 7 }, // +3: 6
    ];
    expect(replayLinkQuality(s, 0)).toEqual([
      { timestamp: 1, quality: 5 },
      { timestamp: 1, quality: 6 },
      { timestamp: 2, quality: 7 },
      { timestamp: 4, quality: 6 },
    ]);
    // Warm-up: earlier samples set state but are not emitted; first in-window point always emitted.
    expect(replayLinkQuality(s, 3)).toEqual([
      { timestamp: 3, quality: 7 },
      { timestamp: 4, quality: 6 },
    ]);
  });
});
