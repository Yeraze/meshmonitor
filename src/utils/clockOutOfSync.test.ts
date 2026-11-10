/**
 * Pure rules for trigger.clockOutOfSync (#6273).
 */
import { describe, it, expect } from 'vitest';
import {
  isClockOutOfSyncEdge,
  parseClockThresholdSeconds,
  clockOffsetText,
  clockDirection,
} from './clockOutOfSync';

const T = 300;

describe('isClockOutOfSyncEdge', () => {
  it('fires on the second consecutive bad sample (in, out, out)', () => {
    expect(isClockOutOfSyncEdge(900, [800, 5], T)).toBe(true);
  });
  it('does not fire again while the episode continues (out, out, out)', () => {
    expect(isClockOutOfSyncEdge(900, [800, 700], T)).toBe(false);
  });
  it('does not fire on a single bad sample after a good one (out, in, in)', () => {
    expect(isClockOutOfSyncEdge(900, [5, 4], T)).toBe(false);
  });
  it('re-arms after an in-sync sample (out, in, out, out fires again)', () => {
    expect(isClockOutOfSyncEdge(900, [800, 5], T)).toBe(true);
    expect(isClockOutOfSyncEdge(900, [5, 800], T)).toBe(false); // out after in: wait for the next
    expect(isClockOutOfSyncEdge(900, [800, 5], T)).toBe(true);
  });
  it('treats a missing previous sample as in sync, and needs two samples', () => {
    expect(isClockOutOfSyncEdge(900, [800], T)).toBe(true); // prev2 missing counts as in sync
    expect(isClockOutOfSyncEdge(900, [], T)).toBe(false);
  });
  it('is symmetric: ahead and behind both count, and the threshold itself does not', () => {
    expect(isClockOutOfSyncEdge(-900, [-800, 0], T)).toBe(true);
    expect(isClockOutOfSyncEdge(900, [-800, 0], T)).toBe(true);
    expect(isClockOutOfSyncEdge(300, [800, 0], T)).toBe(false);
    expect(isClockOutOfSyncEdge(301, [800, 0], T)).toBe(true);
  });
  it('ignores non-finite samples', () => {
    expect(isClockOutOfSyncEdge(NaN, [800, 0], T)).toBe(false);
    expect(isClockOutOfSyncEdge(900, [NaN, 0], T)).toBe(false);
  });
});

describe('parseClockThresholdSeconds', () => {
  it('accepts whole seconds from 120 to 86400', () => {
    expect(parseClockThresholdSeconds(120)).toBe(120);
    expect(parseClockThresholdSeconds('300')).toBe(300);
    expect(parseClockThresholdSeconds(86400)).toBe(86400);
  });
  it('rejects blank, out of range and fractional values', () => {
    for (const v of [undefined, null, '', 119, 86401, 300.5, 'abc', -5, 0]) {
      expect(parseClockThresholdSeconds(v)).toBeNull();
    }
  });
});

describe('clockOffsetText / clockDirection', () => {
  it('reads behind and ahead with a compact span', () => {
    expect(clockOffsetText(2 * 3600 + 14 * 60)).toBe('2h 14m behind');
    expect(clockOffsetText(-600)).toBe('10m ahead');
    expect(clockDirection(5)).toBe('behind');
    expect(clockDirection(-5)).toBe('ahead');
  });
  it('reads a clock a year or more off as "Clock not set"', () => {
    const decades = 20 * 365 * 86400;
    expect(clockOffsetText(decades)).toBe('Clock not set');
    expect(clockDirection(decades)).toBe('notSet');
    expect(clockDirection(-decades)).toBe('notSet');
  });
});
