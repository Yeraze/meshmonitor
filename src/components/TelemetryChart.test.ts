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

  // Regression: these entries previously lived in a duplicate local map inside
  // TelemetryGraphs.tsx. If they disappear from the canonical map, the
  // Node Details / Messages / MeshCore-DM telemetry charts will fall back to
  // raw type names again.
  it('returns the explicit label for signal-quality types', () => {
    expect(getTelemetryLabel('snr')).toBe('Signal-to-Noise Ratio (SNR)');
    expect(getTelemetryLabel('snr_local')).toBe('SNR - Local (Our Measurements)');
    expect(getTelemetryLabel('snr_remote')).toBe('SNR - Remote (Node Reports)');
    expect(getTelemetryLabel('rssi')).toBe('Signal Strength (RSSI)');
  });

  it('returns the explicit label for extra power-metrics channels', () => {
    expect(getTelemetryLabel('ch4Voltage')).toBe('Channel 4 Voltage');
    expect(getTelemetryLabel('ch8Current')).toBe('Channel 8 Current');
  });

  it('returns the explicit label for air-quality, host, and extended-environment metrics', () => {
    expect(getTelemetryLabel('pm25Standard')).toBe('PM2.5 (Standard)');
    expect(getTelemetryLabel('co2')).toBe('CO₂');
    expect(getTelemetryLabel('hostLoad1')).toBe('Host Load (1 min)');
    expect(getTelemetryLabel('iaq')).toBe('Indoor Air Quality (IAQ)');
    expect(getTelemetryLabel('rainfall24h')).toBe('Rainfall (24 hours)');
    expect(getTelemetryLabel('soilMoisture')).toBe('Soil Moisture');
  });
});
