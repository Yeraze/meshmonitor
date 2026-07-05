import { describe, it, expect } from 'vitest';
import {
  REGION_OPTIONS,
  MODEM_PRESET_OPTIONS,
  getPresetBandwidthKHz,
  isPresetLegalForRegion,
  getLegalPresetOptions
} from './constants';

// RegionCode values used below (see REGION_OPTIONS / config.proto).
const US = 1;
const EU_868 = 3;
const RU = 9;
const LORA_24 = 13;
const ITU3_2M = 33; // firmware develop-branch region: bounds not in table -> permissive

// ModemPreset values (see MODEM_PRESET_OPTIONS / PRESET_MAP).
const LONG_FAST = 0;
const LONG_SLOW = 1;
const LONG_MODERATE = 7;
const SHORT_TURBO = 8;
const LONG_TURBO = 9;
const NARROW_FAST = 12; // not in firmware switch -> LONG_FAST/250 kHz fallback

// Guards against RegionCode drift from meshtastic/protobufs config.proto (#3927).
// When upstream adds a RegionCode value, extend REGION_OPTIONS and bump the max here.
describe('REGION_OPTIONS', () => {
  const HIGHEST_REGION_CODE = 37; // ITU2_125CM — keep in sync with config.proto enum RegionCode

  it('covers contiguous RegionCode values 0..HIGHEST_REGION_CODE with no gaps or dupes', () => {
    const values = REGION_OPTIONS.map((o) => o.value).sort((a, b) => a - b);
    expect(values).toEqual(Array.from({ length: HIGHEST_REGION_CODE + 1 }, (_, i) => i));
  });

  it('every option has a non-empty "NAME - description" label', () => {
    for (const o of REGION_OPTIONS) {
      expect(o.label).toMatch(/^\S+ - .+/);
    }
  });

  it('uses the upstream enum name ITU2_2M for value 28 (not the old ITU23_2M)', () => {
    const v28 = REGION_OPTIONS.find((o) => o.value === 28);
    expect(v28?.label.startsWith('ITU2_2M -')).toBe(true);
  });

  it('includes the ITU amateur regions 33-37 added in #3927', () => {
    const byValue = new Map(REGION_OPTIONS.map((o) => [o.value, o.label]));
    expect(byValue.get(33)?.startsWith('ITU3_2M')).toBe(true);
    expect(byValue.get(34)?.startsWith('ITU1_70CM')).toBe(true);
    expect(byValue.get(35)?.startsWith('ITU2_70CM')).toBe(true);
    expect(byValue.get(36)?.startsWith('ITU3_70CM')).toBe(true);
    expect(byValue.get(37)?.startsWith('ITU2_125CM')).toBe(true);
  });
});

// Region -> modem-preset legality (issue #3924, Part 1). Mirrors firmware's
// `(freqEnd - freqStart) >= presetBandwidthKHz/1000` fit-check.
describe('getPresetBandwidthKHz', () => {
  it('returns firmware bandwidths for known presets (normal bands)', () => {
    expect(getPresetBandwidthKHz(LONG_FAST, false)).toBe(250);
    expect(getPresetBandwidthKHz(LONG_SLOW, false)).toBe(125);
    expect(getPresetBandwidthKHz(LONG_MODERATE, false)).toBe(125);
    expect(getPresetBandwidthKHz(SHORT_TURBO, false)).toBe(500);
    expect(getPresetBandwidthKHz(LONG_TURBO, false)).toBe(500);
  });

  it('returns wide-LoRa bandwidths for the 2.4 GHz band', () => {
    expect(getPresetBandwidthKHz(LONG_FAST, true)).toBe(812.5);
    expect(getPresetBandwidthKHz(SHORT_TURBO, true)).toBe(1625);
  });

  it('falls back to LONG_FAST (250 kHz) for presets not in the firmware switch', () => {
    expect(getPresetBandwidthKHz(NARROW_FAST, false)).toBe(250);
    expect(getPresetBandwidthKHz(999, false)).toBe(250);
    expect(getPresetBandwidthKHz(NARROW_FAST, true)).toBe(812.5);
  });
});

describe('isPresetLegalForRegion', () => {
  it('EU_868 (0.25 MHz span) rejects the two 500 kHz presets', () => {
    expect(isPresetLegalForRegion(EU_868, SHORT_TURBO)).toBe(false);
    expect(isPresetLegalForRegion(EU_868, LONG_TURBO)).toBe(false);
  });

  it('EU_868 still allows presets that fit (<= 250 kHz)', () => {
    expect(isPresetLegalForRegion(EU_868, LONG_FAST)).toBe(true);
    expect(isPresetLegalForRegion(EU_868, LONG_SLOW)).toBe(true);
    expect(isPresetLegalForRegion(EU_868, NARROW_FAST)).toBe(true); // fallback 250 <= 250
  });

  it('RU (exactly 0.5 MHz span) allows the 500 kHz presets', () => {
    expect(isPresetLegalForRegion(RU, SHORT_TURBO)).toBe(true);
    expect(isPresetLegalForRegion(RU, LONG_TURBO)).toBe(true);
  });

  it('wide US band allows every preset', () => {
    for (const opt of MODEM_PRESET_OPTIONS) {
      expect(isPresetLegalForRegion(US, opt.value)).toBe(true);
    }
  });

  it('LORA_24 uses wide bandwidths but its 83.5 MHz span allows every preset', () => {
    for (const opt of MODEM_PRESET_OPTIONS) {
      expect(isPresetLegalForRegion(LORA_24, opt.value)).toBe(true);
    }
  });

  it('is permissive for regions with unknown bounds and for null/undefined', () => {
    for (const opt of MODEM_PRESET_OPTIONS) {
      expect(isPresetLegalForRegion(ITU3_2M, opt.value)).toBe(true);
    }
    expect(isPresetLegalForRegion(null, SHORT_TURBO)).toBe(true);
    expect(isPresetLegalForRegion(undefined, SHORT_TURBO)).toBe(true);
  });
});

describe('getLegalPresetOptions', () => {
  it('drops the 500 kHz presets for EU_868', () => {
    const values = getLegalPresetOptions(EU_868, LONG_FAST).map((o) => o.value);
    expect(values).not.toContain(SHORT_TURBO);
    expect(values).not.toContain(LONG_TURBO);
    expect(values).toContain(LONG_FAST);
  });

  it('returns every preset for a wide region', () => {
    expect(getLegalPresetOptions(US, LONG_FAST)).toHaveLength(MODEM_PRESET_OPTIONS.length);
  });

  it('retains an illegal current preset so the picker is never blank', () => {
    const values = getLegalPresetOptions(EU_868, SHORT_TURBO).map((o) => o.value);
    expect(values).toContain(SHORT_TURBO); // illegal but currently selected -> kept
    expect(values).not.toContain(LONG_TURBO); // illegal and not selected -> dropped
  });

  it('preserves MODEM_PRESET_OPTIONS ordering', () => {
    const legal = getLegalPresetOptions(US);
    const order = MODEM_PRESET_OPTIONS.map((o) => o.value);
    expect(legal.map((o) => o.value)).toEqual(order);
  });
});
