/**
 * Shared scheduled-telemetry retry policy (#6033). These pure helpers are the
 * single source of truth for the burst→cooldown arithmetic used by both the
 * MeshCore remote-telemetry scheduler and the Meshtastic remote-LocalStats
 * scheduler, so they get their own thorough unit coverage here.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveRetryConfig,
  nextRetryState,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  DEFAULT_RETRY_COOLDOWN_MINUTES,
} from './telemetryRetryPolicy.js';

describe('resolveRetryConfig', () => {
  it('defaults to the approved 90s / 5 / 30m', () => {
    expect(resolveRetryConfig({})).toEqual(DEFAULT_RETRY_CONFIG);
  });
  it('parses valid per-source overrides', () => {
    expect(resolveRetryConfig({ delaySeconds: '45', maxAttempts: '3', cooldownMinutes: '15' })).toEqual({
      retryDelayMs: 45_000,
      maxAttempts: 3,
      cooldownMs: 15 * 60_000,
    });
  });
  it('ignores zero / negative / garbage, keeping the default', () => {
    expect(resolveRetryConfig({ delaySeconds: '0', maxAttempts: '-1', cooldownMinutes: 'nope' })).toEqual(
      DEFAULT_RETRY_CONFIG,
    );
  });
  it('clamps maxAttempts to at least 1', () => {
    expect(resolveRetryConfig({ maxAttempts: '0.4' }).maxAttempts).toBe(1);
  });
});

describe('nextRetryState', () => {
  const now = 1_000_000;

  it('a success resets the counter and lifts any cooldown', () => {
    expect(nextRetryState({ missCount: 4 }, 'success', now, DEFAULT_RETRY_CONFIG)).toEqual({
      missCount: 0,
      cooldownUntil: null,
    });
  });

  it('a miss below the cap just increments the counter', () => {
    expect(nextRetryState({ missCount: 0 }, 'miss', now, DEFAULT_RETRY_CONFIG)).toEqual({
      missCount: 1,
      cooldownUntil: null,
    });
    expect(nextRetryState({ missCount: 3 }, 'miss', now, DEFAULT_RETRY_CONFIG)).toEqual({
      missCount: 4,
      cooldownUntil: null,
    });
  });

  it('the Nth miss arms the cooldown and resets the counter', () => {
    // Default cap is 5; a node already at 4 misses hits it on this miss.
    expect(nextRetryState({ missCount: DEFAULT_RETRY_MAX_ATTEMPTS - 1 }, 'miss', now, DEFAULT_RETRY_CONFIG)).toEqual({
      missCount: 0,
      cooldownUntil: now + DEFAULT_RETRY_COOLDOWN_MINUTES * 60_000,
    });
  });

  it('treats null / missing missCount as zero', () => {
    expect(nextRetryState({}, 'miss', now, DEFAULT_RETRY_CONFIG)).toEqual({ missCount: 1, cooldownUntil: null });
    expect(nextRetryState({ missCount: null }, 'miss', now, DEFAULT_RETRY_CONFIG)).toEqual({
      missCount: 1,
      cooldownUntil: null,
    });
  });
});
