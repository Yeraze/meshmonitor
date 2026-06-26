/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { getRoleName } from './nodeHelpers';
import { ROLE_NAMES } from '../constants/index.js';
import { convertSpeed } from './speedConversion';
import {
  isUnknownSnr,
  UNKNOWN_SNR_SENTINEL,
  interpolateColor,
  getPositionHistoryColor,
  getSegmentSnrColor,
  getSegmentSnrOpacity,
  getLineWeight,
  getTemporalOpacityMultiplier,
  generateCurvedPath,
  generateHeadingAwarePath,
  generatePositionHistoryArrows,
} from './mapHelpers';

describe('mapHelpers', () => {
  describe('isUnknownSnr (issue #2859)', () => {
    it('returns true for the firmware INT8_MIN sentinel (-32 after /4 scaling)', () => {
      expect(isUnknownSnr(UNKNOWN_SNR_SENTINEL)).toBe(true);
      expect(isUnknownSnr(-32)).toBe(true);
    });

    it('returns false for SNR=0 (protobuf default — was a false positive in 4.1.0)', () => {
      // Regression: PR #2302 treated 0 as MQTT, but 0 is just the protobuf default
      // and appears for any unpopulated SNR slot, not only MQTT-bridged hops.
      expect(isUnknownSnr(0)).toBe(false);
    });

    it('returns false for typical RF SNR values', () => {
      expect(isUnknownSnr(5)).toBe(false);
      expect(isUnknownSnr(-5)).toBe(false);
      expect(isUnknownSnr(-15)).toBe(false);
      expect(isUnknownSnr(10)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isUnknownSnr(undefined)).toBe(false);
    });
  });

  describe('interpolateColor', () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    const red = { r: 255, g: 0, b: 0 };

    it('returns colorA at ratio 0', () => {
      expect(interpolateColor(black, white, 0)).toBe('#000000');
    });

    it('returns colorB at ratio 1', () => {
      expect(interpolateColor(black, white, 1)).toBe('#ffffff');
    });

    it('interpolates the midpoint', () => {
      expect(interpolateColor(black, white, 0.5)).toBe('#808080');
    });

    it('produces zero-padded hex for low channel values', () => {
      const result = interpolateColor(black, red, 0.05);
      expect(result).toMatch(/^#[0-9a-f]{6}$/);
    });
  });

  describe('getPositionHistoryColor', () => {
    it('returns the new color for the only segment when total is 1', () => {
      const result = getPositionHistoryColor(0, 1);
      expect(result).toMatch(/^#[0-9a-f]{6}$/);
    });

    it('returns oldest color for index 0 of multi-segment path', () => {
      const result = getPositionHistoryColor(0, 5);
      // Default oldest is cyan-blue (0, 191, 255)
      expect(result.toLowerCase()).toBe('#00bfff');
    });

    it('returns newest color for last index', () => {
      const result = getPositionHistoryColor(4, 5);
      // Default newest is orange-red (255, 69, 0)
      expect(result.toLowerCase()).toBe('#ff4500');
    });

    it('honors override colorOld and colorNew', () => {
      const oldC = { r: 0, g: 0, b: 0 };
      const newC = { r: 255, g: 255, b: 255 };
      expect(getPositionHistoryColor(0, 3, oldC, newC).toLowerCase()).toBe('#000000');
      expect(getPositionHistoryColor(2, 3, oldC, newC).toLowerCase()).toBe('#ffffff');
    });
  });

  describe('getSegmentSnrColor', () => {
    const colors = { good: 'green', medium: 'yellow', poor: 'red' };

    it('returns default when no SNR data', () => {
      expect(getSegmentSnrColor(undefined, colors, 'gray')).toBe('gray');
      expect(getSegmentSnrColor([], colors, 'gray')).toBe('gray');
    });

    it('ignores unknown-SNR values when computing average', () => {
      // All entries are unknown-sentinel; should fall back to default
      expect(
        getSegmentSnrColor([{ snr: UNKNOWN_SNR_SENTINEL }], colors, 'gray')
      ).toBe('gray');
    });

    it('returns good color for positive average SNR', () => {
      expect(getSegmentSnrColor([{ snr: 5 }, { snr: 3 }], colors, 'gray')).toBe('green');
    });

    it('returns medium color for slightly negative SNR', () => {
      expect(getSegmentSnrColor([{ snr: -5 }], colors, 'gray')).toBe('yellow');
    });

    it('returns poor color for very negative SNR', () => {
      expect(getSegmentSnrColor([{ snr: -15 }, { snr: -18 }], colors, 'gray')).toBe('red');
    });
  });

  describe('getSegmentSnrOpacity', () => {
    it('returns 0.5 for explicit isMqtt=true', () => {
      expect(getSegmentSnrOpacity(undefined, true)).toBe(0.5);
    });

    it('returns 0.5 for missing SNR data', () => {
      expect(getSegmentSnrOpacity(undefined, false)).toBe(0.5);
      expect(getSegmentSnrOpacity([], false)).toBe(0.5);
    });

    it('returns 0.5 when only unknown-SNR sentinels present', () => {
      expect(getSegmentSnrOpacity([{ snr: UNKNOWN_SNR_SENTINEL }], false)).toBe(0.5);
    });

    it('scales opacity within [0.4, 0.85] for valid SNR', () => {
      const opLow = getSegmentSnrOpacity([{ snr: -20 }], false);
      const opHigh = getSegmentSnrOpacity([{ snr: 15 }], false);
      expect(opLow).toBeCloseTo(0.4, 5);
      expect(opHigh).toBeCloseTo(0.85, 5);
    });

    it('clamps very-out-of-range SNR values', () => {
      const opVeryLow = getSegmentSnrOpacity([{ snr: -100 }], false);
      const opVeryHigh = getSegmentSnrOpacity([{ snr: 100 }], false);
      expect(opVeryLow).toBeCloseTo(0.4, 5);
      expect(opVeryHigh).toBeCloseTo(0.85, 5);
    });
  });

  describe('getLineWeight', () => {
    it('returns default weight when SNR is undefined', () => {
      expect(getLineWeight(undefined)).toBe(3);
    });

    it('maps -20 dB to weight 2', () => {
      expect(getLineWeight(-20)).toBeCloseTo(2, 5);
    });

    it('maps +10 dB to weight 6', () => {
      expect(getLineWeight(10)).toBeCloseTo(6, 5);
    });

    it('clamps SNR below -20 to weight 2', () => {
      expect(getLineWeight(-100)).toBeCloseTo(2, 5);
    });

    it('clamps SNR above +10 to weight 6', () => {
      expect(getLineWeight(50)).toBeCloseTo(6, 5);
    });
  });

  describe('getTemporalOpacityMultiplier', () => {
    it('returns 0.5 for undefined timestamp', () => {
      expect(getTemporalOpacityMultiplier(undefined)).toBe(0.5);
    });

    it('returns 1.0 for fresh (<1h old) timestamps', () => {
      const now = Date.now();
      expect(getTemporalOpacityMultiplier(now)).toBe(1.0);
      expect(getTemporalOpacityMultiplier(now - 30 * 60 * 1000)).toBe(1.0);
    });

    it('returns 0.2 for very old (>24h) timestamps', () => {
      const now = Date.now();
      expect(getTemporalOpacityMultiplier(now - 48 * 60 * 60 * 1000)).toBe(0.2);
    });

    it('decays smoothly between 1h and 24h', () => {
      const now = Date.now();
      const at12h = getTemporalOpacityMultiplier(now - 12 * 60 * 60 * 1000);
      expect(at12h).toBeGreaterThan(0.2);
      expect(at12h).toBeLessThan(1.0);
    });
  });

  describe('generateCurvedPath', () => {
    it('returns [start, end] when start equals end', () => {
      const result = generateCurvedPath([10, 20], [10, 20]);
      expect(result).toEqual([[10, 20], [10, 20]]);
    });

    it('produces (segments + 1) points', () => {
      const result = generateCurvedPath([0, 0], [10, 10], 0.15, 8);
      expect(result.length).toBe(9);
    });

    it('includes start and end as first and last points', () => {
      const result = generateCurvedPath([0, 0], [10, 10], 0.15, 4);
      expect(result[0]).toEqual([0, 0]);
      expect(result[result.length - 1][0]).toBeCloseTo(10);
      expect(result[result.length - 1][1]).toBeCloseTo(10);
    });

    it('exercises the normalizeDirection branch without throwing', () => {
      // Forward and back paths use the canonical-direction curvature flip,
      // ensuring forward A→B and back B→A curve on opposite sides
      const fwd = generateCurvedPath([0, 0], [10, 10], 0.15, 4, true);
      const back = generateCurvedPath([10, 10], [0, 0], 0.15, 4, true);
      expect(fwd.length).toBe(5);
      expect(back.length).toBe(5);
    });
  });

  describe('generateHeadingAwarePath', () => {
    it('returns [start, end] straight line when heading is undefined', () => {
      const result = generateHeadingAwarePath([10, 20], [11, 21]);
      expect(result).toEqual([[10, 20], [11, 21]]);
    });

    it('returns [start, end] when start equals end', () => {
      const result = generateHeadingAwarePath([10, 20], [10, 20], 90);
      expect(result).toEqual([[10, 20], [10, 20]]);
    });

    it('handles millidegree heading values', () => {
      // heading > 360 should be interpreted as millidegrees
      const result = generateHeadingAwarePath([0, 0], [1, 1], 90000, 5);
      expect(result.length).toBe(11);
      expect(result[0]).toEqual([0, 0]);
    });

    it('produces (segments + 1) points with valid heading', () => {
      const result = generateHeadingAwarePath([0, 0], [5, 5], 45, 10, 6);
      expect(result.length).toBe(7);
    });

    it('respects speed parameter for control point distance', () => {
      const slow = generateHeadingAwarePath([0, 0], [5, 5], 45, 1, 4);
      const fast = generateHeadingAwarePath([0, 0], [5, 5], 45, 30, 4);
      // Fast and slow should produce different intermediate curves
      expect(slow[2][0]).not.toEqual(fast[2][0]);
    });
  });

  describe('getRoleName', () => {
    it('should return correct role names for all valid roles', () => {
      expect(getRoleName(0)).toBe('Client');
      expect(getRoleName(1)).toBe('Client Mute');
      expect(getRoleName(2)).toBe('Router');
      expect(getRoleName(3)).toBe('Router Client');
      expect(getRoleName(4)).toBe('Repeater');
      expect(getRoleName(5)).toBe('Tracker');
      expect(getRoleName(6)).toBe('Sensor');
      expect(getRoleName(7)).toBe('TAK');
      expect(getRoleName(8)).toBe('Client Hidden');
      expect(getRoleName(9)).toBe('Lost and Found');
      expect(getRoleName(10)).toBe('TAK Tracker');
      expect(getRoleName(11)).toBe('Router Late');
      expect(getRoleName(12)).toBe('Client Base');
    });

    it('should handle string role numbers', () => {
      expect(getRoleName('0')).toBe('Client');
      expect(getRoleName('2')).toBe('Router');
      expect(getRoleName('11')).toBe('Router Late');
      expect(getRoleName('12')).toBe('Client Base');
    });

    it('should return fallback for unknown roles', () => {
      expect(getRoleName(99)).toBe('Unknown (99)');
      expect(getRoleName(13)).toBe('Unknown (13)');
      expect(getRoleName(-1)).toBe('Unknown (-1)');
    });

    it('should return null for undefined or null input', () => {
      expect(getRoleName(undefined)).toBeNull();
      expect(getRoleName(null as any)).toBeNull();
    });

    it('should return null for invalid string input', () => {
      expect(getRoleName('invalid')).toBeNull();
      expect(getRoleName('abc')).toBeNull();
    });

    it('should use ROLE_NAMES constant consistently', () => {
      Object.entries(ROLE_NAMES).forEach(([roleNum, roleName]) => {
        expect(getRoleName(parseInt(roleNum))).toBe(roleName);
      });
    });

    it('should match nodeHelpers getRoleName implementation', () => {
      for (let i = 0; i <= 12; i++) {
        expect(getRoleName(i)).toBe(ROLE_NAMES[i]);
      }
    });

    it('should handle edge cases', () => {
      expect(getRoleName(0)).not.toContain('Role 0');
      expect(getRoleName(12)).not.toContain('Role 12');
      expect(getRoleName(12)).toBe('Client Base');
    });
  });

  describe('convertSpeed', () => {
    // ground_speed is already km/h on the wire (firmware writes TinyGPS++
    // .kmph()), so metric is a pass-through and imperial applies only the
    // km/h→mph factor. See #3797 — we previously multiplied by 3.6 as if m/s.
    it('passes km/h through unchanged for metric units', () => {
      const result = convertSpeed(36, 'km');
      expect(result.speed).toBe(36);
      expect(result.unit).toBe('km/h');
    });

    it('converts km/h to mph for imperial units', () => {
      // 100 km/h = 62.1 mph
      const result = convertSpeed(100, 'mi');
      expect(result.speed).toBeCloseTo(62.1, 1);
      expect(result.unit).toBe('mph');
    });

    it('should handle zero speed', () => {
      const result = convertSpeed(0, 'km');
      expect(result.speed).toBe(0);
      expect(result.unit).toBe('km/h');
    });

    it('does not inflate the wire value (regression #3797)', () => {
      // A wire ground_speed of 90 means 90 km/h, NOT 324 km/h (90 × 3.6) and
      // NOT 0.9 m/s — it must display as the same number for metric.
      const result = convertSpeed(90, 'km');
      expect(result.speed).toBe(90);
      expect(result.unit).toBe('km/h');
    });

    it('should handle a valid high speed (e.g. vehicle on highway)', () => {
      const result = convertSpeed(120, 'km');
      expect(result.speed).toBe(120);
      expect(result.unit).toBe('km/h');
    });

    it('should handle typical walking speed', () => {
      // ~5 km/h walking pace passes through.
      const result = convertSpeed(5, 'km');
      expect(result.speed).toBeCloseTo(5.0, 1);
    });

    it('should produce consistent results between metric and imperial', () => {
      const metric = convertSpeed(100, 'km');
      const imperial = convertSpeed(100, 'mi');
      // mph = km/h * 0.621371
      expect(imperial.speed).toBeCloseTo(metric.speed * 0.621371, 0);
    });
  });

  describe('generatePositionHistoryArrows (#3492)', () => {
    const keyOf = (el: any): string => String(el.key ?? '');
    const dots = (els: any[]) => els.filter((e) => keyOf(e).startsWith('position-history-point-'));
    const triangles = (els: any[]) => els.filter((e) => keyOf(e).startsWith('position-history-arrow-'));

    it('renders a dot at EVERY fix, including fixes with no heading (the missing-marker bug)', () => {
      const items = [
        { latitude: 1, longitude: 1, timestamp: 1000 },              // no heading
        { latitude: 2, longitude: 2, timestamp: 2000 },              // no heading
        { latitude: 3, longitude: 3, timestamp: 3000, groundTrack: 90 }, // heading
      ] as any[];

      const els = generatePositionHistoryArrows(items, [], 30, 'km');

      // A dot for every fix — previously no-heading fixes rendered nothing.
      expect(dots(els)).toHaveLength(3);
      // Heading triangle only on the fix that actually carried groundTrack.
      expect(triangles(els)).toHaveLength(1);
    });

    it('renders dots even when no fix has heading data', () => {
      const items = [
        { latitude: 1, longitude: 1, timestamp: 1000 },
        { latitude: 2, longitude: 2, timestamp: 2000 },
      ] as any[];
      const els = generatePositionHistoryArrows(items, [], 30, 'km');
      expect(dots(els)).toHaveLength(2);
      expect(triangles(els)).toHaveLength(0);
    });

    it('renders a dot at EVERY fix without subsampling (#3791)', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({ latitude: i, longitude: i, timestamp: i })) as any[];
      const els = generatePositionHistoryArrows(items, [], 10, 'km');
      // Points are no longer capped — one dot per reported position.
      expect(dots(els)).toHaveLength(100);
    });

    it('subsamples heading triangles to at most maxArrows while keeping all dots (#3791)', () => {
      const items = Array.from(
        { length: 100 },
        (_, i) => ({ latitude: i, longitude: i, timestamp: i, groundTrack: 90 })
      ) as any[];
      const els = generatePositionHistoryArrows(items, [], 10, 'km');
      // A dot at every fix...
      expect(dots(els)).toHaveLength(100);
      // ...but heading triangles stay capped to avoid clutter on dense trails.
      expect(triangles(els).length).toBeLessThanOrEqual(10);
    });

    it('returns nothing for an empty history', () => {
      expect(generatePositionHistoryArrows([], [], 30, 'km')).toHaveLength(0);
    });
  });
});
