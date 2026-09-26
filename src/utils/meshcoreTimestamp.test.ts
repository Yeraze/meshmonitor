import { describe, it, expect } from 'vitest';
import {
  isPlausibleMeshCoreTimeMs,
  isFutureDriftedMeshCoreTimeMs,
  plausibleMeshCoreTimeMs,
  plausibleMeshCoreTimeMsOrUndefined,
} from './meshcoreTimestamp.js';

const NOW = 1_800_000_000_000; // ms, arbitrary fixed reference point

describe('isPlausibleMeshCoreTimeMs', () => {
  it('accepts a value comfortably within bounds', () => {
    expect(isPlausibleMeshCoreTimeMs(NOW - 60_000, NOW)).toBe(true);
  });

  it('rejects a value below the 2020-01-01 floor', () => {
    expect(isPlausibleMeshCoreTimeMs(946_684_800_000, NOW)).toBe(false); // 2000-01-01
  });

  it('rejects a value far in the future', () => {
    expect(isPlausibleMeshCoreTimeMs(3_700_000_000_000, NOW)).toBe(false); // ~2087
  });

  it('accepts a value within the 1-day future-skew allowance', () => {
    expect(isPlausibleMeshCoreTimeMs(NOW + 3_600_000, NOW)).toBe(true); // 1h ahead
  });

  it('rejects a value just past the future-skew allowance', () => {
    expect(isPlausibleMeshCoreTimeMs(NOW + 25 * 3_600_000, NOW)).toBe(false); // 25h ahead
  });

  it('rejects non-finite values', () => {
    expect(isPlausibleMeshCoreTimeMs(NaN, NOW)).toBe(false);
    expect(isPlausibleMeshCoreTimeMs(Infinity, NOW)).toBe(false);
  });
});

describe('isFutureDriftedMeshCoreTimeMs', () => {
  it('flags only values past the future-skew allowance', () => {
    expect(isFutureDriftedMeshCoreTimeMs(3_700_000_000_000, NOW)).toBe(true); // ~2087
    expect(isFutureDriftedMeshCoreTimeMs(NOW + 3_600_000, NOW)).toBe(false); // 1h ahead
    expect(isFutureDriftedMeshCoreTimeMs(946_684_800_000, NOW)).toBe(false); // too old is not "future"
    expect(isFutureDriftedMeshCoreTimeMs(NaN, NOW)).toBe(false);
  });
});

describe('plausibleMeshCoreTimeMsOrUndefined', () => {
  it('passes a plausible ms value through', () => {
    expect(plausibleMeshCoreTimeMsOrUndefined(NOW - 60_000, NOW)).toBe(NOW - 60_000);
  });

  it('returns undefined for missing or implausible values', () => {
    expect(plausibleMeshCoreTimeMsOrUndefined(undefined, NOW)).toBeUndefined();
    expect(plausibleMeshCoreTimeMsOrUndefined(null, NOW)).toBeUndefined();
    expect(plausibleMeshCoreTimeMsOrUndefined(946_684_800_000, NOW)).toBeUndefined(); // 2000
    expect(plausibleMeshCoreTimeMsOrUndefined(3_700_000_000_000, NOW)).toBeUndefined(); // ~2087
  });
});

describe('plausibleMeshCoreTimeMs', () => {
  it('converts a plausible epoch-seconds value to ms', () => {
    const sec = Math.floor(NOW / 1000) - 60;
    expect(plausibleMeshCoreTimeMs(sec, NOW)).toBe(sec * 1000);
  });

  it('falls back to nowMs for a value below the floor', () => {
    expect(plausibleMeshCoreTimeMs(946_684_800, NOW)).toBe(NOW); // 2000-01-01
  });

  it('falls back to nowMs for a value far in the future', () => {
    expect(plausibleMeshCoreTimeMs(3_700_000_000, NOW)).toBe(NOW); // ~2087
  });

  it('falls back to nowMs when missing, zero, or negative', () => {
    expect(plausibleMeshCoreTimeMs(undefined, NOW)).toBe(NOW);
    expect(plausibleMeshCoreTimeMs(null, NOW)).toBe(NOW);
    expect(plausibleMeshCoreTimeMs(0, NOW)).toBe(NOW);
    expect(plausibleMeshCoreTimeMs(-5, NOW)).toBe(NOW);
  });

  it('defaults nowMs to Date.now() when omitted', () => {
    const before = Date.now();
    const result = plausibleMeshCoreTimeMs(undefined);
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });
});
