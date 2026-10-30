/**
 * Regression test for #6081 — username enumeration via a bcrypt timing
 * side-channel on login.
 *
 * Before the fix, authenticateAsync() returned immediately (no bcrypt) when the
 * username did not exist, so a missing user answered in ~1ms while an existing
 * user took a full bcrypt.compare (~tens of ms). That timing gap let an attacker
 * enumerate valid usernames. The fix runs a bcrypt.compare against a fixed dummy
 * hash for unknown users, so the missing-user path now spends real bcrypt time.
 *
 * The test asserts the unknown-user path spends measurable bcrypt time
 * (a cost-10 compare is reliably >> the threshold, while the old early-return
 * was sub-millisecond).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import databaseService from './database.js';

describe('authenticateAsync — login timing equalization (#6081)', () => {
  beforeAll(async () => {
    await databaseService.waitForReady();
    // Warm up the bcrypt native binding + V8 so the measured call is steady.
    await databaseService.authenticateAsync('warmup-user-not-real', 'warmup');
  });

  it('returns null for an unknown username', async () => {
    const result = await databaseService.authenticateAsync(
      'definitely-missing-user-6081-xyz',
      'any-password'
    );
    expect(result).toBeNull();
  });

  it('spends bcrypt time on the unknown-user path (no fast early return)', async () => {
    // Take the fastest of a few samples to avoid a pathologically slow outlier;
    // even the fastest cost-10 bcrypt.compare dwarfs the old sub-ms early return.
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const result = await databaseService.authenticateAsync(
        `missing-user-6081-${i}`,
        'wrong-password'
      );
      samples.push(performance.now() - start);
      expect(result).toBeNull();
    }
    const fastest = Math.min(...samples);
    // Pre-fix this path was < 1ms; a bcrypt cost-10 compare is reliably >> 8ms.
    expect(fastest).toBeGreaterThan(8);
  });
});
