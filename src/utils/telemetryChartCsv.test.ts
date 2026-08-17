import { describe, it, expect } from 'vitest';
import {
  TELEMETRY_CSV_BASE_COLUMNS,
  telemetrySeriesToCsv,
  buildTelemetryFilename,
  sanitizeTelemetryFilenamePart,
  type TelemetryCsvRow,
  type TelemetryCsvMeta,
} from './telemetryChartCsv';

const meta: TelemetryCsvMeta = {
  nodeId: '!abcd1234',
  telemetryType: 'battery_level',
  unit: '%',
  hours: 24,
};

function row(overrides: Partial<TelemetryCsvRow> = {}): TelemetryCsvRow {
  return {
    timestamp: 1753386400000,
    value: 87.5,
    ...overrides,
  };
}

describe('telemetryChartCsv', () => {
  describe('telemetrySeriesToCsv', () => {
    it('emits base header in column order, CRLF-joined, no BOM', () => {
      const csv = telemetrySeriesToCsv([row(), row({ timestamp: 1753386500000, value: 86 })], meta);
      const lines = csv.split('\r\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe(TELEMETRY_CSV_BASE_COLUMNS.map((c) => c.label).join(','));
      expect(/(?<!\r)\n/.test(csv)).toBe(false);
      expect(csv.startsWith('\uFEFF')).toBe(false);
    });

    it('formats Timestamp as ISO-8601 UTC and Timestamp Ms as epoch', () => {
      const csv = telemetrySeriesToCsv([row({ timestamp: 1753386400000 })], meta);
      const cells = csv.split('\r\n')[1].split(',');
      expect(cells[0]).toBe(new Date(1753386400000).toISOString());
      expect(cells[1]).toBe('1753386400000');
      expect(cells[2]).toBe('87.5');
      expect(cells[3]).toBe('%');
      expect(cells[4]).toBe('battery_level');
      expect(cells[5]).toBe('!abcd1234');
    });

    it('renders null value as empty cell and preserves zero', () => {
      const nullCsv = telemetrySeriesToCsv([row({ value: null })], meta);
      expect(nullCsv.split('\r\n')[1].split(',')[2]).toBe('');

      const zeroCsv = telemetrySeriesToCsv([row({ value: 0 })], meta);
      expect(zeroCsv.split('\r\n')[1].split(',')[2]).toBe('0');
    });

    it('adds Solar Estimate column only when any row has solarEstimate', () => {
      const without = telemetrySeriesToCsv([row()], meta);
      expect(without.split('\r\n')[0]).not.toContain('Solar Estimate');

      const withSolar = telemetrySeriesToCsv(
        [row({ solarEstimate: 12.3 }), row({ value: null, solarEstimate: 11 })],
        meta,
      );
      const header = withSolar.split('\r\n')[0];
      expect(header).toContain('Solar Estimate');
      expect(header.split(',')).toHaveLength(TELEMETRY_CSV_BASE_COLUMNS.length + 1);
      expect(withSolar.split('\r\n')[1].split(',')[6]).toBe('12.3');
    });

    it('adds Pax Wifi / Pax Ble columns when present', () => {
      const csv = telemetrySeriesToCsv(
        [
          row({ value: 10, paxWifi: 10, paxBle: 3 }),
          row({ timestamp: 1753386500000, value: null, paxWifi: null, paxBle: 1 }),
        ],
        { ...meta, telemetryType: 'paxcounter', unit: '' },
      );
      const header = csv.split('\r\n')[0];
      expect(header).toContain('Pax Wifi');
      expect(header).toContain('Pax Ble');
      const first = csv.split('\r\n')[1].split(',');
      expect(first[6]).toBe('10');
      expect(first[7]).toBe('3');
      const second = csv.split('\r\n')[2].split(',');
      expect(second[6]).toBe('');
      expect(second[7]).toBe('1');
    });

    it('quotes fields that contain commas or quotes (RFC 4180)', () => {
      const csv = telemetrySeriesToCsv([row()], {
        ...meta,
        unit: 'm, "quoted"',
      });
      expect(csv.split('\r\n')[1]).toContain('"m, ""quoted"""');
    });
  });

  describe('buildTelemetryFilename', () => {
    it('builds telemetry-{node}-{type}-{hours}h.csv', () => {
      expect(buildTelemetryFilename('!abcd1234', 'battery_level', 24)).toBe(
        'telemetry-!abcd1234-battery_level-24h.csv',
      );
    });

    it('sanitizes unsafe characters in nodeId and type', () => {
      expect(sanitizeTelemetryFilenamePart('foo/bar:baz')).toBe('foo_bar_baz');
      expect(buildTelemetryFilename('node/x', 'type:y', 7)).toBe('telemetry-node_x-type_y-7h.csv');
    });

    it('rounds hours and clamps non-finite to 0', () => {
      expect(buildTelemetryFilename('n', 't', 24.6)).toBe('telemetry-n-t-25h.csv');
      expect(buildTelemetryFilename('n', 't', Number.NaN)).toBe('telemetry-n-t-0h.csv');
    });
  });
});
