import { describe, it, expect } from 'vitest';
import { parseFirmwareVersion, isFirmwareAtLeast, isParsedFirmwareAtLeast } from './firmwareVersion';

/**
 * Consolidation reference table (see PR #5042).
 *
 * This module is now the single firmware-version parser in the codebase.
 * `MeshtasticManager.parseFirmwareVersion()` delegates here behind a
 * `^\d+\.\d+\.\d+` strictness pre-test that preserves its historical
 * contract; the four inputs the two disagree on are marked below, and the
 * stricter side is pinned by `meshtasticManager.favoritesSupport.test.ts`.
 * `compareVersions` in `src/server/utils/systemInfo.ts` is a different
 * operation (app-release comparator, -1/0/1) and is deliberately NOT
 * consolidated in.
 */
const EDGE_CASES: Array<{
  input: string | null | undefined;
  expected: { major: number; minor: number; patch: number } | null;
}> = [
  { input: '2.8.0', expected: { major: 2, minor: 8, patch: 0 } },
  { input: '2.8.0.abc1234', expected: { major: 2, minor: 8, patch: 0 } },
  { input: '2.8.0-rc1', expected: { major: 2, minor: 8, patch: 0 } },
  { input: '2.8.1.deadbe-beta', expected: { major: 2, minor: 8, patch: 1 } },
  { input: '2.10.0', expected: { major: 2, minor: 10, patch: 0 } },
  { input: '2.7.11', expected: { major: 2, minor: 7, patch: 11 } },
  // The manager's strict wrapper rejects these four; this parser accepts them.
  { input: 'v2.8.0', expected: { major: 2, minor: 8, patch: 0 } },
  { input: '  v2.8.0  ', expected: { major: 2, minor: 8, patch: 0 } },
  { input: '2.8', expected: { major: 2, minor: 8, patch: 0 } },
  { input: '3', expected: { major: 3, minor: 0, patch: 0 } },
  // Agreed rejections.
  { input: '', expected: null },
  { input: 'unknown', expected: null },
  { input: 'abc2.8.0', expected: null },
  // The manager's strict wrapper still throws on a non-string; this one does not.
  { input: undefined, expected: null },
  { input: null, expected: null },
];

describe('parseFirmwareVersion — edge-case table', () => {
  it.each(EDGE_CASES)('parses $input', ({ input, expected }) => {
    expect(parseFirmwareVersion(input)).toEqual(expected);
  });

  it('rejects a non-string that slipped past the type system', () => {
    expect(parseFirmwareVersion(123 as unknown as string)).toBeNull();
    expect(parseFirmwareVersion({} as unknown as string)).toBeNull();
  });
});

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

  it('agrees with the string overload for every table entry', () => {
    for (const { input, expected } of EDGE_CASES) {
      expect(isFirmwareAtLeast(input, 2, 8)).toBe(isParsedFirmwareAtLeast(expected, 2, 8));
    }
  });
});

describe('isParsedFirmwareAtLeast', () => {
  it('compares an already-parsed version', () => {
    expect(isParsedFirmwareAtLeast({ major: 2, minor: 8, patch: 0 }, 2, 8)).toBe(true);
    expect(isParsedFirmwareAtLeast({ major: 2, minor: 10, patch: 0 }, 2, 8)).toBe(true);
    expect(isParsedFirmwareAtLeast({ major: 3, minor: 0, patch: 0 }, 2, 8)).toBe(true);
    expect(isParsedFirmwareAtLeast({ major: 2, minor: 7, patch: 26 }, 2, 8)).toBe(false);
    expect(isParsedFirmwareAtLeast({ major: 1, minor: 9, patch: 9 }, 2, 8)).toBe(false);
  });

  it('honours the patch component', () => {
    expect(isParsedFirmwareAtLeast({ major: 2, minor: 7, patch: 19 }, 2, 7, 20)).toBe(false);
    expect(isParsedFirmwareAtLeast({ major: 2, minor: 7, patch: 20 }, 2, 7, 20)).toBe(true);
  });

  it('fails open (false) for a null parse', () => {
    expect(isParsedFirmwareAtLeast(null, 2, 8)).toBe(false);
  });
});
