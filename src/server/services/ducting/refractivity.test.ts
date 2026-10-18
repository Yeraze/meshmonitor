import { describe, it, expect } from 'vitest';
import {
  classifyGradient,
  indexColumn,
  refractivityN,
  saturationVapourPressureHPa,
  type ProfileLevel,
} from './refractivity.js';

const level = (heightM: number, pressureHPa: number, temperatureK: number, relativeHumidityPct: number): ProfileLevel => ({
  heightM,
  pressureHPa,
  temperatureK,
  relativeHumidityPct,
});

describe('refractivity (#5734)', () => {
  it('matches textbook values', () => {
    expect(saturationVapourPressureHPa(293.15)).toBeCloseTo(23.37, 1);
    // Dry air at sea level, 15 C: 77.6 * 1013.25 / 288.15 = 272.9 N.
    expect(refractivityN(level(0, 1013.25, 288.15, 0))).toBeCloseTo(272.9, 1);
    // Warm humid air reads far higher, which is why moisture drives ducts.
    expect(refractivityN(level(0, 1013, 303.15, 80))).toBeGreaterThan(390);
  });

  it('classifies gradients on the ITU-R P.453 bounds', () => {
    expect(classifyGradient(10)).toBe('sub-refractive');
    expect(classifyGradient(-40)).toBe('normal');
    expect(classifyGradient(-79)).toBe('super-refractive');
    expect(classifyGradient(-156.9)).toBe('super-refractive');
    expect(classifyGradient(-157)).toBe('ducting');
  });

  it('reads a well-mixed atmosphere as normal with no duct', () => {
    // Roughly standard lapse rates and slowly falling humidity.
    const col = indexColumn(
      [
        level(2, 1013, 288, 60),
        level(110, 1000, 287.3, 58),
        level(760, 925, 283, 55),
        level(1460, 850, 278.5, 50),
        level(3010, 700, 268.5, 45),
      ],
      0,
    )!;
    expect(col.class).toBe('normal');
    expect(col.ductStrengthM).toBe(0);
    expect(col.minGradientNPerKm).toBeGreaterThan(-79);
  });

  it('finds a duct under a warm, dry inversion over moist air', () => {
    const col = indexColumn(
      [level(2, 1013, 299, 90), level(110, 1000, 302, 25), level(760, 925, 298, 20), level(1460, 850, 292, 20)],
      0,
    )!;
    expect(col.class).toBe('ducting');
    expect(col.minGradientNPerKm).toBeLessThan(-157);
    expect(col.layerBaseM).toBe(2);
    expect(col.layerTopM).toBe(110);
    expect(col.ductStrengthM).toBeGreaterThan(0);
  });

  it('measures heights above ground and drops underground levels', () => {
    // Ground at 500 m: the 1000 hPa level (110 m) is underground.
    const col = indexColumn(
      [level(110, 1000, 290, 99), level(502, 955, 288, 60), level(760, 925, 286, 58), level(1460, 850, 281, 50)],
      500,
    )!;
    expect(col.layerBaseM).toBe(2);
  });

  it('ignores a layer thinner than 10 m', () => {
    const col = indexColumn([level(2, 1013, 299, 90), level(5, 1012.6, 302, 10), level(110, 1000, 298, 60)], 0)!;
    expect(col.layerBaseM).toBe(5);
  });

  it('returns null for a column with fewer than two usable levels', () => {
    expect(indexColumn([level(2, 1013, 288, 60), level(110, 1000, NaN, 50)], 0)).toBeNull();
  });
});
