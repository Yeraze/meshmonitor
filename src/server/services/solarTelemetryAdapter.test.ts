import { describe, it, expect } from 'vitest';
import {
  MESHCORE_SOLAR_TYPES,
  normalizeSolarType,
  meshCoreSolarRows,
  meshCoreNameLookups,
} from './solarTelemetryAdapter.js';
import { nodeNumFromPubkey } from '../../utils/meshcoreNodeNum.js';

const PK = 'ab'.repeat(32);

describe('normalizeSolarType', () => {
  it('maps battery volts to voltage', () => {
    expect(normalizeSolarType('mc_battery_volts')).toBe('voltage');
    expect(normalizeSolarType('mc_status_battery_volts')).toBe('voltage');
  });

  it('maps channel types to the INA channel names', () => {
    expect(normalizeSolarType('mc_voltage_ch1')).toBe('ch1Voltage');
    expect(normalizeSolarType('mc_voltage_ch3')).toBe('ch3Voltage');
    expect(normalizeSolarType('mc_battery_volts_ch2')).toBe('ch2BatteryVoltage');
  });

  it('returns null for unrelated or unknown types', () => {
    expect(normalizeSolarType('mc_temperature_ch1')).toBeNull();
    expect(normalizeSolarType('mc_battery_mv')).toBeNull();
    expect(normalizeSolarType('voltage')).toBeNull();
    expect(normalizeSolarType('mc_voltage_ch99')).toBeNull();
  });

  it('keeps every listed type mappable, with INA names that end in Voltage', () => {
    for (const t of MESHCORE_SOLAR_TYPES) {
      const n = normalizeSolarType(t);
      expect(n).not.toBeNull();
      expect(n === 'voltage' || n!.endsWith('Voltage')).toBe(true);
    }
  });
});

describe('meshCoreSolarRows', () => {
  it('keys rows on the synthetic nodeNum and renames types', () => {
    const rows = meshCoreSolarRows([
      { nodeId: PK, telemetryType: 'mc_battery_volts', timestamp: 10, value: 3.9 },
      { nodeId: PK, telemetryType: 'mc_voltage_ch1', timestamp: 11, value: 5.1 },
    ]);
    expect(rows).toEqual([
      { nodeNum: nodeNumFromPubkey(PK), telemetryType: 'voltage', timestamp: 10, value: 3.9 },
      { nodeNum: nodeNumFromPubkey(PK), telemetryType: 'ch1Voltage', timestamp: 11, value: 5.1 },
    ]);
  });

  it('drops null values, non-solar types and rows with no usable key', () => {
    expect(
      meshCoreSolarRows([
        { nodeId: PK, telemetryType: 'mc_battery_volts', timestamp: 1, value: null },
        { nodeId: PK, telemetryType: 'mc_battery_volts', timestamp: 1, value: Number.NaN },
        { nodeId: PK, telemetryType: 'mc_temperature_ch1', timestamp: 1, value: 20 },
        { nodeId: '', telemetryType: 'mc_battery_volts', timestamp: 1, value: 3.7 },
      ]),
    ).toEqual([]);
  });
});

describe('meshCoreNameLookups', () => {
  it('names nodes by synthetic nodeNum', () => {
    expect(meshCoreNameLookups([{ sourceId: 's', publicKey: PK, name: 'Hilltop' }])).toEqual([
      { nodeNum: nodeNumFromPubkey(PK), longName: 'Hilltop', shortName: null },
    ]);
  });

  it('never replaces an existing (Meshtastic) name on a collision', () => {
    const num = nodeNumFromPubkey(PK);
    const out = meshCoreNameLookups(
      [{ sourceId: 's', publicKey: PK, name: 'MC' }],
      [{ nodeNum: num, longName: 'MT', shortName: 'mt' }],
    );
    expect(out).toEqual([]);
  });

  it('still names a node whose colliding entry has no name', () => {
    const num = nodeNumFromPubkey(PK);
    const out = meshCoreNameLookups(
      [{ sourceId: 's', publicKey: PK, name: 'MC' }],
      [{ nodeNum: num, longName: null, shortName: null }],
    );
    expect(out).toEqual([{ nodeNum: num, longName: 'MC', shortName: null }]);
  });
});
