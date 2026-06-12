import { describe, it, expect } from 'vitest';
import {
  resolveAutoWelcomeDelaySeconds,
  AUTO_WELCOME_DELAY_DEFAULT_SECONDS,
  AUTO_WELCOME_DELAY_MAX_SECONDS,
} from './autoWelcomeDelay';

describe('resolveAutoWelcomeDelaySeconds', () => {
  it('defaults to 30s when unset (so the fix applies without re-saving)', () => {
    expect(resolveAutoWelcomeDelaySeconds(null)).toBe(AUTO_WELCOME_DELAY_DEFAULT_SECONDS);
    expect(resolveAutoWelcomeDelaySeconds(undefined)).toBe(30);
    expect(resolveAutoWelcomeDelaySeconds('')).toBe(30);
  });

  it('honors a valid configured value', () => {
    expect(resolveAutoWelcomeDelaySeconds('0')).toBe(0);
    expect(resolveAutoWelcomeDelaySeconds('15')).toBe(15);
    expect(resolveAutoWelcomeDelaySeconds('120')).toBe(120);
  });

  it('clamps above the 120s maximum', () => {
    expect(resolveAutoWelcomeDelaySeconds('300')).toBe(AUTO_WELCOME_DELAY_MAX_SECONDS);
  });

  it('falls back to the default on invalid / negative input', () => {
    expect(resolveAutoWelcomeDelaySeconds('-5')).toBe(30);
    expect(resolveAutoWelcomeDelaySeconds('abc')).toBe(30);
  });
});
