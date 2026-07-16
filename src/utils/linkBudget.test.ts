import { describe, it, expect } from 'vitest';
import {
  wavelengthMeters,
  fresnelRadiusMeters,
  fsplDb,
  earthBulgeMeters,
  computeLinkBudget,
} from './linkBudget';

describe('wavelengthMeters', () => {
  it('computes wavelength for 915 MHz', () => {
    expect(wavelengthMeters(915)).toBeCloseTo(0.32764, 4);
  });
});

describe('fsplDb', () => {
  it('matches the locked reference: 33.3 km @ 915 MHz', () => {
    expect(fsplDb(33.3, 915)).toBeCloseTo(122.117, 2);
  });

  it('matches the locked reference: 1 km @ 100 MHz (clean 0+40+32.44)', () => {
    expect(fsplDb(1, 100)).toBeCloseTo(72.44, 2);
  });

  it('matches the locked reference: 10 km @ 915 MHz', () => {
    expect(fsplDb(10, 915)).toBeCloseTo(111.668, 2);
  });

  it('returns 0 for zero distance (degenerate/coincident points)', () => {
    expect(fsplDb(0, 915)).toBe(0);
  });

  it('returns 0 for negative distance', () => {
    expect(fsplDb(-5, 915)).toBe(0);
  });

  it('returns 0 for non-positive frequency', () => {
    expect(fsplDb(10, 0)).toBe(0);
    expect(fsplDb(10, -915)).toBe(0);
  });
});

describe('fresnelRadiusMeters', () => {
  it('matches the locked reference: midpoint of a 10km link @ 915 MHz', () => {
    expect(fresnelRadiusMeters(1, 915, 5000, 5000)).toBeCloseTo(28.62, 2);
  });

  it('matches the locked reference: asymmetric point, d1=3000 d2=7000 @ 915 MHz', () => {
    expect(fresnelRadiusMeters(1, 915, 3000, 7000)).toBeCloseTo(26.231, 2);
  });

  it('is 0 exactly at an endpoint (d1=0)', () => {
    expect(fresnelRadiusMeters(1, 915, 0, 10000)).toBe(0);
  });

  it('is 0 exactly at an endpoint (d2=0)', () => {
    expect(fresnelRadiusMeters(1, 915, 10000, 0)).toBe(0);
  });

  it('does not throw / returns 0 for coincident points (d1=d2=0)', () => {
    expect(fresnelRadiusMeters(1, 915, 0, 0)).toBe(0);
  });

  it('handles negative distances without producing NaN', () => {
    expect(Number.isNaN(fresnelRadiusMeters(1, 915, -100, 5000))).toBe(false);
    expect(fresnelRadiusMeters(1, 915, -100, 5000)).toBe(0);
  });
});

describe('earthBulgeMeters', () => {
  it('matches the locked reference: 33.3km link, default k=4/3', () => {
    // d1=d2=16650 sums to the 33.3km path
    expect(earthBulgeMeters(16650, 16650)).toBeCloseTo(16.317, 2);
  });

  it('matches the locked reference: k=1', () => {
    expect(earthBulgeMeters(16650, 16650, 1)).toBeCloseTo(21.757, 2);
  });

  it('is 0 exactly at an endpoint (d1=0)', () => {
    expect(earthBulgeMeters(0, 33300)).toBe(0);
  });

  it('is 0 exactly at an endpoint (d2=0)', () => {
    expect(earthBulgeMeters(33300, 0)).toBe(0);
  });

  it('a larger k-factor produces a smaller bulge', () => {
    const bulgeSmallK = earthBulgeMeters(16650, 16650, 1);
    const bulgeLargeK = earthBulgeMeters(16650, 16650, 4 / 3);
    expect(bulgeLargeK).toBeLessThan(bulgeSmallK);
  });

  it('does not throw for negative distances', () => {
    expect(Number.isNaN(earthBulgeMeters(-100, 5000))).toBe(false);
    expect(earthBulgeMeters(-100, 5000)).toBe(0);
  });
});

describe('computeLinkBudget', () => {
  it('matches the locked reference values for 33.3km @ 915MHz', () => {
    const result = computeLinkBudget(33.3, 915, {
      txPowerDbm: 20,
      txGainDbi: 2.15,
      rxGainDbi: 2.15,
      cableLossDb: 0,
      rxSensitivityDbm: -129,
    });
    expect(result.fsplDb).toBeCloseTo(122.117, 2);
    expect(result.rxPowerDbm).toBeCloseTo(-97.817, 2);
    expect(result.marginDb).toBeCloseTo(31.183, 2);
  });

  it('raising cable loss lowers margin', () => {
    const base = computeLinkBudget(33.3, 915, {
      txPowerDbm: 20,
      txGainDbi: 2.15,
      rxGainDbi: 2.15,
      cableLossDb: 0,
      rxSensitivityDbm: -129,
    });
    const withCableLoss = computeLinkBudget(33.3, 915, {
      txPowerDbm: 20,
      txGainDbi: 2.15,
      rxGainDbi: 2.15,
      cableLossDb: 3,
      rxSensitivityDbm: -129,
    });
    expect(withCableLoss.marginDb).toBeLessThan(base.marginDb);
    expect(withCableLoss.rxPowerDbm).toBeLessThan(base.rxPowerDbm);
  });

  it('raising RX sensitivity toward 0 lowers margin', () => {
    const base = computeLinkBudget(33.3, 915, {
      txPowerDbm: 20,
      txGainDbi: 2.15,
      rxGainDbi: 2.15,
      cableLossDb: 0,
      rxSensitivityDbm: -129,
    });
    const worseSensitivity = computeLinkBudget(33.3, 915, {
      txPowerDbm: 20,
      txGainDbi: 2.15,
      rxGainDbi: 2.15,
      cableLossDb: 0,
      rxSensitivityDbm: -100, // less negative = worse (less sensitive) receiver
    });
    expect(worseSensitivity.marginDb).toBeLessThan(base.marginDb);
  });

  it('handles zero distance without throwing', () => {
    const result = computeLinkBudget(0, 915, {
      txPowerDbm: 20,
      txGainDbi: 2.15,
      rxGainDbi: 2.15,
      cableLossDb: 0,
      rxSensitivityDbm: -129,
    });
    expect(result.fsplDb).toBe(0);
    expect(Number.isFinite(result.rxPowerDbm)).toBe(true);
    expect(Number.isFinite(result.marginDb)).toBe(true);
  });
});
