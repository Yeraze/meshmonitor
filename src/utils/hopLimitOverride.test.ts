/**
 * Hop-limit override parsing and capping (#5121).
 */
import { describe, it, expect } from 'vitest';
import {
  HOP_LIMIT_OVERRIDE_MAX,
  clampHopLimitOverride,
  hopLimitSettingValue,
  parseHopLimitOverride,
} from './hopLimitOverride';

describe('parseHopLimitOverride', () => {
  it('reads every "inherit" spelling as undefined', () => {
    for (const raw of [undefined, null, '', 'inherit']) {
      expect(parseHopLimitOverride(raw)).toBeUndefined();
    }
  });

  it('accepts integers 0–7 as numbers or strings', () => {
    for (let n = 0; n <= HOP_LIMIT_OVERRIDE_MAX; n++) {
      expect(parseHopLimitOverride(n)).toBe(n);
      expect(parseHopLimitOverride(String(n))).toBe(n);
    }
  });

  it('keeps an explicit 0 — the most common override, not a falsy "unset"', () => {
    expect(parseHopLimitOverride(0)).toBe(0);
    expect(parseHopLimitOverride('0')).toBe(0);
  });

  it('treats out-of-range and non-integer values as inherit, never as an override', () => {
    for (const raw of [-1, 8, 99, 1.5, '2.5', 'abc', NaN, {}, []]) {
      expect(parseHopLimitOverride(raw)).toBeUndefined();
    }
  });
});

describe('clampHopLimitOverride', () => {
  it('leaves the packet unset when there is no override', () => {
    expect(clampHopLimitOverride(undefined, 3)).toBeUndefined();
  });

  it('passes an override at or below the device hop limit through', () => {
    expect(clampHopLimitOverride(0, 3)).toBe(0);
    expect(clampHopLimitOverride(2, 3)).toBe(2);
    expect(clampHopLimitOverride(3, 3)).toBe(3);
  });

  it('caps an override above the device hop limit — it can only shorten reach', () => {
    expect(clampHopLimitOverride(7, 3)).toBe(3);
    expect(clampHopLimitOverride(5, 4)).toBe(4);
  });

  it('never exceeds the protocol max even with a nonsense device value', () => {
    expect(clampHopLimitOverride(7, 42)).toBe(HOP_LIMIT_OVERRIDE_MAX);
  });
});

describe('hopLimitSettingValue', () => {
  it('maps inherit and malformed values to the empty string', () => {
    for (const raw of [undefined, null, '', 'inherit', '9', 'x']) {
      expect(hopLimitSettingValue(raw)).toBe('');
    }
  });

  it('round-trips a valid override to its string form', () => {
    expect(hopLimitSettingValue('0')).toBe('0');
    expect(hopLimitSettingValue(4)).toBe('4');
  });
});
