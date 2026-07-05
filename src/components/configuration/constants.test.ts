import { describe, it, expect } from 'vitest';
import { REGION_OPTIONS } from './constants';

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
