import { describe, it, expect } from 'vitest';
import {
  normalizeTracerouteIntervalMinutes,
  parseTracerouteIntervalMinutes,
  recentTracerouteLimit,
  RECENT_TRACEROUTE_MIN_LIMIT,
} from './tracerouteInterval.js';

describe('parseTracerouteIntervalMinutes', () => {
  it('treats a missing value as off (0), not a hidden default', () => {
    expect(parseTracerouteIntervalMinutes(null)).toBe(0);
    expect(parseTracerouteIntervalMinutes(undefined)).toBe(0);
    expect(parseTracerouteIntervalMinutes('')).toBe(0);
  });

  it('treats an unreadable value as off', () => {
    expect(parseTracerouteIntervalMinutes('abc')).toBe(0);
  });

  it('passes a saved value through unchanged', () => {
    expect(parseTracerouteIntervalMinutes('0')).toBe(0);
    expect(parseTracerouteIntervalMinutes('3')).toBe(3);
    expect(parseTracerouteIntervalMinutes('15')).toBe(15);
    expect(parseTracerouteIntervalMinutes('60')).toBe(60);
  });
});

describe('recentTracerouteLimit', () => {
  it('sizes a missing value the same as a saved 0', () => {
    expect(recentTracerouteLimit(null, 24)).toBe(recentTracerouteLimit('0', 24));
    // 12/hour * 24h * 1.1
    expect(recentTracerouteLimit(null, 24)).toBe(317);
  });

  it('sizes from a saved interval', () => {
    // 60/3 = 20/hour * 24h * 1.1
    expect(recentTracerouteLimit('3', 24)).toBe(528);
    // 60/60 = 1/hour * 24h * 1.1 = 26.4 -> floor of 100
    expect(recentTracerouteLimit('60', 24)).toBe(RECENT_TRACEROUTE_MIN_LIMIT);
  });

  it('never returns less than the minimum', () => {
    expect(recentTracerouteLimit(null, 1)).toBe(RECENT_TRACEROUTE_MIN_LIMIT);
  });
});

describe('normalizeTracerouteIntervalMinutes', () => {
  it('keeps 0 (off) and 3–60', () => {
    expect(normalizeTracerouteIntervalMinutes(0)).toBe(0);
    expect(normalizeTracerouteIntervalMinutes(3)).toBe(3);
    expect(normalizeTracerouteIntervalMinutes(60)).toBe(60);
  });

  it('raises 1 and 2 to 3', () => {
    expect(normalizeTracerouteIntervalMinutes(1)).toBe(3);
    expect(normalizeTracerouteIntervalMinutes(2)).toBe(3);
  });

  it('rejects negatives, values over 60, fractions and NaN', () => {
    expect(normalizeTracerouteIntervalMinutes(-1)).toBeNull();
    expect(normalizeTracerouteIntervalMinutes(61)).toBeNull();
    expect(normalizeTracerouteIntervalMinutes(4.5)).toBeNull();
    expect(normalizeTracerouteIntervalMinutes(NaN)).toBeNull();
  });
});
