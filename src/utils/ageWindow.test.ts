import { describe, it, expect } from 'vitest';
import { formatAgeDuration, formatAgeWindow, isUnlimitedAgeWindow } from './ageWindow.js';

// Stand-in for i18next: interpolate {{vars}} into defaultValue.
const t = (_key: string, opts?: Record<string, unknown>): string => {
  const template = String(opts?.defaultValue ?? _key);
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''));
};

describe('isUnlimitedAgeWindow', () => {
  it('treats 0, negatives, NaN, Infinity, null and undefined as unlimited', () => {
    for (const v of [0, -1, NaN, Infinity, null, undefined]) {
      expect(isUnlimitedAgeWindow(v)).toBe(true);
    }
  });
  it('treats positive finite values as a real window', () => {
    expect(isUnlimitedAgeWindow(0.5)).toBe(false);
    expect(isUnlimitedAgeWindow(24)).toBe(false);
  });
});

describe('formatAgeDuration', () => {
  it('uses minutes below one hour', () => {
    expect(formatAgeDuration(0.5)).toBe('30m');
    expect(formatAgeDuration(0.25)).toBe('15m');
    expect(formatAgeDuration(0.001)).toBe('1m');
  });
  it('uses hours below two days', () => {
    expect(formatAgeDuration(1)).toBe('1h');
    expect(formatAgeDuration(6)).toBe('6h');
    expect(formatAgeDuration(24)).toBe('24h');
    expect(formatAgeDuration(47)).toBe('47h');
  });
  it('uses days from two days up', () => {
    expect(formatAgeDuration(48)).toBe('2d');
    expect(formatAgeDuration(72)).toBe('3d');
    expect(formatAgeDuration(720)).toBe('30d');
    expect(formatAgeDuration(54)).toBe('2d 6h');
  });
});

describe('formatAgeWindow', () => {
  it('reads "last <duration>" for a finite window', () => {
    expect(formatAgeWindow(24, t)).toBe('last 24h');
    expect(formatAgeWindow(0.5, t)).toBe('last 30m');
    expect(formatAgeWindow(72, t)).toBe('last 3d');
  });
  it('reads "all" when the window is unlimited', () => {
    expect(formatAgeWindow(0, t)).toBe('all');
    expect(formatAgeWindow(-5, t)).toBe('all');
    expect(formatAgeWindow(Infinity, t)).toBe('all');
    expect(formatAgeWindow(undefined, t)).toBe('all');
  });
  it('passes the localisation keys to t', () => {
    const keys: string[] = [];
    const spy = (key: string) => { keys.push(key); return key; };
    formatAgeWindow(6, spy);
    formatAgeWindow(0, spy);
    expect(keys).toEqual(['age_window.last', 'age_window.all']);
  });
});
