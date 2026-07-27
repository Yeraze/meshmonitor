import { describe, it, expect } from 'vitest';
import {
  GATEWAY_CSV_COLUMNS,
  PACKET_CSV_COLUMNS,
  buildGatewaysCsv,
  buildPacketsCsv,
  gatewaysCsvFilename,
  packetsCsvFilename,
} from './mqttViolationsCsv';
import { buildViolationParams, DEFAULT_VIOLATION_FILTERS } from './mqttViolationTypes';
import type { ViolationGatewayRow, ViolationPacketRow } from './mqttViolationTypes';

function gatewayRow(overrides: Partial<ViolationGatewayRow> = {}): ViolationGatewayRow {
  return {
    gatewayId: '!433e0f28',
    gatewayNodeNum: 1128517928,
    violationCount: 3,
    suspectedCount: 0,
    distinctOriginators: 2,
    sourceIds: ['mqtt-a'],
    firstSeen: 1753300000000,
    lastSeen: 1753386400000,
    ...overrides,
  };
}

function packetRow(overrides: Partial<ViolationPacketRow> = {}): ViolationPacketRow {
  return {
    id: 1,
    kind: 'confirmed',
    sourceId: 'mqtt-a',
    packetId: 987654321,
    fromNode: 305441741,
    fromNodeId: '!123abcde',
    gatewayId: '!433e0f28',
    gatewayNodeNum: 1128517928,
    channelId: 'LongFast',
    portnum: 1,
    portnumName: 'TEXT_MESSAGE_APP',
    bitfield: 0,
    topic: 'msh/US/2/e/LongFast/!433e0f28',
    rxTime: 1753386400,
    timestamp: 1753386400000,
    ...overrides,
  };
}

