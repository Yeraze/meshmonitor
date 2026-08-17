/**
 * Node Display defaults invariants (#4412 Phase 2 WP1).
 *
 * This module is the single source of truth for the ten Node Display keys'
 * hardcoded defaults and validation ranges. The whole point of WP1 is that
 * nothing else in the repo re-declares these literals, so the tests here
 * pin: the key list itself, agreement with migration 131's frozen seed
 * table, the stored-string convention (booleans are '0'/'1'), and the
 * parse/clamp helpers' behaviour on the edge cases the read-site conversion
 * (WP2-4) depends on.
 */
import { describe, it, expect } from 'vitest';
import {
  NODE_DISPLAY_SETTING_KEYS,
  NODE_DISPLAY_DEFAULT_STRINGS,
  NODE_DISPLAY_NUMERIC_DEFAULTS,
  NODE_DISPLAY_BOOLEAN_DEFAULTS,
  NODE_DISPLAY_RANGES,
  parseNodeDisplayNumber,
  parseNodeDisplayBoolean,
} from './nodeDisplayDefaults.js';
import { NODE_DISPLAY_SEED } from '../server/migrations/131_seed_per_source_node_display.js';
import {
  PER_SOURCE_SETTINGS_KEYS,
  VALID_SETTINGS_KEYS,
} from '../server/constants/settings.js';

describe('NODE_DISPLAY_SETTING_KEYS', () => {
  it('has exactly ten entries', () => {
    expect(NODE_DISPLAY_SETTING_KEYS.length).toBe(10);
  });

  it('has no duplicates', () => {
    expect(new Set(NODE_DISPLAY_SETTING_KEYS).size).toBe(NODE_DISPLAY_SETTING_KEYS.length);
  });

  it('is a subset of PER_SOURCE_SETTINGS_KEYS', () => {
    const perSource = new Set<string>(PER_SOURCE_SETTINGS_KEYS as readonly string[]);
    for (const key of NODE_DISPLAY_SETTING_KEYS) {
      expect(perSource.has(key)).toBe(true);
    }
  });

  it('is a subset of VALID_SETTINGS_KEYS', () => {
    const valid = new Set<string>(VALID_SETTINGS_KEYS as readonly string[]);
    for (const key of NODE_DISPLAY_SETTING_KEYS) {
      expect(valid.has(key)).toBe(true);
    }
  });
});

describe('NODE_DISPLAY_DEFAULT_STRINGS', () => {
  it('deep-equals migration 131\'s frozen NODE_DISPLAY_SEED table', () => {
    const seedAsRecord: Record<string, string> = Object.fromEntries(NODE_DISPLAY_SEED);
    expect(NODE_DISPLAY_DEFAULT_STRINGS).toEqual(seedAsRecord);
  });

  it('has an entry for every key in NODE_DISPLAY_SETTING_KEYS, and no extras', () => {
    const stringKeys = Object.keys(NODE_DISPLAY_DEFAULT_STRINGS).sort();
    expect(stringKeys).toEqual([...NODE_DISPLAY_SETTING_KEYS].sort());
  });

  it('stores booleans as \'0\'/\'1\', never \'false\'/\'true\'', () => {
    expect(NODE_DISPLAY_DEFAULT_STRINGS.hideIncompleteNodes).toBe('0');
    expect(NODE_DISPLAY_DEFAULT_STRINGS.nodeDimmingEnabled).toBe('0');
    expect(NODE_DISPLAY_DEFAULT_STRINGS.hideIncompleteNodes).not.toBe('false');
    expect(NODE_DISPLAY_DEFAULT_STRINGS.nodeDimmingEnabled).not.toBe('false');
  });
});

