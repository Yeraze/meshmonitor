/**
 * Trust Proxy Environment Configuration Tests
 *
 * Guards the parseTrustProxy() parser default via getEnvironmentConfig():
 * when TRUST_PROXY is unset, trustProxy must be false and trustProxyProvided
 * must be false (secure default introduced in v4.13).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resetEnvironmentConfig, getEnvironmentConfig } from './environment.js';

describe('Trust Proxy Environment Configuration', () => {
  const originalTrustProxy = process.env.TRUST_PROXY;

  afterEach(() => {
    if (originalTrustProxy !== undefined) {
      process.env.TRUST_PROXY = originalTrustProxy;
    } else {
      delete process.env.TRUST_PROXY;
    }
    resetEnvironmentConfig();
  });

  describe('Default (TRUST_PROXY unset)', () => {
    it('should default trustProxy to false when TRUST_PROXY is not set', () => {
      delete process.env.TRUST_PROXY;
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.trustProxy).toBe(false);
      expect(config.trustProxyProvided).toBe(false);
    });
  });

  describe('Explicit values', () => {
    it('should parse TRUST_PROXY=1 as numeric 1 with trustProxyProvided=true', () => {
      process.env.TRUST_PROXY = '1';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.trustProxy).toBe(1);
      expect(config.trustProxyProvided).toBe(true);
    });

    it('should parse TRUST_PROXY=true as truthy with trustProxyProvided=true', () => {
      process.env.TRUST_PROXY = 'true';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.trustProxyProvided).toBe(true);
      // 'true' parses as boolean true in parseTrustProxy
      expect(config.trustProxy).toBe(true);
    });

    it('should parse TRUST_PROXY=false as false with trustProxyProvided=true', () => {
      process.env.TRUST_PROXY = 'false';
      resetEnvironmentConfig();

      const config = getEnvironmentConfig();

      expect(config.trustProxyProvided).toBe(true);
      expect(config.trustProxy).toBe(false);
    });
  });
});
