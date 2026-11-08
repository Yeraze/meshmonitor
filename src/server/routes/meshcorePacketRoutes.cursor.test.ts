/** parseCursor edge cases (#6262 review). */
import { describe, it, expect } from 'vitest';
import { parseCursor } from './meshcorePacketRoutes.js';

describe('parseCursor', () => {
  it('returns null when absent', () => {
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor('')).toBeNull();
  });
  it('parses a valid ms-epoch cursor', () => {
    expect(parseCursor('1762560000000_42')).toEqual({ untilTs: 1762560000000, untilId: 42 });
  });
  it('rejects parts that could exceed MAX_SAFE_INTEGER', () => {
    expect(parseCursor('9999999999999999_1')).toBeUndefined();
    expect(parseCursor('1_99999999999')).toBeUndefined();
  });
  it('rejects non-numeric and malformed input', () => {
    for (const v of ['abc', '12_', '_12', '1.5_2', '-1_2', '1_2_3', '1e5_2']) {
      expect(parseCursor(v)).toBeUndefined();
    }
  });
});
