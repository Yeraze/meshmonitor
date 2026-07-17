import { describe, it, expect } from 'vitest';
import {
  wavelengthMeters,
  fresnelRadiusMeters,
  fsplDb,
  earthBulgeMeters,
  computeLinkBudget,
  loRaSensitivityDbm,
  rxSensitivityForModemPreset,
  LORA_SNR_LIMIT_DB,
  MODEM_PRESET_PARAMS,
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

describe('loRaSensitivityDbm (#4111 P3 WP-1)', () => {
  // S = -174 + 10*log10(BW_Hz) + NF + SNR_min(SF), NF defaults to 6 dB.
  // Deviation from LINK_PROFILE_POLISH_SPEC.md §3: the spec's test-plan table
  // lists "loRaSensitivityDbm(11,250) ≈ -126.5 (±0.5)", but plugging SF=11
  // into the spec's own formula + LORA_SNR_LIMIT_DB table gives -131.52, not
  // -126.5 (-174 + 53.9794 + 6 - 17.5 = -131.5206). -126.52 is what SF=9
  // produces instead (-174 + 53.9794 + 6 - 12.5). Asserting the value the
  // locked formula actually computes, since the formula (not the example
  // number) is the source of truth (spec §0.2: "computed, not a magic table").
  it('SF11/BW250kHz: matches the formula (-174 + 10log10(250000) + 6 - 17.5)', () => {
    expect(loRaSensitivityDbm(11, 250)).toBeCloseTo(-131.521, 2);
  });

  it('SF9/BW250kHz: -126.52 (the value the spec\'s example number actually matches)', () => {
    expect(loRaSensitivityDbm(9, 250)).toBeCloseTo(-126.521, 2);
  });

  it('higher SF yields a lower (more negative / better) sensitivity at fixed BW', () => {
    const sf7 = loRaSensitivityDbm(7, 250)!;
    const sf9 = loRaSensitivityDbm(9, 250)!;
    const sf11 = loRaSensitivityDbm(11, 250)!;
    expect(sf9).toBeLessThan(sf7);
    expect(sf11).toBeLessThan(sf9);
  });

  it('narrower BW yields a lower (more negative / better) sensitivity at fixed SF', () => {
    const bw250 = loRaSensitivityDbm(11, 250)!;
    const bw125 = loRaSensitivityDbm(11, 125)!;
    expect(bw125).toBeLessThan(bw250);
  });

  it('returns null for an unknown spreading factor', () => {
    expect(loRaSensitivityDbm(6, 250)).toBeNull();
    expect(loRaSensitivityDbm(13, 250)).toBeNull();
  });

  it('returns null for non-positive bandwidth', () => {
    expect(loRaSensitivityDbm(11, 0)).toBeNull();
    expect(loRaSensitivityDbm(11, -10)).toBeNull();
  });

  it('a higher noise figure raises (worsens) sensitivity', () => {
    const nf6 = loRaSensitivityDbm(11, 250, 6)!;
    const nf10 = loRaSensitivityDbm(11, 250, 10)!;
    expect(nf10).toBeGreaterThan(nf6);
  });

  it('LORA_SNR_LIMIT_DB covers every SF used by MODEM_PRESET_PARAMS', () => {
    for (const { sf } of Object.values(MODEM_PRESET_PARAMS)) {
      expect(LORA_SNR_LIMIT_DB[sf]).toBeDefined();
    }
  });
});

describe('rxSensitivityForModemPreset (#4111 P3 WP-1)', () => {
  it('preset 0 (LONG_FAST, SF11/BW250) is finite', () => {
    const result = rxSensitivityForModemPreset(0);
    expect(result).not.toBeNull();
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeCloseTo(-131.521, 2);
  });

  it('returns null for preset 2 (VERY_LONG_SLOW — deprecated, not in MODEM_PRESET_PARAMS)', () => {
    expect(rxSensitivityForModemPreset(2)).toBeNull();
  });

  it('returns null for an out-of-range preset value', () => {
    expect(rxSensitivityForModemPreset(999)).toBeNull();
  });

  it('every preset 0-13 except 2 resolves to a finite sensitivity', () => {
    for (let preset = 0; preset <= 13; preset++) {
      if (preset === 2) continue;
      expect(Number.isFinite(rxSensitivityForModemPreset(preset))).toBe(true);
    }
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
