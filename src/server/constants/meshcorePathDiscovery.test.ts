import { describe, it, expect } from 'vitest';
import { meshcorePathDiscoveryTimeoutMs } from './meshcorePathDiscovery.js';

describe('meshcorePathDiscoveryTimeoutMs (#5508)', () => {
  it('uses the 30 s flood default when the firmware suggests 0', () => {
    expect(meshcorePathDiscoveryTimeoutMs(0)).toBe(30_000);
  });

  it('treats missing / garbage values as 0', () => {
    expect(meshcorePathDiscoveryTimeoutMs(undefined)).toBe(30_000);
    expect(meshcorePathDiscoveryTimeoutMs(Number.NaN)).toBe(30_000);
    expect(meshcorePathDiscoveryTimeoutMs(-5)).toBe(30_000);
  });

  it('never goes below the 20 s floor for a tiny suggestion', () => {
    expect(meshcorePathDiscoveryTimeoutMs(1)).toBe(20_000);
    expect(meshcorePathDiscoveryTimeoutMs(5_000)).toBe(20_000); // 6 s + 8 s = 14 s
  });

  it('caps at 60 s for a large suggestion', () => {
    expect(meshcorePathDiscoveryTimeoutMs(100_000)).toBe(60_000);
  });

  it('applies suggested × 1.2 + 8 s in the middle of the range', () => {
    expect(meshcorePathDiscoveryTimeoutMs(20_000)).toBe(32_000);
    expect(meshcorePathDiscoveryTimeoutMs(30_000)).toBe(44_000);
  });
});
