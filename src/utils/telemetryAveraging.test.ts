import { describe, it, expect } from 'vitest';
import { computeAveragingIntervalMinutes, TELEMETRY_TARGET_BUCKETS } from './telemetryAveraging';

describe('computeAveragingIntervalMinutes', () => {
  it('falls back to 3-minute buckets when the window is unknown or invalid', () => {
    expect(computeAveragingIntervalMinutes(undefined)).toBe(3);
    expect(computeAveragingIntervalMinutes(0)).toBe(3);
    expect(computeAveragingIntervalMinutes(-5)).toBe(3);
    expect(computeAveragingIntervalMinutes(NaN)).toBe(3);
  });

  it('keeps near-full resolution (1-minute buckets) for short windows', () => {
    expect(computeAveragingIntervalMinutes(0.25)).toBe(1); // 15 minutes
    expect(computeAveragingIntervalMinutes(1)).toBe(1);
    expect(computeAveragingIntervalMinutes(3)).toBe(1);
  });

  it('widens the bucket as the window grows so the point count stays bounded', () => {
    expect(computeAveragingIntervalMinutes(6)).toBe(2);
    expect(computeAveragingIntervalMinutes(12)).toBe(3);
    expect(computeAveragingIntervalMinutes(24)).toBe(6);
    expect(computeAveragingIntervalMinutes(48)).toBe(12);
    expect(computeAveragingIntervalMinutes(72)).toBe(18);
    expect(computeAveragingIntervalMinutes(168)).toBe(42); // 7 days (retention)
  });

  it('never exceeds the target bucket count for any window up to retention', () => {
    for (const hours of [0.25, 1, 3, 6, 12, 24, 48, 72, 168]) {
      const interval = computeAveragingIntervalMinutes(hours);
      const buckets = (hours * 60) / interval;
      // Allow a small margin from rounding the interval to whole minutes.
      expect(buckets).toBeLessThanOrEqual(TELEMETRY_TARGET_BUCKETS * 1.25);
    }
  });
});
