import { describe, it, expect } from 'vitest';
import { isPlausibleHeardTime, resolveFirstHeard } from './firstHeard.js';

const NOW_MS = Date.UTC(2026, 8, 1);
const NOW_S = Math.floor(NOW_MS / 1000);

describe('isPlausibleHeardTime (#5390)', () => {
  it('accepts recent values in either unit', () => {
    expect(isPlausibleHeardTime(NOW_S - 60, 's', NOW_MS)).toBe(true);
    expect(isPlausibleHeardTime(NOW_MS - 60_000, 'ms', NOW_MS)).toBe(true);
  });

  it('rejects null, zero, seconds-since-boot, and far-future values', () => {
    expect(isPlausibleHeardTime(null, 's', NOW_MS)).toBe(false);
    expect(isPlausibleHeardTime(0, 's', NOW_MS)).toBe(false);
    expect(isPlausibleHeardTime(3600, 's', NOW_MS)).toBe(false);
    expect(isPlausibleHeardTime(NOW_S + 10 * 86_400, 's', NOW_MS)).toBe(false);
    expect(isPlausibleHeardTime(Date.UTC(2087, 0, 1), 'ms', NOW_MS)).toBe(false);
  });

  it('does not read a seconds value as ms (unit trap)', () => {
    expect(isPlausibleHeardTime(NOW_S, 'ms', NOW_MS)).toBe(false);
  });
});

describe('resolveFirstHeard (#5390)', () => {
  it('never changes an existing stamp', () => {
    expect(resolveFirstHeard(NOW_S - 1000, NOW_S - 10, NOW_S, 's', NOW_MS)).toBeUndefined();
  });

  it('stamps from the incoming lastHeard on a fresh row', () => {
    expect(resolveFirstHeard(null, null, NOW_S - 5, 's', NOW_MS)).toBe(NOW_S - 5);
  });

  it('prefers the older stored lastHeard when the row predates the column', () => {
    expect(resolveFirstHeard(null, NOW_S - 500, NOW_S, 's', NOW_MS)).toBe(NOW_S - 500);
  });

  it('skips implausible candidates and returns undefined when none remain', () => {
    expect(resolveFirstHeard(null, 42, NOW_S, 's', NOW_MS)).toBe(NOW_S);
    expect(resolveFirstHeard(null, null, 42, 's', NOW_MS)).toBeUndefined();
    expect(resolveFirstHeard(null, null, undefined, 'ms', NOW_MS)).toBeUndefined();
  });

  it('floors fractional seconds', () => {
    expect(resolveFirstHeard(null, null, NOW_S - 0.5, 's', NOW_MS)).toBe(NOW_S - 1);
  });
});
