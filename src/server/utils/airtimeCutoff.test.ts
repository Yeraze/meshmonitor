import { describe, it, expect } from 'vitest';
import { shouldGateAutomations, DEFAULT_AIRTIME_CUTOFF_THRESHOLD } from './airtimeCutoff.js';

describe('shouldGateAutomations', () => {
  it('gates when utilization exceeds the threshold', () => {
    expect(shouldGateAutomations(45, 30)).toBe(true);
  });

  it('does not gate when utilization is below the threshold', () => {
    expect(shouldGateAutomations(10, 30)).toBe(false);
  });

  it('does not gate when utilization exactly equals the threshold', () => {
    // Strictly greater-than: at the threshold we still run.
    expect(shouldGateAutomations(30, 30)).toBe(false);
  });

  it('uses the default threshold value of 30', () => {
    expect(DEFAULT_AIRTIME_CUTOFF_THRESHOLD).toBe(30);
    expect(shouldGateAutomations(31, DEFAULT_AIRTIME_CUTOFF_THRESHOLD)).toBe(true);
    expect(shouldGateAutomations(29, DEFAULT_AIRTIME_CUTOFF_THRESHOLD)).toBe(false);
  });

  it('never gates when the threshold is 0 (feature disabled)', () => {
    expect(shouldGateAutomations(99, 0)).toBe(false);
  });

  it('never gates when the threshold is negative', () => {
    expect(shouldGateAutomations(99, -5)).toBe(false);
  });

  it('never gates when utilization is unknown (null/undefined)', () => {
    expect(shouldGateAutomations(null, 30)).toBe(false);
    expect(shouldGateAutomations(undefined, 30)).toBe(false);
  });

  it('does not gate on NaN inputs', () => {
    expect(shouldGateAutomations(NaN, 30)).toBe(false);
    expect(shouldGateAutomations(50, NaN)).toBe(false);
  });
});
