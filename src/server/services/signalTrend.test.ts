/**
 * Unit tests for the pure signal-trend computation (issue #4110).
 *
 * Covers the classification matrix (improving / stable / degrading /
 * insufficient), the RSSI-over-SNR basis priority, and the noise-floor
 * correction that stops a noisier RF environment reading as path attenuation.
 */
import { describe, it, expect } from 'vitest';
import {
  computeSignalTrend,
  MIN_SAMPLES_PER_WINDOW,
  RSSI_TELEMETRY_TYPE,
  SNR_TELEMETRY_TYPE,
  NOISE_FLOOR_TELEMETRY_TYPE,
  type SignalSample,
} from './signalTrend.js';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Three timestamps inside the recent window (last 24h).
const RECENT_TS = [NOW - 1 * HOUR, NOW - 2 * HOUR, NOW - 3 * HOUR];
// Three timestamps inside the baseline window (prior 7 days).
const BASELINE_TS = [NOW - 2 * DAY, NOW - 3 * DAY, NOW - 4 * DAY];

function samples(
  type: string,
  recentValues: number[],
  baselineValues: number[],
): SignalSample[] {
  const out: SignalSample[] = [];
  recentValues.forEach((v, i) => out.push({ telemetryType: type, timestamp: RECENT_TS[i % RECENT_TS.length] - i, value: v }));
  baselineValues.forEach((v, i) => out.push({ telemetryType: type, timestamp: BASELINE_TS[i % BASELINE_TS.length] - i, value: v }));
  return out;
}

describe('computeSignalTrend (#4110)', () => {
  it('reports RSSI improving when recent received power rises above baseline', () => {
    // baseline avg -95, recent avg -85 → delta +10 dBm (>= +5)
    const rows = samples(RSSI_TELEMETRY_TYPE, [-85, -85, -85], [-95, -95, -95]);
    const r = computeSignalTrend(rows, NOW);
    expect(r.trend).toBe('improving');
    expect(r.basis).toBe('rssi');
    expect(r.rssi).toMatchObject({ recent: -85, baseline: -95, delta: 10, recentCount: 3, baselineCount: 3, unit: 'dBm' });
  });

  it('reports RSSI degrading when recent received power drops below baseline', () => {
    // baseline avg -80, recent avg -92 → delta -12 dBm (<= -5)
    const rows = samples(RSSI_TELEMETRY_TYPE, [-92, -92, -92], [-80, -80, -80]);
    const r = computeSignalTrend(rows, NOW);
    expect(r.trend).toBe('degrading');
    expect(r.basis).toBe('rssi');
    expect(r.rssi?.delta).toBe(-12);
  });

  it('reports stable when the RSSI change is below the threshold', () => {
    // delta -2 dBm — within the ±5 dB dead-band
    const rows = samples(RSSI_TELEMETRY_TYPE, [-87, -87, -87], [-85, -85, -85]);
    const r = computeSignalTrend(rows, NOW);
    expect(r.trend).toBe('stable');
    expect(r.basis).toBe('rssi');
  });

  it('reports insufficient when a window has fewer than the minimum samples', () => {
    // Only 2 recent samples (< MIN_SAMPLES_PER_WINDOW), plenty of baseline.
    expect(MIN_SAMPLES_PER_WINDOW).toBe(3);
    const rows = samples(RSSI_TELEMETRY_TYPE, [-85, -85], [-95, -95, -95]);
    const r = computeSignalTrend(rows, NOW);
    expect(r.trend).toBe('insufficient');
    expect(r.basis).toBeNull();
    expect(r.rssi).toBeNull();
  });

  it('reports insufficient with no samples at all', () => {
    const r = computeSignalTrend([], NOW);
    expect(r.trend).toBe('insufficient');
    expect(r.rssi).toBeNull();
    expect(r.snr).toBeNull();
    expect(r.noiseFloor).toBeNull();
    expect(r.noiseFloorRising).toBe(false);
  });

  it('falls back to SNR when RSSI is unavailable', () => {
    // SNR baseline 8, recent 2 → delta -6 dB (<= -3) with no noise data
    const rows = samples(SNR_TELEMETRY_TYPE, [2, 2, 2], [8, 8, 8]);
    const r = computeSignalTrend(rows, NOW);
    expect(r.trend).toBe('degrading');
    expect(r.basis).toBe('snr');
    expect(r.rssi).toBeNull();
  });

  it('does not treat a purely noise-driven SNR drop as degradation', () => {
    // SNR fell 4 dB, but the noise floor rose 4 dB → path delta ≈ 0 → stable.
    const rows = [
      ...samples(SNR_TELEMETRY_TYPE, [6, 6, 6], [10, 10, 10]),        // delta -4
      ...samples(NOISE_FLOOR_TELEMETRY_TYPE, [-96, -96, -96], [-100, -100, -100]), // delta +4 (noisier)
    ];
    const r = computeSignalTrend(rows, NOW);
    expect(r.basis).toBe('snr');
    expect(r.trend).toBe('stable');
    expect(r.noiseFloorRising).toBe(true);
  });

  it('still flags degradation when the SNR drop exceeds the noise-floor rise', () => {
    // SNR fell 8 dB, noise rose only 2 dB → path delta -6 → degrading.
    const rows = [
      ...samples(SNR_TELEMETRY_TYPE, [2, 2, 2], [10, 10, 10]),        // delta -8
      ...samples(NOISE_FLOOR_TELEMETRY_TYPE, [-98, -98, -98], [-100, -100, -100]), // delta +2
    ];
    const r = computeSignalTrend(rows, NOW);
    expect(r.basis).toBe('snr');
    expect(r.trend).toBe('degrading');
  });

  it('prefers RSSI over SNR when both have enough data', () => {
    // RSSI stable (delta -2), SNR would be degrading (delta -6). RSSI wins.
    const rows = [
      ...samples(RSSI_TELEMETRY_TYPE, [-87, -87, -87], [-85, -85, -85]), // stable
      ...samples(SNR_TELEMETRY_TYPE, [2, 2, 2], [8, 8, 8]),              // would degrade
    ];
    const r = computeSignalTrend(rows, NOW);
    expect(r.basis).toBe('rssi');
    expect(r.trend).toBe('stable');
    // Both metric blocks are still surfaced for the tooltip.
    expect(r.snr).not.toBeNull();
  });

  it('ignores samples outside the lookback window', () => {
    const rows = [
      ...samples(RSSI_TELEMETRY_TYPE, [-85, -85, -85], [-95, -95, -95]),
      // Way older than the 8-day baseline start — must not count.
      { telemetryType: RSSI_TELEMETRY_TYPE, timestamp: NOW - 30 * DAY, value: 0 },
      // Future-dated — must not count.
      { telemetryType: RSSI_TELEMETRY_TYPE, timestamp: NOW + HOUR, value: 0 },
    ];
    const r = computeSignalTrend(rows, NOW);
    expect(r.rssi?.recentCount).toBe(3);
    expect(r.rssi?.baselineCount).toBe(3);
  });
});
