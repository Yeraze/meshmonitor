/**
 * Boolean Environment Variable Parsing Tests
 *
 * Guards parseBoolean() case-insensitivity via getEnvironmentConfig():
 * values like COOKIE_SECURE=TRUE must parse as booleans instead of
 * falling through to the default-with-warning path (follow-up to the
 * TRUST_PROXY casing fix in #4216 / PR #4218).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resetEnvironmentConfig, getEnvironmentConfig } from './environment.js';

describe('parseBoolean via COOKIE_SECURE', () => {
  const originalCookieSecure = process.env.COOKIE_SECURE;

  afterEach(() => {
    if (originalCookieSecure !== undefined) {
      process.env.COOKIE_SECURE = originalCookieSecure;
    } else {
      delete process.env.COOKIE_SECURE;
    }
    resetEnvironmentConfig();
  });

  it('should default to false when COOKIE_SECURE is not set', () => {
    delete process.env.COOKIE_SECURE;
    resetEnvironmentConfig();

    expect(getEnvironmentConfig().cookieSecure).toBe(false);
  });

  it.each(['true', 'TRUE', 'True', 'tRuE'])('should parse COOKIE_SECURE=%s as true', (value) => {
    process.env.COOKIE_SECURE = value;
    resetEnvironmentConfig();

    expect(getEnvironmentConfig().cookieSecure).toBe(true);
  });

  it.each(['false', 'FALSE', 'False', 'fAlSe'])('should parse COOKIE_SECURE=%s as false', (value) => {
    process.env.COOKIE_SECURE = value;
    resetEnvironmentConfig();

    expect(getEnvironmentConfig().cookieSecure).toBe(false);
  });

  it('should tolerate surrounding whitespace', () => {
    process.env.COOKIE_SECURE = '  true  ';
    resetEnvironmentConfig();

    expect(getEnvironmentConfig().cookieSecure).toBe(true);
  });

  it('should fall back to the default for invalid values', () => {
    process.env.COOKIE_SECURE = 'yes';
    resetEnvironmentConfig();

    expect(getEnvironmentConfig().cookieSecure).toBe(false);
  });
});
