import { describe, it, expect } from 'vitest';
import {
  REGION_OPTIONS,
  MODEM_PRESET_OPTIONS,
  getPresetBandwidthKHz,
  isPresetLegalForRegion,
  getLegalPresetOptions,
  getPresetIllegalReason,
  REGION_PRESET_ALLOWLIST_28,
  FIRMWARE_28_ONLY_PRESETS,
  LORA_CUSTOM_RECIPES,
  getRecipeIllegalReason
} from './constants';

// RegionCode values used below (see REGION_OPTIONS / config.proto).
const US = 1;
const EU_868 = 3;
const RU = 9;
const LORA_24 = 13;
const ITU1_2M = 27;
const ITU2_2M = 28;
const EU_866 = 29;
const EU_874 = 30; // in the protobuf, not defined by firmware -> unconstrained
const EU_N_868 = 32;
const ITU3_2M = 33;
const ITU1_70CM = 34;
const ITU2_125CM = 37;
const UNSET = 0;

const FW27 = '2.7.26.54e0d8d';
const FW28 = '2.8.1.8e6a88d';

// ModemPreset values (see MODEM_PRESET_OPTIONS / PRESET_MAP).
const LONG_FAST = 0;
const LONG_SLOW = 1;
const LONG_MODERATE = 7;
const SHORT_TURBO = 8;
const LONG_TURBO = 9;
const LITE_FAST = 10;
const LITE_SLOW = 11;
const NARROW_FAST = 12;
const NARROW_SLOW = 13;
const TINY_FAST = 14;
const TINY_SLOW = 15;
const MEDIUM_TURBO = 16;
const STANDARD_PRESETS = [0, 1, 3, 4, 5, 6, 7, 8, 9, 16];

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
    expect(getPresetBandwidthKHz(MEDIUM_TURBO, false)).toBe(500);
  });

  it('returns wide-LoRa bandwidths for the 2.4 GHz band', () => {
    expect(getPresetBandwidthKHz(LONG_FAST, true)).toBe(812.5);
    expect(getPresetBandwidthKHz(SHORT_TURBO, true)).toBe(1625);
    expect(getPresetBandwidthKHz(MEDIUM_TURBO, true)).toBe(1625);
  });

  it('returns the firmware 2.8 bandwidths for LITE / NARROW / TINY, unwidened on 2.4 GHz (#5547)', () => {
    expect(getPresetBandwidthKHz(LITE_FAST, false)).toBe(125);
    expect(getPresetBandwidthKHz(LITE_SLOW, false)).toBe(125);
    expect(getPresetBandwidthKHz(NARROW_FAST, false)).toBe(62.5);
    expect(getPresetBandwidthKHz(NARROW_SLOW, false)).toBe(62.5);
    expect(getPresetBandwidthKHz(TINY_FAST, false)).toBe(15.6);
    expect(getPresetBandwidthKHz(TINY_SLOW, false)).toBe(15.6);
    expect(getPresetBandwidthKHz(TINY_FAST, true)).toBe(15.6);
  });

  it('falls back to LONG_FAST (250 kHz) for presets not in the firmware switch', () => {
    expect(getPresetBandwidthKHz(999, false)).toBe(250);
    expect(getPresetBandwidthKHz(999, true)).toBe(812.5);
  });
});

describe('isPresetLegalForRegion: firmware < 2.8 (span check only)', () => {
  it('EU_868 (0.25 MHz span) rejects the 500 kHz presets', () => {
    expect(isPresetLegalForRegion(EU_868, SHORT_TURBO, FW27)).toBe(false);
    expect(isPresetLegalForRegion(EU_868, LONG_TURBO, FW27)).toBe(false);
    expect(getPresetIllegalReason(EU_868, LONG_TURBO, FW27)).toBe('bandwidth');
  });

  it('EU_868 still allows presets that fit (<= 250 kHz)', () => {
    expect(isPresetLegalForRegion(EU_868, LONG_FAST, FW27)).toBe(true);
    expect(isPresetLegalForRegion(EU_868, LONG_SLOW, FW27)).toBe(true);
  });

  it('RU (exactly 0.5 MHz span) allows the 500 kHz presets', () => {
    expect(isPresetLegalForRegion(RU, SHORT_TURBO, FW27)).toBe(true);
    expect(isPresetLegalForRegion(RU, LONG_TURBO, FW27)).toBe(true);
  });

  it('hides every 2.8-only preset (LITE, NARROW, TINY, MEDIUM_TURBO) in every region', () => {
    for (const region of [UNSET, US, EU_868, LORA_24, ITU2_2M, EU_866, null]) {
      for (const preset of FIRMWARE_28_ONLY_PRESETS) {
        expect(getPresetIllegalReason(region, preset, FW27)).toBe('firmware');
      }
    }
  });

  it('wide US band allows every pre-2.8 preset', () => {
    for (const opt of MODEM_PRESET_OPTIONS.filter((o) => !FIRMWARE_28_ONLY_PRESETS.has(o.value))) {
      expect(isPresetLegalForRegion(US, opt.value, FW27)).toBe(true);
    }
  });
});