describe('mqttViolationsCsv', () => {
  describe('buildGatewaysCsv', () => {
    it('C1: emits the header in GATEWAY_CSV_COLUMNS order and one row per input, CRLF-joined, no BOM', () => {
      const csv = buildGatewaysCsv([gatewayRow(), gatewayRow({ gatewayId: '!aabbccdd' })]);
      const lines = csv.split('\r\n');
      expect(lines).toHaveLength(3); // header + 2 rows
      expect(lines[0]).toBe(GATEWAY_CSV_COLUMNS.map((c) => c.label).join(','));
      expect(/(?<!\r)\n/.test(csv)).toBe(false); // no bare LF anywhere, only CRLF
      expect(csv.startsWith('﻿')).toBe(false); // no BOM
      expect(lines[1]).toContain('!433e0f28');
      expect(lines[2]).toContain('!aabbccdd');
    });

    it('C2: quotes and doubles quotes for fields containing comma, quote, or newline (RFC 4180)', () => {
      const csv = buildGatewaysCsv([
        gatewayRow({
          gatewayId: '!weird,"id\nvalue',
          sourceIds: ['mqtt-a', 'mqtt-b'],
        }),
      ]);
      const dataLine = csv.split('\r\n')[1];
      // The escaped field must be wrapped in quotes with internal quotes doubled.
      expect(dataLine).toContain('"!weird,""id\nvalue"');
      // Prove the AuditLogTab comma-swap bug was NOT copied: the comma is preserved, not replaced with ';'.
      expect(dataLine).not.toContain('!weird;"id');
    });

    it('C3: sourceIds joins with "; "; a single-source row has no separator', () => {
      const multi = buildGatewaysCsv([gatewayRow({ sourceIds: ['mqtt-a', 'mqtt-b', 'mqtt-c'] })]);
      expect(multi.split('\r\n')[1]).toContain('mqtt-a; mqtt-b; mqtt-c');

      const single = buildGatewaysCsv([gatewayRow({ sourceIds: ['mqtt-a'] })]);
      const singleLine = single.split('\r\n')[1];
      expect(singleLine).toContain('mqtt-a');
      expect(singleLine).not.toContain(';');
    });

    it('C4: firstSeen/lastSeen render as ISO-8601 UTC; null/0 render as empty field', () => {
      const csv = buildGatewaysCsv([
        gatewayRow({ firstSeen: 1753300000000, lastSeen: 1753386400000 }),
      ]);
      const cells = csv.split('\r\n')[1].split(',');
      const firstSeenIdx = GATEWAY_CSV_COLUMNS.findIndex((c) => c.key === 'firstSeen');
      const lastSeenIdx = GATEWAY_CSV_COLUMNS.findIndex((c) => c.key === 'lastSeen');
      expect(cells[firstSeenIdx]).toBe(new Date(1753300000000).toISOString());
      expect(cells[lastSeenIdx]).toBe(new Date(1753386400000).toISOString());

      const zeroCsv = buildGatewaysCsv([gatewayRow({ firstSeen: 0, lastSeen: 0 })]);
      const zeroCells = zeroCsv.split('\r\n')[1].split(',');
      expect(zeroCells[firstSeenIdx]).toBe('');
      expect(zeroCells[lastSeenIdx]).toBe('');
    });
  });

  describe('buildPacketsCsv', () => {
    it('C5: includes kind as the first column and renders bitfield: 0 as "0" (not blank)', () => {
      const csv = buildPacketsCsv([packetRow({ bitfield: 0 })]);
      const lines = csv.split('\r\n');
      expect(PACKET_CSV_COLUMNS[0].key).toBe('kind');
      const cells = lines[1].split(',');
      expect(cells[0]).toBe('confirmed');
      const bitfieldIdx = PACKET_CSV_COLUMNS.findIndex((c) => c.key === 'bitfield');
      expect(cells[bitfieldIdx]).toBe('0');
    });

    it('renders timestamp and rxTime as ISO-8601 UTC and null rxTime as empty', () => {
      const csv = buildPacketsCsv([packetRow({ rxTime: null, timestamp: 1753386400000 })]);
      const cells = csv.split('\r\n')[1].split(',');
      const timestampIdx = PACKET_CSV_COLUMNS.findIndex((c) => c.key === 'timestamp');
      const rxTimeIdx = PACKET_CSV_COLUMNS.findIndex((c) => c.key === 'rxTime');
      expect(cells[timestampIdx]).toBe(new Date(1753386400000).toISOString());
      expect(cells[rxTimeIdx]).toBe('');
    });
  });

  describe('filenames', () => {
    it('C6: gatewaysCsvFilename has no ":" or "." in the stamp; packetsCsvFilename strips "!" and keeps the hex', () => {
      const d = new Date('2026-07-24T18:05:00.000Z');
      const gatewayName = gatewaysCsvFilename(d);
      expect(gatewayName).toMatch(/^mqtt-oktomqtt-violations-gateways-.+\.csv$/);
      expect(gatewayName).not.toContain(':');
      expect(gatewayName).not.toContain('.csv.');
      expect(gatewayName.slice(0, -4)).not.toContain('.');

      const packetName = packetsCsvFilename('!433e0f28', d);
      expect(packetName).toContain('433e0f28');
      expect(packetName).not.toContain('!');
      expect(packetName).not.toContain(':');
    });
  });

  describe('buildViolationParams', () => {
    it('C7: emits lookbackDays and no since/until when dates are empty', () => {
      const qs = buildViolationParams(DEFAULT_VIOLATION_FILTERS);
      const params = new URLSearchParams(qs);
      expect(params.get('lookbackDays')).toBe('7');
      expect(params.has('since')).toBe(false);
      expect(params.has('until')).toBe(false);
    });

    it('C7: emits since+until and no lookbackDays when both dates are set, with until normalized to 23:59:59.999', () => {
      const qs = buildViolationParams({
        ...DEFAULT_VIOLATION_FILTERS,
        from: '2026-07-01',
        to: '2026-07-02',
      });
      const params = new URLSearchParams(qs);
      expect(params.has('lookbackDays')).toBe(false);
      expect(params.has('since')).toBe(true);
      expect(params.has('until')).toBe(true);
      const untilMs = Number(params.get('until'));
      const untilDate = new Date(untilMs);
      expect(untilDate.getHours()).toBe(23);
      expect(untilDate.getMinutes()).toBe(59);
      expect(untilDate.getSeconds()).toBe(59);
      expect(untilDate.getMilliseconds()).toBe(999);
    });

    it('C7: omits includeUnknown entirely when false and emits includeUnknown=true when true', () => {
      const off = new URLSearchParams(buildViolationParams(DEFAULT_VIOLATION_FILTERS));
      expect(off.has('includeUnknown')).toBe(false);

      const on = new URLSearchParams(
        buildViolationParams({ ...DEFAULT_VIOLATION_FILTERS, includeUnknown: true }),
      );
      expect(on.get('includeUnknown')).toBe('true');
    });

    it('C7: clamps lookbackDays to 1..365', () => {
      const tooLow = new URLSearchParams(
        buildViolationParams({ ...DEFAULT_VIOLATION_FILTERS, lookbackDays: 0 }),
      );
      expect(tooLow.get('lookbackDays')).toBe('1');

      const tooHigh = new URLSearchParams(
        buildViolationParams({ ...DEFAULT_VIOLATION_FILTERS, lookbackDays: 9000 }),
      );
      expect(tooHigh.get('lookbackDays')).toBe('365');
    });

    it('honors sort/dir/limit/offset/gateway overrides via extra (drill-down use)', () => {
      const params = new URLSearchParams(
        buildViolationParams(DEFAULT_VIOLATION_FILTERS, {
          gateway: '!433e0f28',
          sort: 'timestamp',
          dir: 'asc',
          limit: 100,
          offset: 50,
        }),
      );
      expect(params.get('gateway')).toBe('!433e0f28');
      expect(params.get('sort')).toBe('timestamp');
      expect(params.get('dir')).toBe('asc');
      expect(params.get('limit')).toBe('100');
      expect(params.get('offset')).toBe('50');
    });
  });
});
