/**
 * BIND_ADDRESS Environment Configuration Tests
 *
 * Guards the bind address via getEnvironmentConfig(): unset BIND_ADDRESS must
 * stay undefined (bind every interface, the pre-existing behaviour) and a set
 * value must come through trimmed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resetEnvironmentConfig, getEnvironmentConfig } from './environment.js';

describe('BIND_ADDRESS Environment Configuration', () => {
  const original = process.env.BIND_ADDRESS;

  afterEach(() => {
    if (original !== undefined) {
      process.env.BIND_ADDRESS = original;
    } else {
      delete process.env.BIND_ADDRESS;
    }
    resetEnvironmentConfig();
  });

  it('should leave bindAddress undefined when BIND_ADDRESS is not set', () => {
    delete process.env.BIND_ADDRESS;
    resetEnvironmentConfig();

    expect(getEnvironmentConfig().bindAddress).toBeUndefined();
  });

  it('should treat a blank BIND_ADDRESS as unset', () => {
    process.env.BIND_ADDRESS = '   ';
    resetEnvironmentConfig();

    expect(getEnvironmentConfig().bindAddress).toBeUndefined();
  });

  it('should pass an IPv4 address through', () => {
    process.env.BIND_ADDRESS = '127.0.0.1';
    resetEnvironmentConfig();

    expect(getEnvironmentConfig().bindAddress).toBe('127.0.0.1');
  });

  it('should pass an IPv6 address through', () => {
    process.env.BIND_ADDRESS = '::1';
    resetEnvironmentConfig();

    expect(getEnvironmentConfig().bindAddress).toBe('::1');
  });
});