describe('parseNodeDisplayNumber', () => {
  const cases: Array<[raw: string | null | undefined, expected: number]> = [
    [null, 24],
    [undefined, 24],
    ['', 24],
    ['abc', 24],
    ['0', 24], // 0 is below maxNodeAgeHours' min of 1 -> clamps to default
    ['-5', 24], // negative is out of range -> clamps to default (NOT '-5' verbatim)
    ['24', 24],
    ['168', 168], // 1 week — still well within the 720h (30d) cap (#4770)
    ['720', 720], // upper bound, inclusive (30 days)
    ['721', 24], // above upper bound -> default
    ['1', 1], // lower bound, inclusive
  ];

  it.each(cases)('maxNodeAgeHours(%j) -> %j', (raw, expected) => {
    expect(parseNodeDisplayNumber('maxNodeAgeHours', raw)).toBe(expected);
  });

  it('localStatsIntervalMinutes: \'0\' resolves to 0, not clamped up to the default', () => {
    // localStatsIntervalMinutes' range is 0..60, so 0 is a legal, meaningful
    // value ("disabled") distinct from "unset". Must NOT collapse to 15.
    expect(parseNodeDisplayNumber('localStatsIntervalMinutes', '0')).toBe(0);
  });

  it('localStatsIntervalMinutes: negative and above-max clamp to the default (15)', () => {
    expect(parseNodeDisplayNumber('localStatsIntervalMinutes', '-1')).toBe(15);
    expect(parseNodeDisplayNumber('localStatsIntervalMinutes', '61')).toBe(15);
  });

  it('keys with no NODE_DISPLAY_RANGES entry are parsed but not bounds-checked', () => {
    expect(NODE_DISPLAY_RANGES.nodeDimmingStartHours).toBeUndefined();
    expect(NODE_DISPLAY_RANGES.nodeDimmingMinOpacity).toBeUndefined();
    expect(parseNodeDisplayNumber('nodeDimmingStartHours', '999')).toBe(999);
    expect(parseNodeDisplayNumber('nodeDimmingStartHours', '-5')).toBe(-5);
    expect(parseNodeDisplayNumber('nodeDimmingMinOpacity', '0.3')).toBe(0.3);
    expect(parseNodeDisplayNumber('nodeDimmingMinOpacity', null)).toBe(
      NODE_DISPLAY_NUMERIC_DEFAULTS.nodeDimmingMinOpacity,
    );
  });

  it('parses non-integer decimal values (e.g. nodeDimmingMinOpacity)', () => {
    expect(parseNodeDisplayNumber('nodeDimmingMinOpacity', '0.5')).toBe(0.5);
  });

  it('every default value in NODE_DISPLAY_NUMERIC_DEFAULTS is within its own range (or unranged)', () => {
    for (const [key, value] of Object.entries(NODE_DISPLAY_NUMERIC_DEFAULTS)) {
      const range = NODE_DISPLAY_RANGES[key as keyof typeof NODE_DISPLAY_NUMERIC_DEFAULTS];
      if (!range) continue;
      expect(value).toBeGreaterThanOrEqual(range.min);
      expect(value).toBeLessThanOrEqual(range.max);
    }
  });
});

describe('parseNodeDisplayBoolean', () => {
  it('parses \'1\' and \'true\' as true', () => {
    expect(parseNodeDisplayBoolean('hideIncompleteNodes', '1')).toBe(true);
    expect(parseNodeDisplayBoolean('hideIncompleteNodes', 'true')).toBe(true);
  });

  it('parses \'0\' and \'false\' as false', () => {
    expect(parseNodeDisplayBoolean('nodeDimmingEnabled', '0')).toBe(false);
    expect(parseNodeDisplayBoolean('nodeDimmingEnabled', 'false')).toBe(false);
  });

  it('anything else (null/undefined/garbage) resolves to the hardcoded default', () => {
    expect(parseNodeDisplayBoolean('hideIncompleteNodes', null)).toBe(
      NODE_DISPLAY_BOOLEAN_DEFAULTS.hideIncompleteNodes,
    );
    expect(parseNodeDisplayBoolean('hideIncompleteNodes', undefined)).toBe(
      NODE_DISPLAY_BOOLEAN_DEFAULTS.hideIncompleteNodes,
    );
    expect(parseNodeDisplayBoolean('nodeDimmingEnabled', 'garbage')).toBe(
      NODE_DISPLAY_BOOLEAN_DEFAULTS.nodeDimmingEnabled,
    );
  });

  it('both boolean defaults are false', () => {
    expect(NODE_DISPLAY_BOOLEAN_DEFAULTS.hideIncompleteNodes).toBe(false);
    expect(NODE_DISPLAY_BOOLEAN_DEFAULTS.nodeDimmingEnabled).toBe(false);
  });
});
