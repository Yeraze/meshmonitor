/**
 * Site Planner seeding (#4727).
 *
 * Maintainer decision: prefill from the radio's live LoRa config. The failure
 * mode is quiet — a plausible polygon computed on the wrong region's frequency
 * — so these tests care most about which values came from the device and which
 * were assumed.
 */
import { describe, it, expect } from 'vitest';
import { buildSitePlannerDefaults, SITE_PLANNER_FALLBACKS } from './sitePlannerDefaults';
import { regionCenterFrequencyHz } from '../configuration/constants';

describe('buildSitePlannerDefaults', () => {
  it('seeds frequency from the configured region', () => {
    // US (1) sits in the 902–928 MHz band.
    const d = buildSitePlannerDefaults({ region: 1 });
    expect(d.frequencyHz).toBe(regionCenterFrequencyHz(1));
    expect(d.frequencyHz).toBeGreaterThan(900e6);
    expect(d.frequencyHz).toBeLessThan(930e6);
    expect(d.seededFrom).toContain('frequency');
  });

  it('seeds a different band for a different region', () => {
    // EU_433 must not silently predict on the US band.
    const eu = buildSitePlannerDefaults({ region: 2 });
    expect(eu.frequencyHz).toBeGreaterThan(430e6);
    expect(eu.frequencyHz).toBeLessThan(440e6);
  });

  it('keeps a transmit power of 0 rather than replacing it with the default', () => {
    // 0 dBm is legitimate; truthiness would silently substitute 30 and
    // overstate range by a wide margin.
    const d = buildSitePlannerDefaults({ region: 1, txPower: 0 });
    expect(d.txPowerDbm).toBe(0);
    expect(d.seededFrom).toContain('txPower');
  });

  it('falls back without claiming the value came from the device', () => {
    const d = buildSitePlannerDefaults(null);
    expect(d.frequencyHz).toBe(SITE_PLANNER_FALLBACKS.frequencyHz);
    expect(d.txPowerDbm).toBe(SITE_PLANNER_FALLBACKS.txPowerDbm);
    expect(d.seededFrom).toEqual([]);
  });

  it('reports partial seeding accurately', () => {
    // Region known, power not: the UI must not imply both were read.
    const d = buildSitePlannerDefaults({ region: 1 });
    expect(d.seededFrom).toContain('frequency');
    expect(d.seededFrom).not.toContain('txPower');
    expect(d.txPowerDbm).toBe(SITE_PLANNER_FALLBACKS.txPowerDbm);
  });

  it('ignores a non-finite device value instead of propagating NaN', () => {
    const d = buildSitePlannerDefaults({ region: 1, txPower: NaN as unknown as number });
    expect(Number.isFinite(d.txPowerDbm)).toBe(true);
    expect(d.seededFrom).not.toContain('txPower');
  });

  it('falls back for an unknown region rather than fabricating a frequency', () => {
    const d = buildSitePlannerDefaults({ region: 9999 });
    expect(d.frequencyHz).toBe(SITE_PLANNER_FALLBACKS.frequencyHz);
    expect(d.seededFrom).not.toContain('frequency');
  });

  it('assumes a peer handheld receiver, not a base station', () => {
    // Receiver height drives predicted reach; assuming a mast would inflate it.
    expect(buildSitePlannerDefaults(null).rxHeightM).toBeLessThanOrEqual(2);
  });
});
