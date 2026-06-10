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

  it('labels the LocalStats noiseFloor type (#3396)', () => {
    expect(getTelemetryLabel('noiseFloor')).toBe('Noise Floor (Device)');
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

  it('returns the explicit label for MeshCore local-node poller types', () => {
    expect(getTelemetryLabel('mc_queue_len')).toBe('Queue Length');
    expect(getTelemetryLabel('mc_noise_floor')).toBe('Noise Floor');
    expect(getTelemetryLabel('mc_last_rssi')).toBe('Last RSSI');
    expect(getTelemetryLabel('mc_last_snr')).toBe('Last SNR');
    expect(getTelemetryLabel('mc_uptime_secs')).toBe('Uptime');
    expect(getTelemetryLabel('mc_tx_duty_pct')).toBe('TX Duty Cycle');
    expect(getTelemetryLabel('mc_rx_duty_pct')).toBe('RX Duty Cycle');
    expect(getTelemetryLabel('mc_pkt_sent_rate')).toBe('Packets Sent Rate');
    expect(getTelemetryLabel('mc_pkt_recv_rate')).toBe('Packets Received Rate');
    expect(getTelemetryLabel('mc_rtc_drift_secs')).toBe('RTC Drift');
  });

  it('returns the explicit label for MeshCore cumulative counter types', () => {
    expect(getTelemetryLabel('mc_pkt_recv')).toBe('Packets Received (total)');
    expect(getTelemetryLabel('mc_pkt_sent')).toBe('Packets Sent (total)');
    expect(getTelemetryLabel('mc_pkt_flood_tx')).toBe('Flood TX');
    expect(getTelemetryLabel('mc_pkt_direct_tx')).toBe('Direct TX');
    expect(getTelemetryLabel('mc_tx_air_secs')).toBe('TX Air Time');
    expect(getTelemetryLabel('mc_rx_air_secs')).toBe('RX Air Time');
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
