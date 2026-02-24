/**
 * Tests for SESSION_COOKIE_NAME configuration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEnvironmentConfig, resetEnvironmentConfig } from './environment.js';

describe('Environment Configuration - Session Cookie Name', () => {
  const originalCookieName = process.env.SESSION_COOKIE_NAME;

  beforeEach(() => {
    resetEnvironmentConfig();
  });

  afterEach(() => {
    // Restore original SESSION_COOKIE_NAME
    if (originalCookieName !== undefined) {
      process.env.SESSION_COOKIE_NAME = originalCookieName;
    } else {
      delete process.env.SESSION_COOKIE_NAME;
    }
    resetEnvironmentConfig();
  });

  it('should use "meshmonitor.sid" as default when SESSION_COOKIE_NAME is not set', () => {
    delete process.env.SESSION_COOKIE_NAME;
    const config = loadEnvironmentConfig();

    expect(config.sessionCookieName).toBe('meshmonitor.sid');
    expect(config.sessionCookieNameProvided).toBe(false);
  });

  it('should accept custom session cookie name', () => {
    process.env.SESSION_COOKIE_NAME = 'custom-app.sid';
    const config = loadEnvironmentConfig();

    expect(config.sessionCookieName).toBe('custom-app.sid');
    expect(config.sessionCookieNameProvided).toBe(true);
  });

  it('should accept session cookie name with hyphens', () => {
    process.env.SESSION_COOKIE_NAME = 'meshmonitor-mf.sid';
    const config = loadEnvironmentConfig();

    expect(config.sessionCookieName).toBe('meshmonitor-mf.sid');
    expect(config.sessionCookieNameProvided).toBe(true);
  });

  it('should accept session cookie name with underscores', () => {
    process.env.SESSION_COOKIE_NAME = 'meshmonitor_lf.sid';
    const config = loadEnvironmentConfig();

    expect(config.sessionCookieName).toBe('meshmonitor_lf.sid');
    expect(config.sessionCookieNameProvided).toBe(true);
  });

  it('should accept session cookie name without .sid suffix', () => {
    process.env.SESSION_COOKIE_NAME = 'mycustomcookie';
    const config = loadEnvironmentConfig();

    expect(config.sessionCookieName).toBe('mycustomcookie');
    expect(config.sessionCookieNameProvided).toBe(true);
  });

  it('should handle empty string as not provided', () => {
    process.env.SESSION_COOKIE_NAME = '';
    const config = loadEnvironmentConfig();

    // Empty string should fall back to default
    expect(config.sessionCookieName).toBe('meshmonitor.sid');
    expect(config.sessionCookieNameProvided).toBe(true);
  });

  it('should accept session cookie names for multi-instance scenario', () => {
    // Simulate first instance
    process.env.SESSION_COOKIE_NAME = 'meshmonitor-instance1.sid';
    const config1 = loadEnvironmentConfig();

    expect(config1.sessionCookieName).toBe('meshmonitor-instance1.sid');
    expect(config1.sessionCookieNameProvided).toBe(true);

    // Reset and simulate second instance
    resetEnvironmentConfig();
    process.env.SESSION_COOKIE_NAME = 'meshmonitor-instance2.sid';
    const config2 = loadEnvironmentConfig();

    expect(config2.sessionCookieName).toBe('meshmonitor-instance2.sid');
    expect(config2.sessionCookieNameProvided).toBe(true);

    // Verify they're different
    expect(config1.sessionCookieName).not.toBe(config2.sessionCookieName);
  });

  it('should accept alphanumeric session cookie names', () => {
    process.env.SESSION_COOKIE_NAME = 'meshmonitor123.sid';
    const config = loadEnvironmentConfig();

    expect(config.sessionCookieName).toBe('meshmonitor123.sid');
    expect(config.sessionCookieNameProvided).toBe(true);
  });

  it('should accept session cookie name with dots', () => {
    process.env.SESSION_COOKIE_NAME = 'app.session.sid';
    const config = loadEnvironmentConfig();

    expect(config.sessionCookieName).toBe('app.session.sid');
    expect(config.sessionCookieNameProvided).toBe(true);
  });
});
