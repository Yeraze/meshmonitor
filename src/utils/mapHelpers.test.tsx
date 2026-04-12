/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { getRoleName } from './nodeHelpers';
import { ROLE_NAMES } from '../constants/index.js';
import { convertSpeed } from './speedConversion';

describe('mapHelpers', () => {
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
    it('should convert m/s to km/h for metric units', () => {
      // 10 m/s = 36 km/h
      const result = convertSpeed(10, 'km');
      expect(result.speed).toBe(36);
      expect(result.unit).toBe('km/h');
    });

    it('should convert m/s to mph for imperial units', () => {
      // 10 m/s = 36 km/h = 22.4 mph
      const result = convertSpeed(10, 'mi');
      expect(result.speed).toBeCloseTo(22.4, 1);
      expect(result.unit).toBe('mph');
    });

    it('should handle zero speed', () => {
      const result = convertSpeed(0, 'km');
      expect(result.speed).toBe(0);
      expect(result.unit).toBe('km/h');
    });

    it('should handle high speeds without misinterpretation (regression)', () => {
      // 80 m/s = 288 km/h — this is a valid high speed (e.g. vehicle on highway)
      // Previously a heuristic would reinterpret speeds > 200 km/h as already in km/h
      const result = convertSpeed(80, 'km');
      expect(result.speed).toBe(288);
      expect(result.unit).toBe('km/h');
    });

    it('should handle typical walking speed', () => {
      // 1.4 m/s ≈ 5.0 km/h (walking)
      const result = convertSpeed(1.4, 'km');
      expect(result.speed).toBeCloseTo(5.0, 1);
    });

    it('should handle typical driving speed', () => {
      // 27.8 m/s ≈ 100 km/h
      const result = convertSpeed(27.8, 'km');
      expect(result.speed).toBeCloseTo(100.1, 1);
    });

    it('should produce consistent results between metric and imperial', () => {
      const metric = convertSpeed(10, 'km');
      const imperial = convertSpeed(10, 'mi');
      // mph = km/h * 0.621371
      expect(imperial.speed).toBeCloseTo(metric.speed * 0.621371, 0);
    });
  });
});
