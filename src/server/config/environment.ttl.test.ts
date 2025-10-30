/**
 * Push Notification TTL Environment Configuration Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetEnvironmentConfig, getEnvironmentConfig } from './environment.js';

describe('Push Notification TTL Configuration', () => {
  const originalEnv = process.env.PUSH_NOTIFICATION_TTL;

  afterEach(() => {
    // Restore original environment
    if (originalEnv !== undefined) {
      process.env.PUSH_NOTIFICATION_TTL = originalEnv;
    } else {
      delete process.env.PUSH_NOTIFICATION_TTL;
    }
    resetEnvironmentConfig();
  });

  describe('Default TTL Value', () => {
    it('should default to 3600 seconds (1 hour) when not configured', () => {
      delete process.env.PUSH_NOTIFICATION_TTL;
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.pushNotificationTtl).toBe(3600);
      expect(config.pushNotificationTtlProvided).toBe(false);
    });
  });

  describe('Valid TTL Values', () => {
    it('should accept TTL within recommended range (300-86400)', () => {
      const validValues = [
        { value: '300', expected: 300, description: '5 minutes (minimum)' },
        { value: '3600', expected: 3600, description: '1 hour (default)' },
        { value: '7200', expected: 7200, description: '2 hours' },
        { value: '86400', expected: 86400, description: '24 hours (maximum)' },
        { value: '1800', expected: 1800, description: '30 minutes (arbitrary valid value)' }
      ];

      validValues.forEach(({ value, expected, description }) => {
        process.env.PUSH_NOTIFICATION_TTL = value;
        resetEnvironmentConfig();

        const config = getEnvironmentConfig();

        expect(config.pushNotificationTtl).toBe(expected);
        expect(config.pushNotificationTtlProvided).toBe(true);
      });
    });
  });

  describe('TTL Validation - Out of Range', () => {
    it('should reject TTL below minimum (< 300) and use default', () => {
      const invalidValues = ['0', '1', '60', '299'];

      invalidValues.forEach(value => {
        process.env.PUSH_NOTIFICATION_TTL = value;
        resetEnvironmentConfig();

        const config = getEnvironmentConfig();

        expect(config.pushNotificationTtl).toBe(3600); // Falls back to default
        expect(config.pushNotificationTtlProvided).toBe(false); // Marked as not provided
      });
    });

    it('should reject TTL above maximum (> 86400) and use default', () => {
      const invalidValues = ['86401', '100000', '999999'];

      invalidValues.forEach(value => {
        process.env.PUSH_NOTIFICATION_TTL = value;
        resetEnvironmentConfig();

        const config = getEnvironmentConfig();

        expect(config.pushNotificationTtl).toBe(3600); // Falls back to default
        expect(config.pushNotificationTtlProvided).toBe(false); // Marked as not provided
      });
    });
  });

  describe('TTL Validation - Invalid Input', () => {
    it('should reject non-numeric values and use default', () => {
      const invalidValues = ['abc', 'three-thousand', '', '  '];

      invalidValues.forEach(value => {
        process.env.PUSH_NOTIFICATION_TTL = value;
        resetEnvironmentConfig();

        const config = getEnvironmentConfig();

        expect(config.pushNotificationTtl).toBe(3600);
        expect(config.pushNotificationTtlProvided).toBe(false);
      });
    });

    it('should handle negative numbers by using default', () => {
      process.env.PUSH_NOTIFICATION_TTL = '-3600';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.pushNotificationTtl).toBe(3600);
      expect(config.pushNotificationTtlProvided).toBe(false);
    });

    it('should handle decimal numbers by truncating to integer', () => {
      process.env.PUSH_NOTIFICATION_TTL = '3600.5';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      // parseInt will truncate to 3600
      expect(config.pushNotificationTtl).toBe(3600);
      expect(config.pushNotificationTtlProvided).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should accept exact boundary values', () => {
      // Test minimum boundary
      process.env.PUSH_NOTIFICATION_TTL = '300';
      resetEnvironmentConfig();
      let config = getEnvironmentConfig();
      expect(config.pushNotificationTtl).toBe(300);

      // Test maximum boundary
      process.env.PUSH_NOTIFICATION_TTL = '86400';
      resetEnvironmentConfig();
      config = getEnvironmentConfig();
      expect(config.pushNotificationTtl).toBe(86400);
    });

    it('should reject values just outside boundaries', () => {
      // Just below minimum
      process.env.PUSH_NOTIFICATION_TTL = '299';
      resetEnvironmentConfig();
      let config = getEnvironmentConfig();
      expect(config.pushNotificationTtl).toBe(3600);

      // Just above maximum
      process.env.PUSH_NOTIFICATION_TTL = '86401';
      resetEnvironmentConfig();
      config = getEnvironmentConfig();
      expect(config.pushNotificationTtl).toBe(3600);
    });
  });
});
