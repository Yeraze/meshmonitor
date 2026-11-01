import { describe, it, expect } from 'vitest';
import {
  isNearBottom,
  DEFAULT_NEAR_BOTTOM_THRESHOLD_PX,
  type ScrollMetrics,
} from './scrollNearBottom';

describe('isNearBottom', () => {
  it('treats a null container as near the bottom (follow by default)', () => {
    expect(isNearBottom(null)).toBe(true);
    expect(isNearBottom(undefined)).toBe(true);
  });

  it('is true when the viewport sits exactly at the bottom', () => {
    // scrollTop + clientHeight === scrollHeight → distance 0
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
  });

  it('is true within the threshold and false beyond it', () => {
    // distance = 1000 - 850 - 100 = 50 < 100
    expect(isNearBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
    // distance = 1000 - 700 - 100 = 200 >= 100
    expect(isNearBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
  });

  it('honours a custom threshold', () => {
    const metrics: ScrollMetrics = { scrollTop: 700, scrollHeight: 1000, clientHeight: 100 };
    // distance 200: beyond the 100px default, within a 250px threshold
    expect(isNearBottom(metrics, DEFAULT_NEAR_BOTTOM_THRESHOLD_PX)).toBe(false);
    expect(isNearBottom(metrics, 250)).toBe(true);
  });

  it('#6124: a tall new row flips a post-commit re-measure to a false negative, '
    + 'but the pre-commit capture still counts as near-bottom', () => {
    // User sits exactly at the bottom. Pre-commit the container is short.
    const preCommit: ScrollMetrics = { scrollTop: 400, scrollHeight: 500, clientHeight: 100 };
    const wasNearBottom = isNearBottom(preCommit);
    expect(wasNearBottom).toBe(true);

    // A tall bubble commits: scrollHeight grows by 300px while scrollTop and
    // clientHeight have not moved yet (the browser has not scrolled). A naive
    // re-measure AFTER the commit now reports distance 300 — not near bottom.
    const postCommit: ScrollMetrics = { scrollTop: 400, scrollHeight: 800, clientHeight: 100 };
    expect(isNearBottom(postCommit)).toBe(false);

    // The captured pre-commit value is what the auto-scroll effect must use, so
    // the stream still follows the new message.
    expect(wasNearBottom).toBe(true);
  });
});
