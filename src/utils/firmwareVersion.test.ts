import { describe, it, expect } from 'vitest';
import { parseFirmwareVersion, isFirmwareAtLeast } from './firmwareVersion';

describe('parseFirmwareVersion', () => {
  it('parses the canonical four-segment firmware string', () => {
    expect(parseFirmwareVersion('2.8.0.abcdef')).toEqual({ major: 2, minor: 8, patch: 0 });
  });

  it('parses a plain three-segment version', () => {
    expect(parseFirmwareVersion('2.7.11')).toEqual({ major: 2, minor: 7, patch: 11 });
  });

  it('ignores a pre-release suffix', () => {
    expect(parseFirmwareVersion('2.8.0-rc1')).toEqual({ major: 2, minor: 8, patch: 0 });
    expect(parseFirmwareVersion('2.8.1.deadbe-beta')).toEqual({ major: 2, minor: 8, patch: 1 });
  });

  it('tolerates a leading v and surrounding whitespace', () => {
    expect(parseFirmwareVersion('  v2.8.0  ')).toEqual({ major: 2, minor: 8, patch: 0 });
  });

  it('defaults missing minor/patch to zero', () => {
    expect(parseFirmwareVersion('3')).toEqual({ major: 3, minor: 0, patch: 0 });
    expect(parseFirmwareVersion('2.8')).toEqual({ major: 2, minor: 8, patch: 0 });
  });

  it('handles multi-digit minors without lexical confusion', () => {
    expect(parseFirmwareVersion('2.10.0')).toEqual({ major: 2, minor: 10, patch: 0 });
  });

  it('returns null for missing or unparseable input', () => {
    expect(parseFirmwareVersion(undefined)).toBeNull();
    expect(parseFirmwareVersion(null)).toBeNull();
    expect(parseFirmwareVersion('')).toBeNull();
    expect(parseFirmwareVersion('unknown')).toBeNull();
    expect(parseFirmwareVersion('abc2.8.0')).toBeNull();
    expect(parseFirmwareVersion(123 as unknown as string)).toBeNull();
  });
});

describe('isFirmwareAtLeast', () => {
  it('accepts an exact match and anything above', () => {
    expect(isFirmwareAtLeast('2.8.0.abcdef', 2, 8)).toBe(true);
    expect(isFirmwareAtLeast('2.8.4', 2, 8)).toBe(true);
    expect(isFirmwareAtLeast('2.9.0', 2, 8)).toBe(true);
    expect(isFirmwareAtLeast('3.0.0', 2, 8)).toBe(true);
  });

  it('rejects anything below', () => {
    expect(isFirmwareAtLeast('2.7.11.aabbcc', 2, 8)).toBe(false);
    expect(isFirmwareAtLeast('2.7.26.54e0d8d', 2, 8)).toBe(false);
    expect(isFirmwareAtLeast('1.9.9', 2, 8)).toBe(false);
  });

  it('compares minor numerically, not lexically', () => {
    // "2.10" < "2.8" as strings; must be true numerically.
    expect(isFirmwareAtLeast('2.10.0', 2, 8)).toBe(true);
  });

  it('honours the patch component', () => {
    expect(isFirmwareAtLeast('2.8.0', 2, 8, 1)).toBe(false);
    expect(isFirmwareAtLeast('2.8.1', 2, 8, 1)).toBe(true);
  });

  it('fails open (false) when the version is unknown', () => {
    expect(isFirmwareAtLeast(undefined, 2, 8)).toBe(false);
    expect(isFirmwareAtLeast(null, 2, 8)).toBe(false);
    expect(isFirmwareAtLeast('', 2, 8)).toBe(false);
    expect(isFirmwareAtLeast('unknown', 2, 8)).toBe(false);
  });
});
