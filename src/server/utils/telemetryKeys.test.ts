import { describe, it, expect } from 'vitest';
import {
  canonicalTelemetryType,
  canonicalTelemetryUnit,
  MQTT_KEY_MIGRATIONS,
  CANONICAL_TELEMETRY_UNITS,
} from './telemetryKeys.js';

describe('canonicalTelemetryType', () => {
  it('strips the group prefix for device metrics', () => {
    expect(canonicalTelemetryType('device', 'batteryLevel')).toBe('batteryLevel');
    expect(canonicalTelemetryType('device', 'voltage')).toBe('voltage');
    expect(canonicalTelemetryType('device', 'channelUtilization')).toBe('channelUtilization');
    expect(canonicalTelemetryType('device', 'airUtilTx')).toBe('airUtilTx');
  });

  it('strips the group prefix for plain environment metrics', () => {
    expect(canonicalTelemetryType('environment', 'temperature')).toBe('temperature');
    expect(canonicalTelemetryType('environment', 'gasResistance')).toBe('gasResistance');
    expect(canonicalTelemetryType('environment', 'soilTemperature')).toBe('soilTemperature');
  });

  it('applies the environment leaf renames serial ingestion uses', () => {
    expect(canonicalTelemetryType('environment', 'relativeHumidity')).toBe('humidity');
    expect(canonicalTelemetryType('environment', 'barometricPressure')).toBe('pressure');
    expect(canonicalTelemetryType('environment', 'voltage')).toBe('envVoltage');
    expect(canonicalTelemetryType('environment', 'current')).toBe('envCurrent');
  });

  it('strips the group prefix for air-quality and power metrics', () => {
    expect(canonicalTelemetryType('airQuality', 'pm25Standard')).toBe('pm25Standard');
    expect(canonicalTelemetryType('power', 'ch1Voltage')).toBe('ch1Voltage');
    expect(canonicalTelemetryType('power', 'ch8Current')).toBe('ch8Current');
  });

  it('handles snake_case leaf keys from alternate decoders', () => {
    expect(canonicalTelemetryType('environment', 'relative_humidity')).toBe('humidity');
    expect(canonicalTelemetryType('environment', 'barometric_pressure')).toBe('pressure');
    expect(canonicalTelemetryType('environment', 'soil_temperature')).toBe('soilTemperature');
    expect(canonicalTelemetryType('device', 'battery_level')).toBe('batteryLevel');
  });

  it('leaves unmapped groups dotted to avoid key collisions (e.g. health.temperature)', () => {
    // HealthMetrics.temperature must NOT collapse onto environment temperature.
    expect(canonicalTelemetryType('health', 'temperature')).toBe('health.temperature');
    expect(canonicalTelemetryType('host', 'uptimeSeconds')).toBe('host.uptimeSeconds');
  });
});

describe('canonicalTelemetryUnit', () => {
  it('returns the canonical unit for known types', () => {
    expect(canonicalTelemetryUnit('temperature')).toBe('°C');
    expect(canonicalTelemetryUnit('pressure')).toBe('hPa');
    expect(canonicalTelemetryUnit('humidity')).toBe('%');
    expect(canonicalTelemetryUnit('envVoltage')).toBe('V');
    expect(canonicalTelemetryUnit('ch1Voltage')).toBe('V');
    expect(canonicalTelemetryUnit('ch1Current')).toBe('mA');
  });

  it('returns undefined for unknown types', () => {
    expect(canonicalTelemetryUnit('health.temperature')).toBeUndefined();
    expect(canonicalTelemetryUnit('nope')).toBeUndefined();
  });
});

describe('MQTT_KEY_MIGRATIONS', () => {
  it('maps the key environment cases reported in #3314', () => {
    const byFrom = Object.fromEntries(MQTT_KEY_MIGRATIONS.map((m) => [m.from, m]));
    expect(byFrom['environment.temperature']).toMatchObject({ to: 'temperature', unit: '°C' });
    expect(byFrom['environment.barometricPressure']).toMatchObject({ to: 'pressure', unit: 'hPa' });
    expect(byFrom['environment.relativeHumidity']).toMatchObject({ to: 'humidity', unit: '%' });
    expect(byFrom['environment.voltage']).toMatchObject({ to: 'envVoltage', unit: 'V' });
    expect(byFrom['device.batteryLevel']).toMatchObject({ to: 'batteryLevel', unit: '%' });
  });

  it('every migration target is a known canonical type with a unit', () => {
    for (const m of MQTT_KEY_MIGRATIONS) {
      expect(m.from).toContain('.');
      expect(m.to).not.toContain('.');
      expect(CANONICAL_TELEMETRY_UNITS[m.to], `unit for ${m.to}`).toBeDefined();
      expect(m.unit).toBe(CANONICAL_TELEMETRY_UNITS[m.to]);
    }
  });

  it('has no duplicate source keys', () => {
    const froms = MQTT_KEY_MIGRATIONS.map((m) => m.from);
    expect(new Set(froms).size).toBe(froms.length);
  });
});
