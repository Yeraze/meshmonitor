/**
 * Tests for timezone validation in environment configuration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEnvironmentConfig, resetEnvironmentConfig } from './environment.js';

describe('Environment Configuration - Timezone Validation', () => {
  const originalTZ = process.env.TZ;

  beforeEach(() => {
    resetEnvironmentConfig();
  });

  afterEach(() => {
    // Restore original TZ
    if (originalTZ !== undefined) {
      process.env.TZ = originalTZ;
    } else {
      delete process.env.TZ;
    }
    resetEnvironmentConfig();
  });

  it('should use UTC as default when TZ is not set', () => {
    delete process.env.TZ;
    const config = loadEnvironmentConfig();

    expect(config.timezone).toBe('UTC');
    expect(config.timezoneProvided).toBe(false);
  });

  it('should accept valid IANA timezone (Europe/London)', () => {
    process.env.TZ = 'Europe/London';
    const config = loadEnvironmentConfig();

    expect(config.timezone).toBe('Europe/London');
    expect(config.timezoneProvided).toBe(true);
  });

  it('should accept valid IANA timezone (America/New_York)', () => {
    process.env.TZ = 'America/New_York';
    const config = loadEnvironmentConfig();

    expect(config.timezone).toBe('America/New_York');
    expect(config.timezoneProvided).toBe(true);
  });

  it('should accept valid IANA timezone (Asia/Tokyo)', () => {
    process.env.TZ = 'Asia/Tokyo';
    const config = loadEnvironmentConfig();

    expect(config.timezone).toBe('Asia/Tokyo');
    expect(config.timezoneProvided).toBe(true);
  });

  it('should fall back to UTC for invalid timezone', () => {
    process.env.TZ = 'Invalid/Timezone';
    const config = loadEnvironmentConfig();

    // Should fall back to UTC
    expect(config.timezone).toBe('UTC');
    expect(config.timezoneProvided).toBe(false);
  });

  it('should fall back to UTC for malformed timezone', () => {
    process.env.TZ = 'NotAValidTimezone';
    const config = loadEnvironmentConfig();

    // Should fall back to UTC
    expect(config.timezone).toBe('UTC');
    expect(config.timezoneProvided).toBe(false);
  });

  it('should handle timezone with special characters gracefully', () => {
    process.env.TZ = 'Europe/../London';
    const config = loadEnvironmentConfig();

    // Should fall back to UTC for security
    expect(config.timezone).toBe('UTC');
    expect(config.timezoneProvided).toBe(false);
  });

  it('should validate timezone can be used with toLocaleString', () => {
    process.env.TZ = 'Europe/London';
    const config = loadEnvironmentConfig();

    // Verify the timezone actually works with Date formatting
    const testDate = new Date('2024-01-15T12:00:00Z');
    expect(() => {
      testDate.toLocaleString('en-US', { timeZone: config.timezone });
    }).not.toThrow();
  });

  it('should handle empty string timezone', () => {
    process.env.TZ = '';
    const config = loadEnvironmentConfig();

    // Empty string should be treated as not provided
    // But since we set it, timezoneProvided might be true, then it falls back to UTC
    expect(config.timezone).toBe('UTC');
  });
});