describe('isPresetLegalForRegion: firmware 2.8 region allow-lists (#5547)', () => {
  const allValues = MODEM_PRESET_OPTIONS.map((o) => o.value);
  const legalIn = (region: number, fw: string | null = FW28) =>
    allValues.filter((v) => isPresetLegalForRegion(region, v, fw));

  it('standard regions get exactly the ten standard presets', () => {
    for (const region of [US, 2, 4, 5, 6, 7, 8, RU, 10, 11, 12, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]) {
      expect(legalIn(region)).toEqual(STANDARD_PRESETS);
    }
  });

  it('LORA_24 is a standard region with wide bandwidths', () => {
    expect(legalIn(LORA_24)).toEqual(STANDARD_PRESETS);
  });

  it('EU_868 gets the seven presets up to 250 kHz', () => {
    expect(legalIn(EU_868)).toEqual([0, 1, 3, 4, 5, 6, 7]);
    expect(getPresetIllegalReason(EU_868, MEDIUM_TURBO, FW28)).toBe('region');
  });

  it('EU_866 gets LITE_* only', () => {
    expect(legalIn(EU_866)).toEqual([LITE_FAST, LITE_SLOW]);
  });

  it('EU_N_868 gets NARROW_* only', () => {
    expect(legalIn(EU_N_868)).toEqual([NARROW_FAST, NARROW_SLOW]);
  });

  it('every ITU 2m region gets TINY_* only', () => {
    for (const region of [ITU1_2M, ITU2_2M, ITU3_2M]) {
      expect(legalIn(region)).toEqual([TINY_FAST, TINY_SLOW]);
    }
    expect(getPresetIllegalReason(ITU2_2M, LONG_FAST, FW28)).toBe('region');
  });

  it('ITU 70cm and 1.25m regions get NARROW_* only', () => {
    for (const region of [ITU1_70CM, 35, 36, ITU2_125CM]) {
      expect(legalIn(region)).toEqual([NARROW_FAST, NARROW_SLOW]);
    }
  });

  it('TINY_* is legal nowhere but the 2m bands', () => {
    for (const [region, list] of Object.entries(REGION_PRESET_ALLOWLIST_28)) {
      const has = list.includes(TINY_FAST);
      expect(has, `region ${region}`).toBe([ITU1_2M, ITU2_2M, ITU3_2M].includes(Number(region)));
    }
  });

  it('UNSET, the deprecated UA_868 and firmware-undefined regions are unconstrained', () => {
    expect(legalIn(UNSET)).toEqual(allValues);
    expect(legalIn(EU_874)).toEqual(allValues);
    expect(isPresetLegalForRegion(15, TINY_FAST, FW28)).toBe(true); // UA_868
  });

  it('an unknown firmware version uses the 2.8 rule', () => {
    for (const fw of [null, undefined, '', 'garbage']) {
      expect(legalIn(ITU2_2M, fw as string | null)).toEqual([TINY_FAST, TINY_SLOW]);
      expect(isPresetLegalForRegion(US, TINY_FAST, fw)).toBe(false);
      expect(isPresetLegalForRegion(US, MEDIUM_TURBO, fw)).toBe(true);
    }
    // No firmware argument at all behaves the same.
    expect(isPresetLegalForRegion(ITU2_2M, LONG_FAST)).toBe(false);
  });

  it('a 2.9 or 3.x firmware keeps the 2.8 rule', () => {
    expect(legalIn(ITU2_2M, '2.9.0')).toEqual([TINY_FAST, TINY_SLOW]);
    expect(legalIn(ITU2_2M, '3.0.0')).toEqual([TINY_FAST, TINY_SLOW]);
  });

  it('null/undefined region is unconstrained', () => {
    expect(isPresetLegalForRegion(null, SHORT_TURBO, FW28)).toBe(true);
    expect(isPresetLegalForRegion(undefined, TINY_FAST, FW28)).toBe(true);
  });
});

