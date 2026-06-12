import { describe, it, expect } from 'vitest';
import { effectiveMapMaxAgeHours } from './mapAge';

describe('effectiveMapMaxAgeHours', () => {
  it('follows the settings max when the slider is unset (null)', () => {
    expect(effectiveMapMaxAgeHours(null, 24)).toBe(24);
    expect(effectiveMapMaxAgeHours(undefined, 48)).toBe(48);
  });

  it('uses the slider value when it is within range', () => {
    expect(effectiveMapMaxAgeHours(6, 24)).toBe(6);
    expect(effectiveMapMaxAgeHours(1, 24)).toBe(1);
    expect(effectiveMapMaxAgeHours(24, 24)).toBe(24);
  });

  it('clamps a slider value above the settings max', () => {
    // e.g. settings lowered from 48 to 12 after a 30h value was saved
    expect(effectiveMapMaxAgeHours(30, 12)).toBe(12);
  });

  it('clamps a slider value below 1 hour', () => {
    expect(effectiveMapMaxAgeHours(0, 24)).toBe(1);
    expect(effectiveMapMaxAgeHours(-5, 24)).toBe(1);
  });

  it('never returns less than 1 even if settings max is invalid', () => {
    expect(effectiveMapMaxAgeHours(null, 0)).toBe(1);
    expect(effectiveMapMaxAgeHours(10, 0)).toBe(1);
  });

  it('ignores non-finite slider values', () => {
    expect(effectiveMapMaxAgeHours(NaN, 24)).toBe(24);
    expect(effectiveMapMaxAgeHours(Infinity, 24)).toBe(24);
  });
});
