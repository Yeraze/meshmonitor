import { describe, it, expect } from 'vitest';
import {
  TRANSPORT_SERIES_BIN_MS,
  TRANSPORT_SERIES_TYPES,
  TRANSPORT_SERIES_COMPONENT_TYPES,
  TRANSPORT_NODES_HEARD_TYPE,
  TRANSPORT_PACKETS_RX_TYPE,
  isTransportSeriesType,
  isTransportSeriesComponentType,
  binStartOf,
  transportBinIndex,
  buildTransportSeriesRows,
  encodeTransportCheckpoint,
  decodeTransportCheckpoint,
  toTransportChartRows,
  type TransportCheckpoint,
} from './transportSeries.js';

describe('transportSeries', () => {
  describe('binStartOf / transportBinIndex', () => {
    it('floors to the 5-minute boundary', () => {
      const start = binStartOf(1_760_000_000_000);
      expect(start % TRANSPORT_SERIES_BIN_MS).toBe(0);
      expect(start).toBeLessThanOrEqual(1_760_000_000_000);
      expect(start + TRANSPORT_SERIES_BIN_MS).toBeGreaterThan(1_760_000_000_000);
    });

    it('is idempotent on an already-aligned timestamp', () => {
      const aligned = binStartOf(1_760_000_000_000);
      expect(binStartOf(aligned)).toBe(aligned);
    });

    it('transportBinIndex is the bin-end timestamp divided by the bin length', () => {
      const binEnd = binStartOf(1_760_000_000_000) + TRANSPORT_SERIES_BIN_MS;
      expect(transportBinIndex(binEnd)).toBe(binEnd / TRANSPORT_SERIES_BIN_MS);
    });
  });

  describe('isTransportSeriesType / isTransportSeriesComponentType', () => {
    it('recognizes the two pseudo types and nothing else', () => {
      expect(isTransportSeriesType(TRANSPORT_NODES_HEARD_TYPE)).toBe(true);
      expect(isTransportSeriesType(TRANSPORT_PACKETS_RX_TYPE)).toBe(true);
      expect(isTransportSeriesType('systemNodesHeardRf')).toBe(false);
      expect(isTransportSeriesType('batteryLevel')).toBe(false);
    });

    it('recognizes the six stored component types and nothing else', () => {
      for (const t of TRANSPORT_SERIES_COMPONENT_TYPES) {
        expect(isTransportSeriesComponentType(t)).toBe(true);
      }
      expect(isTransportSeriesComponentType(TRANSPORT_NODES_HEARD_TYPE)).toBe(false);
      expect(isTransportSeriesComponentType('batteryLevel')).toBe(false);
    });

    it('has exactly 6 component types (3 nodesHeard + 3 packetsRx)', () => {
      expect(TRANSPORT_SERIES_COMPONENT_TYPES).toHaveLength(6);
      expect(new Set(TRANSPORT_SERIES_COMPONENT_TYPES).size).toBe(6);
    });
  });

  describe('buildTransportSeriesRows', () => {
    it('builds 6 rows with packetId = bin index and timestamp = bin end', () => {
      const binEndMs = binStartOf(1_760_000_000_000) + TRANSPORT_SERIES_BIN_MS;
      const nowMs = binEndMs + 1234;
      const rows = buildTransportSeriesRows({
        nodeId: '!aabbccdd',
        nodeNum: 0xaabbccdd,
        binEndMs,
        nowMs,
        nodesHeard: { rf: 3, udp: 1, mqtt: 0 },
        packetsRx: { rf: 10, udp: 2, mqtt: 5 },
      });

      expect(rows).toHaveLength(6);
      const expectedPacketId = transportBinIndex(binEndMs);
      for (const row of rows) {
        expect(row.timestamp).toBe(binEndMs);
        expect(row.createdAt).toBe(nowMs);
        expect(row.packetId).toBe(expectedPacketId);
        expect(row.nodeId).toBe('!aabbccdd');
        expect(row.nodeNum).toBe(0xaabbccdd);
      }

      const byType = new Map(rows.map((r) => [r.telemetryType, r.value]));
      expect(byType.get(TRANSPORT_SERIES_TYPES.nodesHeard.rf)).toBe(3);
      expect(byType.get(TRANSPORT_SERIES_TYPES.nodesHeard.udp)).toBe(1);
      expect(byType.get(TRANSPORT_SERIES_TYPES.nodesHeard.mqtt)).toBe(0);
      expect(byType.get(TRANSPORT_SERIES_TYPES.packetsRx.rf)).toBe(10);
      expect(byType.get(TRANSPORT_SERIES_TYPES.packetsRx.udp)).toBe(2);
      expect(byType.get(TRANSPORT_SERIES_TYPES.packetsRx.mqtt)).toBe(5);
    });
  });

  describe('checkpoint codec', () => {
    const validCp: TransportCheckpoint = {
      v: 1,
      binStartMs: binStartOf(1_760_000_000_000),
      nodeId: '!aabbccdd',
      nodeNum: 0xaabbccdd,
      rf: 3,
      udp: 1,
      mqtt: 0,
    };

    it('round-trips a valid checkpoint', () => {
      const encoded = encodeTransportCheckpoint(validCp);
      const decoded = decodeTransportCheckpoint(encoded);
      expect(decoded).toEqual(validCp);
    });

    it('rejects bad JSON', () => {
      expect(decodeTransportCheckpoint('{not json')).toBeNull();
    });

    it('rejects null/undefined input', () => {
      expect(decodeTransportCheckpoint(null)).toBeNull();
      expect(decodeTransportCheckpoint(undefined)).toBeNull();
      expect(decodeTransportCheckpoint('')).toBeNull();
    });

    it('rejects the wrong version', () => {
      const bad = { ...validCp, v: 2 };
      expect(decodeTransportCheckpoint(JSON.stringify(bad))).toBeNull();
    });

    it('rejects an unaligned binStartMs', () => {
      const bad = { ...validCp, binStartMs: validCp.binStartMs + 1 };
      expect(decodeTransportCheckpoint(JSON.stringify(bad))).toBeNull();
    });

    it('rejects negative counts', () => {
      const bad = { ...validCp, rf: -1 };
      expect(decodeTransportCheckpoint(JSON.stringify(bad))).toBeNull();
    });

    it('rejects float counts', () => {
      const bad = { ...validCp, udp: 1.5 };
      expect(decodeTransportCheckpoint(JSON.stringify(bad))).toBeNull();
    });

    it('rejects a missing nodeId', () => {
      const bad = { ...validCp, nodeId: '' };
      expect(decodeTransportCheckpoint(JSON.stringify(bad))).toBeNull();
    });
  });

  describe('toTransportChartRows', () => {
    const binEnd1 = binStartOf(1_760_000_000_000) + TRANSPORT_SERIES_BIN_MS;
    const binEnd2 = binEnd1 + TRANSPORT_SERIES_BIN_MS;

    it('sorts by timestamp and fills null for a missing class', () => {
      const rows = [
        { telemetryType: TRANSPORT_SERIES_TYPES.nodesHeard.rf, timestamp: binEnd2, value: 5 },
        { telemetryType: TRANSPORT_SERIES_TYPES.nodesHeard.rf, timestamp: binEnd1, value: 2 },
        { telemetryType: TRANSPORT_SERIES_TYPES.nodesHeard.udp, timestamp: binEnd1, value: 1 },
      ];
      const { rows: out, averaged } = toTransportChartRows(rows, 'nodesHeard');
      expect(averaged).toBe(false);
      expect(out).toEqual([
        { timestamp: binEnd1, rf: 2, udp: 1, mqtt: null },
        { timestamp: binEnd2, rf: 5, udp: null, mqtt: null },
      ]);
    });

    it('ignores rows of a foreign telemetryType', () => {
      const rows = [
        { telemetryType: 'batteryLevel', timestamp: binEnd1, value: 99 },
        { telemetryType: TRANSPORT_SERIES_TYPES.packetsRx.mqtt, timestamp: binEnd1, value: 4 },
      ];
      const { rows: out } = toTransportChartRows(rows, 'packetsRx');
      expect(out).toEqual([{ timestamp: binEnd1, rf: null, udp: null, mqtt: 4 }]);
    });

    it('does not cross-contaminate kinds (nodesHeard type ignored when kind=packetsRx)', () => {
      const rows = [
        { telemetryType: TRANSPORT_SERIES_TYPES.nodesHeard.rf, timestamp: binEnd1, value: 5 },
      ];
      const { rows: out } = toTransportChartRows(rows, 'packetsRx');
      expect(out).toEqual([]);
    });

    it('averages adjacent bins above maxPoints and reports averaged: true', () => {
      const rows: Array<{ telemetryType: string; timestamp: number; value: number }> = [];
      const n = 10;
      for (let i = 0; i < n; i++) {
        rows.push({
          telemetryType: TRANSPORT_SERIES_TYPES.nodesHeard.rf,
          timestamp: binEnd1 + i * TRANSPORT_SERIES_BIN_MS,
          value: i,
        });
      }
      const { rows: out, averaged } = toTransportChartRows(rows, 'nodesHeard', 5);
      expect(averaged).toBe(true);
      expect(out.length).toBeLessThanOrEqual(5);
      // groupSize = ceil(10/5) = 2 -> 5 groups of 2: averages of (0,1),(2,3),(4,5),(6,7),(8,9)
      expect(out.map((r) => r.rf)).toEqual([0.5, 2.5, 4.5, 6.5, 8.5]);
    });

    it('stays un-averaged at exactly maxPoints', () => {
      const rows = [
        { telemetryType: TRANSPORT_SERIES_TYPES.nodesHeard.rf, timestamp: binEnd1, value: 1 },
        { telemetryType: TRANSPORT_SERIES_TYPES.nodesHeard.rf, timestamp: binEnd2, value: 2 },
      ];
      const { rows: out, averaged } = toTransportChartRows(rows, 'nodesHeard', 2);
      expect(averaged).toBe(false);
      expect(out).toHaveLength(2);
    });

    it('returns an empty result for no rows', () => {
      const { rows: out, averaged } = toTransportChartRows([], 'nodesHeard');
      expect(out).toEqual([]);
      expect(averaged).toBe(false);
    });
  });
});
