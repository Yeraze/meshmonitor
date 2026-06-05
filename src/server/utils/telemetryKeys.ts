/**
 * Canonical telemetry key normalization.
 *
 * Serial/direct ingestion (meshtasticManager.ts) stores environment, device,
 * air-quality and power metrics under short canonical keys (e.g. `temperature`,
 * `pressure`, `humidity`, `ch1Voltage`). MQTT ingestion historically stored the
 * same metrics under group-prefixed protobuf keys (e.g. `environment.temperature`,
 * `environment.barometricPressure`), which don't match the keys the UI graphs and
 * SOLAR_DEFAULT_ON_TYPES expect — so MQTT-sourced environment data was invisible.
 *
 * This module maps the MQTT group/leaf form to the canonical serial key so both
 * transports write identical `telemetryType` values (and units).
 *
 * Implements: https://github.com/Yeraze/meshmonitor/issues/3314
 */

/** Canonical type → unit, mirroring the serial ingestion path. */
const DEVICE_UNITS: Record<string, string> = {
  batteryLevel: '%',
  voltage: 'V',
  channelUtilization: '%',
  airUtilTx: '%',
  uptimeSeconds: 's',
};

const ENVIRONMENT_UNITS: Record<string, string> = {
  temperature: '°C',
  humidity: '%',
  pressure: 'hPa',
  gasResistance: 'MΩ',
  iaq: 'IAQ',
  lux: 'lux',
  whiteLux: 'lux',
  irLux: 'lux',
  uvLux: 'lux',
  windDirection: '°',
  windSpeed: 'm/s',
  windGust: 'm/s',
  windLull: 'm/s',
  rainfall1h: 'mm',
  rainfall24h: 'mm',
  soilMoisture: '%',
  soilTemperature: '°C',
  radiation: 'µR/h',
  distance: 'mm',
  weight: 'kg',
  envVoltage: 'V',
  envCurrent: 'A',
};

const AIR_QUALITY_UNITS: Record<string, string> = {
  pm10Standard: 'µg/m³',
  pm25Standard: 'µg/m³',
  pm100Standard: 'µg/m³',
  pm10Environmental: 'µg/m³',
  pm25Environmental: 'µg/m³',
  pm100Environmental: 'µg/m³',
  particles03um: '#/0.1L',
  particles05um: '#/0.1L',
  particles10um: '#/0.1L',
  particles25um: '#/0.1L',
  particles50um: '#/0.1L',
  particles100um: '#/0.1L',
  co2: 'ppm',
  co2Temperature: '°C',
  co2Humidity: '%',
};

const POWER_UNITS: Record<string, string> = (() => {
  const u: Record<string, string> = {};
  for (let ch = 1; ch <= 8; ch++) {
    u[`ch${ch}Voltage`] = 'V';
    u[`ch${ch}Current`] = 'mA';
  }
  return u;
})();

/** All canonical telemetry types → their unit. */
export const CANONICAL_TELEMETRY_UNITS: Record<string, string> = {
  ...DEVICE_UNITS,
  ...ENVIRONMENT_UNITS,
  ...AIR_QUALITY_UNITS,
  ...POWER_UNITS,
};

/**
 * MQTT group names whose leaf keys map onto canonical serial keys by stripping
 * the prefix. Other groups (e.g. `health`) are left dotted because serial never
 * stores them and some leaves (e.g. HealthMetrics.temperature) would collide
 * with environment keys.
 */
const STRIP_GROUPS = new Set(['device', 'environment', 'airQuality', 'power']);

/**
 * Environment protobuf leaf names that the serial path renames. Everything else
 * in the environment group keeps its leaf name.
 */
const ENVIRONMENT_LEAF_RENAMES: Record<string, string> = {
  relativeHumidity: 'humidity',
  barometricPressure: 'pressure',
  voltage: 'envVoltage',
  current: 'envCurrent',
};

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Map an MQTT telemetry group + leaf key to the canonical `telemetryType` used
 * by serial ingestion. Leaves of unmapped groups are returned dotted, unchanged.
 *
 * @param group MQTT metrics group name (e.g. 'environment', 'device', 'health')
 * @param leaf protobuf field name within the group (camelCase or snake_case)
 */
export function canonicalTelemetryType(group: string, leaf: string): string {
  const camel = snakeToCamel(leaf);
  if (!STRIP_GROUPS.has(group)) {
    return `${group}.${leaf}`;
  }
  if (group === 'environment') {
    return ENVIRONMENT_LEAF_RENAMES[camel] ?? camel;
  }
  return camel;
}

/** Canonical unit for a canonical telemetry type, or undefined if unknown. */
export function canonicalTelemetryUnit(type: string): string | undefined {
  return CANONICAL_TELEMETRY_UNITS[type];
}

/**
 * Explicit list of historical MQTT dotted keys → canonical key (+ unit), used by
 * the migration that rewrites already-stored rows. Built from the same canonical
 * tables so it stays in sync with {@link canonicalTelemetryType}.
 */
export interface TelemetryKeyMigration {
  from: string;
  to: string;
  unit: string;
}

export const MQTT_KEY_MIGRATIONS: TelemetryKeyMigration[] = (() => {
  const out: TelemetryKeyMigration[] = [];

  for (const leaf of Object.keys(DEVICE_UNITS)) {
    out.push({ from: `device.${leaf}`, to: leaf, unit: DEVICE_UNITS[leaf] });
  }

  // Environment uses protobuf leaf names; a few are renamed by the serial path.
  const environmentProtobufLeaves = [
    'temperature', 'relativeHumidity', 'barometricPressure', 'gasResistance', 'iaq',
    'lux', 'whiteLux', 'irLux', 'uvLux',
    'windDirection', 'windSpeed', 'windGust', 'windLull',
    'rainfall1h', 'rainfall24h',
    'soilMoisture', 'soilTemperature',
    'radiation', 'distance', 'weight',
    'voltage', 'current',
  ];
  for (const leaf of environmentProtobufLeaves) {
    const to = canonicalTelemetryType('environment', leaf);
    out.push({ from: `environment.${leaf}`, to, unit: ENVIRONMENT_UNITS[to] ?? '' });
  }

  for (const leaf of Object.keys(AIR_QUALITY_UNITS)) {
    out.push({ from: `airQuality.${leaf}`, to: leaf, unit: AIR_QUALITY_UNITS[leaf] });
  }

  for (const leaf of Object.keys(POWER_UNITS)) {
    out.push({ from: `power.${leaf}`, to: leaf, unit: POWER_UNITS[leaf] });
  }

  return out;
})();
