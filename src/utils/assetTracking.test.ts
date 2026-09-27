import { describe, it, expect } from 'vitest';
import {
  ASSET_RETENTION_DAYS_DEFAULT,
  ASSET_RETENTION_DAYS_RANGE,
  parseAssetRetentionDays,
  clampAssetRetentionDays,
  assetRetentionCutoff,
  effectiveIsMobile,
  estimateAssetRows,
} from './assetTracking.js';

describe('assetTracking helpers (#5354)', () => {
  it('has a 90-day default inside a 1..365 range', () => {
    expect(ASSET_RETENTION_DAYS_DEFAULT).toBe(90);
    expect(ASSET_RETENTION_DAYS_RANGE).toEqual({ min: 1, max: 365 });
  });

  describe('parseAssetRetentionDays', () => {
    it.each([[1, 1], [90, 90], [365, 365], ['30', 30], [' 7 ', 7]])('accepts %j', (raw, want) => {
      expect(parseAssetRetentionDays(raw)).toBe(want);
    });
    it.each([[0], [366], [-1], [1.5], ['1.5'], [''], ['abc'], [null], [undefined], [true], [NaN], [{}]])(
      'rejects %j',
      (raw) => {
        expect(parseAssetRetentionDays(raw)).toBeNull();
      },
    );
  });

  describe('clampAssetRetentionDays', () => {
    it('pins into the range and rounds', () => {
      expect(clampAssetRetentionDays(0)).toBe(1);
      expect(clampAssetRetentionDays(1000)).toBe(365);
      expect(clampAssetRetentionDays(10.6)).toBe(11);
      expect(clampAssetRetentionDays('45')).toBe(45);
    });
    it('falls back to the default for junk', () => {
      expect(clampAssetRetentionDays('x')).toBe(90);
      expect(clampAssetRetentionDays(undefined)).toBe(90);
    });
  });

  it('computes a cutoff N days before now', () => {
    const now = 1_800_000_000_000;
    expect(assetRetentionCutoff(10, now)).toBe(now - 10 * 86_400_000);
  });

  describe('effectiveIsMobile', () => {
    it('ORs the heuristic flag with the asset flag', () => {
      expect(effectiveIsMobile(0, undefined)).toBe(false);
      expect(effectiveIsMobile(1, undefined)).toBe(true);
      expect(effectiveIsMobile(true, undefined)).toBe(true);
      expect(effectiveIsMobile(0, { retentionDays: 90 })).toBe(true);
      expect(effectiveIsMobile(null, { retentionDays: 1 })).toBe(true);
    });
  });

  describe('estimateAssetRows', () => {
    it('multiplies the daily rate by the retention', () => {
      expect(estimateAssetRows(100, 90)).toBe(9000);
    });
    it('returns null when there is no recent data', () => {
      expect(estimateAssetRows(0, 90)).toBeNull();
      expect(estimateAssetRows(NaN, 90)).toBeNull();
    });
  });
});
