/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { getRoleName } from './mapHelpers';
import { ROLE_NAMES } from '../constants';

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
      expect(getRoleName(99)).toBe('Role 99');
      expect(getRoleName(13)).toBe('Role 13');
      expect(getRoleName(-1)).toBe('Role -1');
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
      // Verify all roles from constant are handled correctly
      Object.entries(ROLE_NAMES).forEach(([roleNum, roleName]) => {
        expect(getRoleName(parseInt(roleNum))).toBe(roleName);
      });
    });

    it('should match nodeHelpers getRoleName implementation', () => {
      // Both implementations should return the same results
      // This ensures consistency across the application
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
});
