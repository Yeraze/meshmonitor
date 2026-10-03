/**
 * ModemPreset mapping drift guard (#5546, #5547).
 *
 * `PRESET_MAP` turns a firmware-reported preset NAME into its wire value. The
 * Config tab used to resolve it as `PRESET_MAP[name] || 0`, so a name missing
 * here became LONG_FAST(0) — and the LoRa save is a whole-struct replace, so a
 * radio on TINY_FAST was loaded as LONG_FAST and saving any LoRa field pushed
 * LONG_FAST back to it. This file pins:
 *   - PRESET_MAP covers every ModemPreset the protobuf defines;
 *   - resolveModemPresetValue never turns an unknown name into 0;
 *   - the BW/SF/CR shown in the picker match the firmware switch, and every
 *     other per-preset table agrees with it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PRESET_MAP,
  MODEM_PRESET_OPTIONS,
  resolveModemPresetValue,
  getPresetBandwidthKHz,
} from './constants';
import { MODEM_PRESET_NAMES } from '../../utils/loraFrequency';
import { MODEM_PRESET_PARAMS } from '../../utils/linkBudget';

/** Name -> value, straight from `enum ModemPreset`. */
function protobufPresets(): Record<string, number> {
  const proto = readFileSync(resolve('protobufs/meshtastic/config.proto'), 'utf8');
  const block = /enum ModemPreset\s*\{([\s\S]*?)\n\s*\}\s*\n/.exec(proto); // annotation closers are `}];`, so a bare `}` line ends the enum
  expect(block, 'ModemPreset enum not found: did the protobuf layout change?').toBeTruthy();
  const out: Record<string, number> = {};
  // Entries carry multi-line `[(meshtastic.enum_value_metadata) = {...}]`
  // annotations, so match only the `NAME = N` head of each entry. Comment
  // lines inside the block start with `*` and never match.
  for (const m of block![1].matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(\d+)\b/gm)) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

/**
 * Firmware `modemPresetToParams()` (src/mesh/MeshRadio.h), sub-GHz branch,
 * transcribed from meshtastic/firmware v2.8.1.8e6a88d / develop on 2026-10-03.
 * Value -> [bandwidth kHz, SF, CR denominator].
 */
const FIRMWARE_PARAMS: Record<number, [number, number, number]> = {
  0: [250, 11, 5],   // LONG_FAST
  1: [125, 12, 8],   // LONG_SLOW
  3: [250, 10, 5],   // MEDIUM_SLOW
  4: [250, 9, 5],    // MEDIUM_FAST
  5: [250, 8, 5],    // SHORT_SLOW
  6: [250, 7, 5],    // SHORT_FAST
  7: [125, 11, 8],   // LONG_MODERATE
  8: [500, 7, 5],    // SHORT_TURBO
  9: [500, 11, 8],   // LONG_TURBO (#5546: CR 4/8)
  10: [125, 9, 5],   // LITE_FAST
  11: [125, 10, 5],  // LITE_SLOW
  12: [62.5, 7, 6],  // NARROW_FAST
  13: [62.5, 8, 6],  // NARROW_SLOW
  14: [15.6, 7, 5],  // TINY_FAST
  15: [15.6, 8, 6],  // TINY_SLOW
  16: [500, 9, 5],   // MEDIUM_TURBO
};

