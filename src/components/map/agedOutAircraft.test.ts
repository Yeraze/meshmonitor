/**
 * @vitest-environment jsdom
 *
 * "Show aged-out" helpers (#5364/#5365 Phase 2).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isAgedOutAircraft,
  readShowAgedOutAircraft,
  writeShowAgedOutAircraft,
  SHOW_AGED_OUT_AIRCRAFT_STORAGE_KEY,
} from './agedOutAircraft';

describe('isAgedOutAircraft', () => {
  it('is true only for an ignored node with aircraftAgedOutAt set', () => {
    expect(isAgedOutAircraft({ isIgnored: true, aircraftAgedOutAt: 123 })).toBe(true);
    expect(isAgedOutAircraft({ isIgnored: true, aircraftAgedOutAt: 0 })).toBe(true);
  });

  it('is false for a manual/geo ignore, a lifted node, or nothing', () => {
    expect(isAgedOutAircraft({ isIgnored: true, aircraftAgedOutAt: null })).toBe(false);
    expect(isAgedOutAircraft({ isIgnored: true })).toBe(false);
    expect(isAgedOutAircraft({ isIgnored: false, aircraftAgedOutAt: 123 })).toBe(false);
    expect(isAgedOutAircraft(null)).toBe(false);
    expect(isAgedOutAircraft(undefined)).toBe(false);
  });
});

describe('Show aged-out persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('defaults to off and round-trips through localStorage', () => {
    expect(readShowAgedOutAircraft()).toBe(false);
    writeShowAgedOutAircraft(true);
    expect(localStorage.getItem(SHOW_AGED_OUT_AIRCRAFT_STORAGE_KEY)).toBe('true');
    expect(readShowAgedOutAircraft()).toBe(true);
    writeShowAgedOutAircraft(false);
    expect(readShowAgedOutAircraft()).toBe(false);
  });

  it('reads as off and never throws when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readShowAgedOutAircraft()).toBe(false);
    expect(() => writeShowAgedOutAircraft(true)).not.toThrow();
  });
});
