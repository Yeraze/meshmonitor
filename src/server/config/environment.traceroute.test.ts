import { afterEach, describe, expect, it } from 'vitest';
import { getEnvironmentConfig, resetEnvironmentConfig } from './environment.js';

describe('Traceroute history environment configuration', () => {
  const originalLimit = process.env.TRACEROUTE_HISTORY_LIMIT;

  afterEach(() => {
    if (originalLimit !== undefined) {
      process.env.TRACEROUTE_HISTORY_LIMIT = originalLimit;
    } else {
      delete process.env.TRACEROUTE_HISTORY_LIMIT;
    }
    resetEnvironmentConfig();
  });

  it('defaults to 50 when TRACEROUTE_HISTORY_LIMIT is not set', () => {
    delete process.env.TRACEROUTE_HISTORY_LIMIT;
    resetEnvironmentConfig();

    const config = getEnvironmentConfig();

    expect(config.tracerouteHistoryLimit).toBe(50);
    expect(config.tracerouteHistoryLimitProvided).toBe(false);
  });

  it('accepts a positive integer override', () => {
    process.env.TRACEROUTE_HISTORY_LIMIT = '500';
    resetEnvironmentConfig();

    const config = getEnvironmentConfig();

    expect(config.tracerouteHistoryLimit).toBe(500);
    expect(config.tracerouteHistoryLimitProvided).toBe(true);
  });

  it('falls back to 50 for invalid values', () => {
    process.env.TRACEROUTE_HISTORY_LIMIT = '0';
    resetEnvironmentConfig();

    const config = getEnvironmentConfig();

    expect(config.tracerouteHistoryLimit).toBe(50);
    expect(config.tracerouteHistoryLimitProvided).toBe(false);
  });
});