describe('ModemPreset enum coverage', () => {
  it('parses a plausible enum', () => {
    const pb = protobufPresets();
    // Guards the guard: a parse that stops early would make the coverage checks pass vacuously.
    expect(Object.keys(pb).length).toBeGreaterThanOrEqual(17);
    expect(pb.LONG_FAST).toBe(0);
    expect(pb.TINY_FAST).toBe(14);
    expect(pb.TINY_SLOW).toBe(15);
    expect(pb.MEDIUM_TURBO).toBe(16);
  });

  it('PRESET_MAP resolves every preset name a device can report, to the right value', () => {
    const pb = protobufPresets();
    for (const [name, value] of Object.entries(pb)) {
      expect(PRESET_MAP[name], `PRESET_MAP is missing ${name}`).toBe(value);
    }
  });

  it('MODEM_PRESET_OPTIONS offers every non-deprecated protobuf preset at its wire value', () => {
    const pb = protobufPresets();
    const offered = new Map(MODEM_PRESET_OPTIONS.map((o) => [o.name, o.value]));
    for (const [name, value] of Object.entries(pb)) {
      if (name === 'VERY_LONG_SLOW') continue; // deprecated upstream, not offered
      expect(offered.get(name), `picker is missing ${name}`).toBe(value);
    }
  });

  it('MODEM_PRESET_NAMES agrees with the protobuf', () => {
    const pb = protobufPresets();
    for (const [name, value] of Object.entries(pb)) {
      expect(MODEM_PRESET_NAMES[value]).toBe(name);
    }
  });
});

describe('preset parameters match the firmware switch', () => {
  const parseParams = (params: string) => {
    const m = /^BW: ([\d.]+)kHz, SF: (\d+), CR: 4\/(\d)$/.exec(params);
    expect(m, `unparseable params "${params}"`).toBeTruthy();
    return [Number(m![1]), Number(m![2]), Number(m![3])];
  };

  it('every picker entry shows the firmware BW / SF / CR', () => {
    for (const opt of MODEM_PRESET_OPTIONS) {
      expect(parseParams(opt.params), opt.name).toEqual(FIRMWARE_PARAMS[opt.value]);
    }
  });

  it('LONG_TURBO shows CR 4/8 (#5546)', () => {
    expect(MODEM_PRESET_OPTIONS.find((o) => o.name === 'LONG_TURBO')!.params).toBe('BW: 500kHz, SF: 11, CR: 4/8');
  });

  it('the bandwidth table used for legality and slot math agrees', () => {
    for (const [value, [bw]] of Object.entries(FIRMWARE_PARAMS)) {
      expect(getPresetBandwidthKHz(Number(value), false), `preset ${value}`).toBe(bw);
    }
  });

  it('the link-budget table agrees', () => {
    for (const [value, [bw, sf]] of Object.entries(FIRMWARE_PARAMS)) {
      expect(MODEM_PRESET_PARAMS[Number(value)], `preset ${value}`).toEqual({ sf, bwKhz: bw });
    }
  });
});

describe('resolveModemPresetValue', () => {
  it('resolves TINY_FAST to 14, never to LONG_FAST (#5547 regression)', () => {
    expect(resolveModemPresetValue('TINY_FAST')).toBe(14);
    expect(resolveModemPresetValue('TINY_SLOW')).toBe(15);
    expect(resolveModemPresetValue(14)).toBe(14);
  });

  it('resolves LONG_FAST to 0 by name and number', () => {
    expect(resolveModemPresetValue('LONG_FAST')).toBe(0);
    expect(resolveModemPresetValue(0)).toBe(0);
  });

  it('passes through numbers this build does not name, so they round-trip', () => {
    expect(resolveModemPresetValue(17)).toBe(17);
    expect(resolveModemPresetValue('17')).toBe(17);
  });

  it('returns null, not 0, for anything it cannot resolve', () => {
    expect(resolveModemPresetValue('HYPER_FAST')).toBeNull();
    expect(resolveModemPresetValue('')).toBeNull();
    expect(resolveModemPresetValue('toString')).toBeNull(); // prototype keys are not presets
    expect(resolveModemPresetValue(-1)).toBeNull();
    expect(resolveModemPresetValue(1.5)).toBeNull();
    expect(resolveModemPresetValue(null)).toBeNull();
    expect(resolveModemPresetValue(undefined)).toBeNull();
    expect(resolveModemPresetValue({})).toBeNull();
  });
});