describe('getLegalPresetOptions', () => {
  it('drops the 500 kHz presets for EU_868', () => {
    const values = getLegalPresetOptions(EU_868, LONG_FAST).map((o) => o.value);
    expect(values).not.toContain(SHORT_TURBO);
    expect(values).not.toContain(LONG_TURBO);
    expect(values).not.toContain(MEDIUM_TURBO);
    expect(values).toContain(LONG_FAST);
  });

  it('returns the standard presets for US on 2.8', () => {
    expect(getLegalPresetOptions(US, LONG_FAST, FW28).map((o) => o.value)).toEqual(STANDARD_PRESETS);
  });

  it('returns only TINY_* for an ITU 2m region on 2.8', () => {
    expect(getLegalPresetOptions(ITU2_2M, TINY_FAST, FW28).map((o) => o.name)).toEqual(['TINY_FAST', 'TINY_SLOW']);
  });

  it('retains an illegal current preset so the picker is never blank', () => {
    const values = getLegalPresetOptions(EU_868, SHORT_TURBO).map((o) => o.value);
    expect(values).toContain(SHORT_TURBO); // illegal but currently selected -> kept
    expect(values).not.toContain(LONG_TURBO); // illegal and not selected -> dropped
  });

  it('retains a 2.8-only current preset on 2.7 firmware', () => {
    const values = getLegalPresetOptions(US, TINY_FAST, FW27).map((o) => o.value);
    expect(values).toContain(TINY_FAST);
    expect(values).not.toContain(TINY_SLOW);
  });

  it('preserves MODEM_PRESET_OPTIONS ordering', () => {
    const legal = getLegalPresetOptions(UNSET);
    const order = MODEM_PRESET_OPTIONS.map((o) => o.value);
    expect(legal.map((o) => o.value)).toEqual(order);
  });
});

describe('custom recipes (#5548)', () => {
  const longModTurbo = LORA_CUSTOM_RECIPES.find((r) => r.name === 'LongModTurbo')!;

  it('ships only LongModTurbo, at 500 kHz / SF11 / CR 4/8', () => {
    expect(LORA_CUSTOM_RECIPES.map((r) => r.name)).toEqual(['LongModTurbo']);
    expect(longModTurbo).toMatchObject({ bandwidthKHz: 500, spreadFactor: 11, codingRate: 8 });
  });

  it('is legal where 500 kHz presets are', () => {
    for (const fw of [FW27, FW28, null]) {
      expect(getRecipeIllegalReason(US, longModTurbo, fw)).toBeNull();
      expect(getRecipeIllegalReason(RU, longModTurbo, fw)).toBeNull();
      expect(getRecipeIllegalReason(LORA_24, longModTurbo, fw)).toBeNull();
    }
  });

  it('is rejected by the span check in EU_868 on any firmware', () => {
    expect(getRecipeIllegalReason(EU_868, longModTurbo, FW27)).toBe('bandwidth');
    // On 2.8 the region rule (widest EU_868 preset is 250 kHz) trips first.
    expect(getRecipeIllegalReason(EU_868, longModTurbo, FW28)).toBe('region');
  });

  it('on 2.8 is rejected where the widest official preset is narrower', () => {
    for (const region of [EU_866, EU_N_868, ITU1_2M, ITU2_2M, ITU3_2M, ITU1_70CM, ITU2_125CM]) {
      expect(getRecipeIllegalReason(region, longModTurbo, FW28), `region ${region}`).toBe('region');
    }
  });

  it('is unconstrained for an unset region', () => {
    expect(getRecipeIllegalReason(UNSET, longModTurbo, FW28)).toBeNull();
    expect(getRecipeIllegalReason(null, longModTurbo, FW28)).toBeNull();
  });
});
