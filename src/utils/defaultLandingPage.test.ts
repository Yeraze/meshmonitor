/**
 * Tests for the default-landing-page redirect map. Issue #3183 adds the
 * cross-source unified pages to the set of values an admin can pick;
 * regression-guards here ensure the mapping stays accurate and that
 * unknown / source-UUID values keep returning `null` (so the DashboardPage
 * effect falls through to its sourceId lookup path).
 */
import { describe, it, expect } from 'vitest';
import {
  RESERVED_LANDING_VALUES,
  isReservedLandingValue,
  getReservedLandingPath,
} from './defaultLandingPage';

describe('isReservedLandingValue', () => {
  it('accepts every value listed in RESERVED_LANDING_VALUES', () => {
    for (const v of RESERVED_LANDING_VALUES) {
      expect(isReservedLandingValue(v)).toBe(true);
    }
  });

  it('rejects source-id UUIDs', () => {
    expect(isReservedLandingValue('11111111-2222-3333-4444-555555555555')).toBe(false);
  });

  it('rejects unrelated strings and non-strings', () => {
    expect(isReservedLandingValue('dashboard')).toBe(false);
    expect(isReservedLandingValue('')).toBe(false);
    expect(isReservedLandingValue(null)).toBe(false);
    expect(isReservedLandingValue(undefined)).toBe(false);
    expect(isReservedLandingValue(123)).toBe(false);
  });
});

describe('getReservedLandingPath', () => {
  it("returns null for 'unified' (no redirect — already at /)", () => {
    expect(getReservedLandingPath('unified')).toBeNull();
  });

  it('maps unified-messages to /unified/messages', () => {
    expect(getReservedLandingPath('unified-messages')).toBe('/unified/messages');
  });

  it('maps unified-telemetry to /unified/telemetry', () => {
    expect(getReservedLandingPath('unified-telemetry')).toBe('/unified/telemetry');
  });

  it('maps map-analysis to /analysis', () => {
    expect(getReservedLandingPath('map-analysis')).toBe('/analysis');
  });

  it('maps reports to /reports', () => {
    expect(getReservedLandingPath('reports')).toBe('/reports');
  });

  it('returns null for source-id UUIDs (caller falls through to source-lookup path)', () => {
    expect(getReservedLandingPath('11111111-2222-3333-4444-555555555555')).toBeNull();
  });

  it('returns null for empty / null / undefined / unknown strings', () => {
    expect(getReservedLandingPath(null)).toBeNull();
    expect(getReservedLandingPath(undefined)).toBeNull();
    expect(getReservedLandingPath('')).toBeNull();
    expect(getReservedLandingPath('not-a-real-value')).toBeNull();
  });
});
