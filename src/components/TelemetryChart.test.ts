/**
 * @vitest-environment jsdom
 *
 * Tests for the label-resolution helper exported by TelemetryChart.
 * Covers the MeshCore `_ch<N>` suffix handling added for #3139.
 */
import { describe, it, expect } from 'vitest';
import { getTelemetryLabel } from './TelemetryChart';

describe('getTelemetryLabel', () => {
  it('returns the explicit label for known Meshtastic types', () => {
    expect(getTelemetryLabel('batteryLevel')).toBe('Battery Level');
    expect(getTelemetryLabel('temperature')).toBe('Temperature');
  });

  it('returns the explicit label for known MeshCore status types', () => {
    expect(getTelemetryLabel('mc_status_uptime_secs')).toBe('Uptime');
    expect(getTelemetryLabel('mc_status_noise_floor')).toBe('Noise Floor');
  });

  it('formats MeshCore LPP-channel-suffixed types as "<base> (chN)"', () => {
    expect(getTelemetryLabel('mc_battery_volts_ch1')).toBe('Battery (ch1)');
    expect(getTelemetryLabel('mc_battery_volts_ch4')).toBe('Battery (ch4)');
    expect(getTelemetryLabel('mc_temperature_ch2')).toBe('Temperature (ch2)');
    expect(getTelemetryLabel('mc_humidity_ch3')).toBe('Humidity (ch3)');
  });

  it('appends the axis key for multi-axis LPP types (gps etc.)', () => {
    // baseType `mc_lpp_136` isn't in TELEMETRY_LABELS, so this falls
    // through to the raw type — guards against false label collisions.
    expect(getTelemetryLabel('mc_lpp_136_ch1_latitude')).toBe('mc_lpp_136_ch1_latitude');
  });

  it('falls back to the raw type when no label is known', () => {
    expect(getTelemetryLabel('totally_unknown_metric')).toBe('totally_unknown_metric');
    expect(getTelemetryLabel('mc_lpp_9999_ch1')).toBe('mc_lpp_9999_ch1');
  });
});
