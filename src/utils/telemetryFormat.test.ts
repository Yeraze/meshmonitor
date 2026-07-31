import { describe, it, expect } from 'vitest';
import {
  unitScale,
  scaleMeasurement,
  isUptimeType,
  formatDuration,
  telemetryDisplayScale,
} from './telemetryFormat';

describe('unitScale', () => {
  it('keeps amps above 1 A in A', () => {
    expect(unitScale('A', 2.5)).toEqual({ factor: 1, unit: 'A' });
  });

  it('drops sub-1 A readings to mA', () => {
    expect(unitScale('A', 0.45)).toEqual({ factor: 1000, unit: 'mA' });
  });

  it('keeps small milliamp readings in mA', () => {
    expect(unitScale('mA', 50)).toEqual({ factor: 1, unit: 'mA' });
  });

  it('promotes large milliamp readings to A', () => {
    expect(unitScale('mA', 1500)).toEqual({ factor: 1e-3, unit: 'A' });
  });

  it('drops sub-1 W readings to mW', () => {
    expect(unitScale('W', 0.012)).toEqual({ factor: 1000, unit: 'mW' });
  });

  it('keeps watts between 1 and 1000 in W', () => {
    expect(unitScale('W', 42)).toEqual({ factor: 1, unit: 'W' });
  });

  it('promotes kilowatt-scale power to kW', () => {
    expect(unitScale('W', 2500)).toEqual({ factor: 1e-3, unit: 'kW' });
  });

  it('uses the magnitude, not the sign, to choose the prefix', () => {
    expect(unitScale('A', -0.3)).toEqual({ factor: 1000, unit: 'mA' });
  });

  it('leaves non-scalable units untouched', () => {
    expect(unitScale('V', 3.7)).toEqual({ factor: 1, unit: 'V' });
    expect(unitScale('°C', 21)).toEqual({ factor: 1, unit: '°C' });
    expect(unitScale('', 5)).toEqual({ factor: 1, unit: '' });
  });

  it('falls back to the smallest prefix for a zero magnitude', () => {
    expect(unitScale('A', 0)).toEqual({ factor: 1000, unit: 'mA' });
  });

  it('does not scale on a non-finite representative magnitude', () => {
    expect(unitScale('A', NaN)).toEqual({ factor: 1, unit: 'A' });
  });
});

describe('scaleMeasurement', () => {
  it('converts 0.45 A to 450 mA', () => {
    const { value, unit } = scaleMeasurement(0.45, 'A');
    expect(value).toBeCloseTo(450, 6);
    expect(unit).toBe('mA');
  });

  it('converts 0.012 W to 12 mW', () => {
    const { value, unit } = scaleMeasurement(0.012, 'W');
    expect(value).toBeCloseTo(12, 6);
    expect(unit).toBe('mW');
  });

  it('converts 1500 mA to 1.5 A', () => {
    const { value, unit } = scaleMeasurement(1500, 'mA');
    expect(value).toBeCloseTo(1.5, 6);
    expect(unit).toBe('A');
  });

  it('leaves voltage untouched', () => {
    expect(scaleMeasurement(3.72, 'V')).toEqual({ value: 3.72, unit: 'V' });
  });
});

describe('isUptimeType', () => {
  it.each([
    'uptimeSeconds',
    'hostUptimeSeconds',
    'paxcounterUptime',
    'mc_uptime_secs',
    'mc_status_uptime_secs',
  ])('treats %s as an uptime', (type) => {
    expect(isUptimeType(type)).toBe(true);
  });

  it.each([
    'voltage',
    'current',
    'mc_air_time_secs',
    'mc_rtc_drift_secs',
    'mc_tx_air_secs',
  ])('does not treat %s as an uptime', (type) => {
    expect(isUptimeType(type)).toBe(false);
  });
});

describe('formatDuration', () => {
  it('formats days and hours for large uptimes', () => {
    expect(formatDuration(3 * 86400 + 4 * 3600 + 30 * 60)).toBe('3d 4h');
  });

  it('formats hours and minutes below a day', () => {
    expect(formatDuration(5 * 3600 + 12 * 60)).toBe('5h 12m');
  });

  it('formats minutes below an hour', () => {
    expect(formatDuration(45 * 60 + 30)).toBe('45m');
  });

  it('clamps negatives to zero', () => {
    expect(formatDuration(-100)).toBe('0m');
  });
});

describe('telemetryDisplayScale', () => {
  it('humanizes uptime and drops the redundant "s" unit', () => {
    const d = telemetryDisplayScale('uptimeSeconds', [1543452], 's');
    expect(d.isUptime).toBe(true);
    expect(d.factor).toBe(1);
    expect(d.unit).toBe('');
    expect(d.formatValue!(1543452)).toBe('17d 20h');
  });

  it.each(['hostUptimeSeconds', 'paxcounterUptime', 'mc_uptime_secs'])(
    'treats %s as an uptime series',
    type => {
      expect(telemetryDisplayScale(type, [90000], 's').isUptime).toBe(true);
    }
  );

  it('picks one prefix for the whole series from its largest magnitude', () => {
    // The 0.9 A peak keeps the series in mA rather than flipping per point.
    const d = telemetryDisplayScale('mc_current', [0.02, 0.9, 0.05], 'A');
    expect(d.factor).toBe(1000);
    expect(d.unit).toBe('mA');
    expect(d.formatValue).toBeUndefined();
  });

  it('keeps a series with an amp-scale peak in A', () => {
    const d = telemetryDisplayScale('mc_current', [0.02, 2.5], 'A');
    expect(d.factor).toBe(1);
    expect(d.unit).toBe('A');
  });

  it('ignores nulls and non-finite entries when sizing the series', () => {
    const d = telemetryDisplayScale('mc_power', [null, undefined, NaN, 0.012], 'W');
    expect(d.unit).toBe('mW');
    expect(d.factor).toBe(1000);
  });

  it('leaves non-scalable units alone', () => {
    expect(telemetryDisplayScale('voltage', [3.7], 'V')).toEqual({
      isUptime: false,
      factor: 1,
      unit: 'V',
    });
  });

  it('handles an empty series', () => {
    const d = telemetryDisplayScale('channelUtilization', [], '%');
    expect(d).toEqual({ isUptime: false, factor: 1, unit: '%' });
  });
});
