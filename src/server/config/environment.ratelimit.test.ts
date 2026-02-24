/**
 * Rate Limit Environment Configuration Tests
 *
 * Tests the parseRateLimit() helper via getEnvironmentConfig() for the
 * RATE_LIMIT_API, RATE_LIMIT_AUTH, and RATE_LIMIT_MESSAGES env vars.
 * Special values ("unlimited", "0", "-1") should yield 0 (disabled sentinel).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resetEnvironmentConfig, getEnvironmentConfig } from './environment.js';

// In the test environment NODE_ENV defaults to 'development',
// so the rate-limit defaults are: API=10000, Auth=100, Messages=100

describe('Rate Limit Environment Configuration', () => {
  const originalApi = process.env.RATE_LIMIT_API;
  const originalAuth = process.env.RATE_LIMIT_AUTH;
  const originalMessages = process.env.RATE_LIMIT_MESSAGES;

  afterEach(() => {
    // Restore original environment
    if (originalApi !== undefined) {
      process.env.RATE_LIMIT_API = originalApi;
    } else {
      delete process.env.RATE_LIMIT_API;
    }
    if (originalAuth !== undefined) {
      process.env.RATE_LIMIT_AUTH = originalAuth;
    } else {
      delete process.env.RATE_LIMIT_AUTH;
    }
    if (originalMessages !== undefined) {
      process.env.RATE_LIMIT_MESSAGES = originalMessages;
    } else {
      delete process.env.RATE_LIMIT_MESSAGES;
    }
    resetEnvironmentConfig();
  });

  describe('Default values', () => {
    it('should use development defaults when env vars are not set', () => {
      delete process.env.RATE_LIMIT_API;
      delete process.env.RATE_LIMIT_AUTH;
      delete process.env.RATE_LIMIT_MESSAGES;
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitApi).toBe(10000);
      expect(config.rateLimitApiProvided).toBe(false);
      expect(config.rateLimitAuth).toBe(100);
      expect(config.rateLimitAuthProvided).toBe(false);
      expect(config.rateLimitMessages).toBe(100);
      expect(config.rateLimitMessagesProvided).toBe(false);
    });
  });

  describe('Valid positive integer values', () => {
    it('should accept custom positive integers for all rate limit vars', () => {
      process.env.RATE_LIMIT_API = '500';
      process.env.RATE_LIMIT_AUTH = '20';
      process.env.RATE_LIMIT_MESSAGES = '60';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitApi).toBe(500);
      expect(config.rateLimitApiProvided).toBe(true);
      expect(config.rateLimitAuth).toBe(20);
      expect(config.rateLimitAuthProvided).toBe(true);
      expect(config.rateLimitMessages).toBe(60);
      expect(config.rateLimitMessagesProvided).toBe(true);
    });

    it('should accept value of 1 as valid limit', () => {
      process.env.RATE_LIMIT_API = '1';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitApi).toBe(1);
      expect(config.rateLimitApiProvided).toBe(true);
    });
  });

  describe('Unlimited / disabled via special values', () => {
    it('should treat "unlimited" as disabled (value 0)', () => {
      process.env.RATE_LIMIT_API = 'unlimited';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitApi).toBe(0);
      expect(config.rateLimitApiProvided).toBe(true);
    });

    it('should treat "UNLIMITED" (uppercase) as disabled', () => {
      process.env.RATE_LIMIT_AUTH = 'UNLIMITED';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitAuth).toBe(0);
      expect(config.rateLimitAuthProvided).toBe(true);
    });

    it('should treat "Unlimited" (mixed case) as disabled', () => {
      process.env.RATE_LIMIT_MESSAGES = 'Unlimited';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitMessages).toBe(0);
      expect(config.rateLimitMessagesProvided).toBe(true);
    });

    it('should treat "0" as disabled', () => {
      process.env.RATE_LIMIT_API = '0';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitApi).toBe(0);
      expect(config.rateLimitApiProvided).toBe(true);
    });

    it('should treat "-1" as disabled', () => {
      process.env.RATE_LIMIT_API = '-1';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitApi).toBe(0);
      expect(config.rateLimitApiProvided).toBe(true);
    });

    it('should treat other negative numbers as disabled', () => {
      process.env.RATE_LIMIT_API = '-100';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitApi).toBe(0);
      expect(config.rateLimitApiProvided).toBe(true);
    });

    it('should handle "unlimited" with whitespace', () => {
      process.env.RATE_LIMIT_API = '  unlimited  ';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitApi).toBe(0);
      expect(config.rateLimitApiProvided).toBe(true);
    });

    it('should disable all three limiters independently', () => {
      process.env.RATE_LIMIT_API = 'unlimited';
      process.env.RATE_LIMIT_AUTH = '0';
      process.env.RATE_LIMIT_MESSAGES = '-1';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitApi).toBe(0);
      expect(config.rateLimitAuth).toBe(0);
      expect(config.rateLimitMessages).toBe(0);
    });
  });

  describe('Invalid input', () => {
    it('should fall back to default for non-numeric strings', () => {
      process.env.RATE_LIMIT_API = 'abc';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitApi).toBe(10000); // development default
      expect(config.rateLimitApiProvided).toBe(false);
    });

    it('should fall back to default for empty string', () => {
      process.env.RATE_LIMIT_API = '';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitApi).toBe(10000);
      expect(config.rateLimitApiProvided).toBe(false);
    });

    it('should fall back to default for whitespace-only string', () => {
      process.env.RATE_LIMIT_API = '   ';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitApi).toBe(10000);
      expect(config.rateLimitApiProvided).toBe(false);
    });
  });

  describe('Mixed configuration', () => {
    it('should allow some limiters disabled and others with custom values', () => {
      process.env.RATE_LIMIT_API = 'unlimited';
      process.env.RATE_LIMIT_AUTH = '50';
      delete process.env.RATE_LIMIT_MESSAGES;
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.rateLimitApi).toBe(0);
      expect(config.rateLimitApiProvided).toBe(true);
      expect(config.rateLimitAuth).toBe(50);
      expect(config.rateLimitAuthProvided).toBe(true);
      expect(config.rateLimitMessages).toBe(100); // development default
      expect(config.rateLimitMessagesProvided).toBe(false);
    });
  });
});
