import { describe, it, expect } from 'vitest';
import {
  EXCLUDED_MODULE_KEYS,
  isModuleExcluded,
  moduleAvailabilityFromMask,
  readExcludedModules,
} from './excludedModules.js';

describe('readExcludedModules (#5065)', () => {
  it('reads the camelCase and snake_case field names', () => {
    expect(readExcludedModules({ excludedModules: 0x0010 })).toBe(0x0010);
    expect(readExcludedModules({ excluded_modules: 0x21 })).toBe(0x21);
  });

  it('keeps an explicit zero, which means nothing is excluded', () => {
    expect(readExcludedModules({ excludedModules: 0 })).toBe(0);
  });

  it('returns undefined when the device never reported the field', () => {
    expect(readExcludedModules({ firmwareVersion: '2.7.4' })).toBeUndefined();
    expect(readExcludedModules({ excludedModules: null })).toBeUndefined();
    expect(readExcludedModules({ excludedModules: -1 })).toBeUndefined();
    expect(readExcludedModules(null)).toBeUndefined();
  });
});

describe('isModuleExcluded (#5065)', () => {
  it('reads one bit out of the mask', () => {
    const mask = 0x0010 | 0x1000; // range test + paxcounter
    expect(isModuleExcluded(mask, 'rangetest')).toBe(true);
    expect(isModuleExcluded(mask, 'paxcounter')).toBe(true);
    expect(isModuleExcluded(mask, 'mqtt')).toBe(false);
  });

  it('fails open on an unknown mask', () => {
    for (const key of EXCLUDED_MODULE_KEYS) {
      expect(isModuleExcluded(undefined, key)).toBe(false);
      expect(isModuleExcluded(null, key)).toBe(false);
      expect(isModuleExcluded(0, key)).toBe(false);
    }
  });
});

describe('moduleAvailabilityFromMask (#5065)', () => {
  it('marks only the excluded modules unavailable', () => {
    const availability = moduleAvailabilityFromMask(0x0001 | 0x4000); // mqtt + network
    expect(availability.mqtt).toBe(false);
    expect(availability.network).toBe(false);
    expect(availability.telemetry).toBe(true);
    expect(Object.keys(availability).sort()).toEqual([...EXCLUDED_MODULE_KEYS].sort());
  });

  it('reports everything available when the device says nothing', () => {
    const availability = moduleAvailabilityFromMask(undefined);
    expect(Object.values(availability).every(Boolean)).toBe(true);
  });

  it('covers all 15 bits from the protobuf enum', () => {
    expect(EXCLUDED_MODULE_KEYS).toHaveLength(15);
  });
});
