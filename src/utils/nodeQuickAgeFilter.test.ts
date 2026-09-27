/**
 * @vitest-environment jsdom
 *
 * Nodes tab quick age filter helpers (#5387).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  NODE_QUICK_AGE_STORAGE_KEY,
  parseNodeQuickAgeHours,
  readNodeQuickAgeHours,
  resolveNodeListAgeHours,
  writeNodeQuickAgeHours,
} from './nodeQuickAgeFilter';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('parseNodeQuickAgeHours', () => {
  it('accepts only the offered windows', () => {
    expect(parseNodeQuickAgeHours('24')).toBe(24);
    expect(parseNodeQuickAgeHours('720')).toBe(720);
    expect(parseNodeQuickAgeHours('0')).toBe(0);
  });

  it('reads anything else as "follow Settings"', () => {
    for (const raw of [null, undefined, '', '5', 'abc', '-1', 'Infinity']) {
      expect(parseNodeQuickAgeHours(raw)).toBeNull();
    }
  });
});

describe('resolveNodeListAgeHours', () => {
  it('uses the Settings window when no quick choice is set', () => {
    expect(resolveNodeListAgeHours(null, 24)).toBe(24);
    expect(resolveNodeListAgeHours(null, 0)).toBe(0);
  });

  it('overrides the Settings window, wider or narrower', () => {
    expect(resolveNodeListAgeHours(168, 24)).toBe(168);
    expect(resolveNodeListAgeHours(24, 720)).toBe(24);
    expect(resolveNodeListAgeHours(0, 24)).toBe(0);
  });
});

describe('localStorage round trip', () => {
  it('writes, reads, and clears', () => {
    writeNodeQuickAgeHours(72);
    expect(localStorage.getItem(NODE_QUICK_AGE_STORAGE_KEY)).toBe('72');
    expect(readNodeQuickAgeHours()).toBe(72);
    writeNodeQuickAgeHours(null);
    expect(localStorage.getItem(NODE_QUICK_AGE_STORAGE_KEY)).toBeNull();
    expect(readNodeQuickAgeHours()).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readNodeQuickAgeHours()).toBeNull();
    expect(() => writeNodeQuickAgeHours(24)).not.toThrow();
  });
});
