import { describe, it, expect } from 'vitest';
import { formatBootloaderVersion } from './bootloaderVersion.js';

describe('formatBootloaderVersion (#6321)', () => {
  it('unpacks major << 16 | minor << 8 | patch', () => {
    expect(formatBootloaderVersion(0x000902)).toBe('0.9.2');
    expect(formatBootloaderVersion(0x000a03)).toBe('0.10.3');
    expect(formatBootloaderVersion(0x020600)).toBe('2.6.0');
    expect(formatBootloaderVersion((1 << 16) | (2 << 8) | 3)).toBe('1.2.3');
  });

  it('returns null for 0 (not reported) and other absent values', () => {
    expect(formatBootloaderVersion(0)).toBeNull();
    expect(formatBootloaderVersion(undefined)).toBeNull();
    expect(formatBootloaderVersion(null)).toBeNull();
    expect(formatBootloaderVersion(-1)).toBeNull();
    expect(formatBootloaderVersion(1.5)).toBeNull();
  });
});
