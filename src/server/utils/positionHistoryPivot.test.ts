import { describe, it, expect } from 'vitest';
import { pivotPositionHistory, NO_SNR_SENTINEL, type PivotTelemetryRow } from './positionHistoryPivot.js';

/**
 * Tests for the position-history pivot (issue #3590).
 *
 * The map history tooltip must surface SNR + hop info per fix. SNR is only
 * meaningful for directly-heard fixes (hopStart === hopLimit, i.e. 0 hops).
 * A directly-heard node frequently reports an SNR at or near 0 dB, which an
 * old truthiness check silently dropped — these tests lock in that 0 dB is
 * preserved while the firmware -128 "no measurement" sentinel is stripped.
 */
describe('pivotPositionHistory', () => {
  const fix = (
    timestamp: number,
    lat: number,
    lon: number,
    meta: Partial<Pick<PivotTelemetryRow, 'rxSnr' | 'hopStart' | 'hopLimit'>> = {},
  ): PivotTelemetryRow[] => [
    { telemetryType: 'latitude', timestamp, value: lat, ...meta },
    { telemetryType: 'longitude', timestamp, value: lon, ...meta },
  ];

  it('pivots lat/lon rows into a single fix', () => {
    const out = pivotPositionHistory(fix(1000, 37.5, -122.1));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ timestamp: 1000, latitude: 37.5, longitude: -122.1 });
  });

  it('captures SNR and hops for a directly-heard (zero-hop) fix', () => {
    // hopStart === hopLimit => 0 hops => heard directly
    const out = pivotPositionHistory(fix(2000, 1, 2, { rxSnr: 6.25, hopStart: 3, hopLimit: 3 }));
    expect(out[0].snr).toBe(6.25);
    expect(out[0].hopStart).toBe(3);
    expect(out[0].hopLimit).toBe(3);
  });

  it('preserves a legitimate 0 dB SNR (the core #3590 bug)', () => {
    const out = pivotPositionHistory(fix(3000, 1, 2, { rxSnr: 0, hopStart: 3, hopLimit: 3 }));
    expect(out[0].snr).toBe(0);
  });

  it('treats the -128 firmware sentinel as no SNR', () => {
    const out = pivotPositionHistory(fix(4000, 1, 2, { rxSnr: NO_SNR_SENTINEL, hopStart: 3, hopLimit: 3 }));
    expect(out[0].snr).toBeUndefined();
    // hops still present even when SNR is absent
    expect(out[0].hopStart).toBe(3);
  });

  it('treats null/undefined SNR as absent', () => {
    const out = pivotPositionHistory(fix(5000, 1, 2, { rxSnr: null, hopStart: 2, hopLimit: 1 }));
    expect(out[0].snr).toBeUndefined();
  });

  it('omits SNR/hop keys entirely when not present', () => {
    const out = pivotPositionHistory(fix(6000, 1, 2));
    expect('snr' in out[0]).toBe(false);
    expect('hopStart' in out[0]).toBe(false);
    expect('hopLimit' in out[0]).toBe(false);
  });

  it('drops incomplete fixes missing lat or lon', () => {
    const rows: PivotTelemetryRow[] = [
      { telemetryType: 'latitude', timestamp: 7000, value: 1 },
      // no longitude for 7000
      { telemetryType: 'latitude', timestamp: 8000, value: 3 },
      { telemetryType: 'longitude', timestamp: 8000, value: 4 },
    ];
    const out = pivotPositionHistory(rows);
    expect(out).toHaveLength(1);
    expect(out[0].timestamp).toBe(8000);
  });

  it('sorts fixes oldest-first', () => {
    const rows = [...fix(3000, 1, 1), ...fix(1000, 2, 2), ...fix(2000, 3, 3)];
    const out = pivotPositionHistory(rows);
    expect(out.map((p) => p.timestamp)).toEqual([1000, 2000, 3000]);
  });

  it('takes SNR/hops from whichever lat or lon row carries them', () => {
    // metadata only on the longitude row
    const rows: PivotTelemetryRow[] = [
      { telemetryType: 'latitude', timestamp: 9000, value: 1 },
      { telemetryType: 'longitude', timestamp: 9000, value: 2, rxSnr: -1.5, hopStart: 3, hopLimit: 3 },
    ];
    const out = pivotPositionHistory(rows);
    expect(out[0].snr).toBe(-1.5);
    expect(out[0].hopStart).toBe(3);
    expect(out[0].hopLimit).toBe(3);
  });

  it('carries altitude, ground speed and track through', () => {
    const rows: PivotTelemetryRow[] = [
      ...fix(10000, 1, 2),
      { telemetryType: 'altitude', timestamp: 10000, value: 150 },
      { telemetryType: 'ground_speed', timestamp: 10000, value: 5 },
      { telemetryType: 'ground_track', timestamp: 10000, value: 90 },
    ];
    const out = pivotPositionHistory(rows);
    expect(out[0]).toMatchObject({ altitude: 150, groundSpeed: 5, groundTrack: 90 });
  });
});
