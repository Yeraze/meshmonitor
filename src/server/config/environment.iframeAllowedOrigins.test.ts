/**
 * Tests for IFRAME_ALLOWED_ORIGINS configuration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEnvironmentConfig, resetEnvironmentConfig } from './environment.js';

describe('Environment Configuration - IFRAME_ALLOWED_ORIGINS', () => {
  const originalValue = process.env.IFRAME_ALLOWED_ORIGINS;

  beforeEach(() => {
    resetEnvironmentConfig();
  });

  afterEach(() => {
    if (originalValue !== undefined) {
      process.env.IFRAME_ALLOWED_ORIGINS = originalValue;
    } else {
      delete process.env.IFRAME_ALLOWED_ORIGINS;
    }
    resetEnvironmentConfig();
  });

  it('defaults to empty array when IFRAME_ALLOWED_ORIGINS is not set', () => {
    delete process.env.IFRAME_ALLOWED_ORIGINS;
    const config = loadEnvironmentConfig();

    expect(config.iframeAllowedOrigins).toEqual([]);
    expect(config.iframeAllowedOriginsProvided).toBe(false);
  });

  it('parses a single origin', () => {
    process.env.IFRAME_ALLOWED_ORIGINS = 'http://192.168.1.50:1880';
    const config = loadEnvironmentConfig();

    expect(config.iframeAllowedOrigins).toEqual(['http://192.168.1.50:1880']);
    expect(config.iframeAllowedOriginsProvided).toBe(true);
  });

  it('parses a comma-separated list of origins', () => {
    process.env.IFRAME_ALLOWED_ORIGINS = 'http://a.example,https://b.example';
    const config = loadEnvironmentConfig();

    expect(config.iframeAllowedOrigins).toEqual([
      'http://a.example',
      'https://b.example',
    ]);
  });

  it('trims whitespace and drops empty entries', () => {
    process.env.IFRAME_ALLOWED_ORIGINS = ' http://a.example , , https://b.example ';
    const config = loadEnvironmentConfig();

    expect(config.iframeAllowedOrigins).toEqual([
      'http://a.example',
      'https://b.example',
    ]);
  });

  it('accepts a wildcard origin', () => {
    process.env.IFRAME_ALLOWED_ORIGINS = '*';
    const config = loadEnvironmentConfig();

    expect(config.iframeAllowedOrigins).toEqual(['*']);
  });

  it('treats an empty string as "provided" but empty list', () => {
    process.env.IFRAME_ALLOWED_ORIGINS = '';
    const config = loadEnvironmentConfig();

    expect(config.iframeAllowedOrigins).toEqual([]);
    expect(config.iframeAllowedOriginsProvided).toBe(true);
  });
});
