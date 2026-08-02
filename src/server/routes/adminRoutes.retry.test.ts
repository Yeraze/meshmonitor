/**
 * Auto-retry bounds for remote admin commands (#4487).
 *
 * The retry itself is ACK-driven: only a `timed_out` outcome is retried, and an
 * explicit routing rejection settles immediately (see #4492). These cover the
 * two pure pieces — how many attempts are allowed, and how long we wait between
 * them — without standing up the whole mesh transport.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSetting = vi.fn();
vi.mock('../../services/database.js', () => ({
  default: { settings: { getSetting: (k: string) => getSetting(k) } },
}));

import {
  resolveAdminRetryAttempts,
  adminRetryDelayMs,
  ADMIN_RETRY_MIN_ATTEMPTS,
  ADMIN_RETRY_MAX_ATTEMPTS,
} from './adminRoutes.js';

beforeEach(() => {
  getSetting.mockReset();
  getSetting.mockResolvedValue(null);
});

describe('resolveAdminRetryAttempts (#4487)', () => {
  it('defaults to a single attempt when nothing is configured', async () => {
    // Deliberately NOT >1: silently multiplying every operator's radio traffic
    // is not a default worth choosing for them, and 1 is exactly the
    // pre-#4487 behaviour.
    await expect(resolveAdminRetryAttempts(undefined)).resolves.toBe(1);
  });

  it('uses the configured setting when no override is given', async () => {
    getSetting.mockResolvedValue('4');
    await expect(resolveAdminRetryAttempts(undefined)).resolves.toBe(4);
  });

  it('lets a per-send override beat the setting', async () => {
    getSetting.mockResolvedValue('4');
    await expect(resolveAdminRetryAttempts(7)).resolves.toBe(7);
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['above the ceiling', ADMIN_RETRY_MAX_ATTEMPTS + 1],
    ['fractional', 2.5],
    ['not a number', 'lots'],
  ])('ignores an out-of-range override (%s) and falls back', async (_label, override) => {
    getSetting.mockResolvedValue('3');
    await expect(resolveAdminRetryAttempts(override as never)).resolves.toBe(3);
  });

  it.each([
    ['zero', '0'],
    ['above the ceiling', String(ADMIN_RETRY_MAX_ATTEMPTS + 1)],
    ['garbage', 'many'],
  ])('ignores an out-of-range setting (%s) and falls back to 1', async (_label, stored) => {
    getSetting.mockResolvedValue(stored);
    await expect(resolveAdminRetryAttempts(undefined)).resolves.toBe(1);
  });

  it('accepts the exact bounds', async () => {
    await expect(resolveAdminRetryAttempts(ADMIN_RETRY_MIN_ATTEMPTS)).resolves.toBe(ADMIN_RETRY_MIN_ATTEMPTS);
    await expect(resolveAdminRetryAttempts(ADMIN_RETRY_MAX_ATTEMPTS)).resolves.toBe(ADMIN_RETRY_MAX_ATTEMPTS);
  });
});

describe('adminRetryDelayMs (#4487)', () => {
  it('backs off linearly and then holds', () => {
    // Linear, not exponential: the ACK window is already 30s, so doubling would
    // push a third attempt minutes out — well past when the operator is still
    // watching the command.
    expect(adminRetryDelayMs(1)).toBe(5_000);
    expect(adminRetryDelayMs(2)).toBe(10_000);
    expect(adminRetryDelayMs(3)).toBe(15_000);
    expect(adminRetryDelayMs(9)).toBe(15_000);
  });
});

describe('resolveAdminRetryAttempts resilience (#4487)', () => {
  it('falls back to 1 when the settings read throws', async () => {
    // This is awaited in the request path before the 202 is sent. A settings
    // failure must not take the whole command down — retry policy is not worth
    // failing a send over.
    getSetting.mockRejectedValue(new Error('db down'));
    await expect(resolveAdminRetryAttempts(undefined)).resolves.toBe(1);
  });

  it('still honours a valid override when the settings read throws', async () => {
    getSetting.mockRejectedValue(new Error('db down'));
    await expect(resolveAdminRetryAttempts(5)).resolves.toBe(5);
  });
});
