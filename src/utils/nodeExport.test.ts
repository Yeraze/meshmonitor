import { describe, it, expect } from 'vitest';
import type { DeviceInfo } from '../types/device';
import {
  buildNodeExportRows,
  nodesToCsv,
  nodesToHtml,
  NODE_EXPORT_COLUMNS,
  type NodeExportContext,
} from './nodeExport';

const ctx: NodeExportContext = {
  nodeHopsCalculation: 'nodeinfo',
  currentNodeId: '!aaaaaaaa',
  currentNodeNum: 0xaaaaaaaa,
  formatLastHeard: (s) => `T${s}`,
};

function makeNode(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    nodeNum: 0x12345678,
    user: {
      id: '!12345678',
      longName: 'Test Node',
      shortName: 'TN01',
      hwModel: 9, // RAK4631
      role: '2', // Router
    },
    hopsAway: 2,
    snr: 5.25,
    rssi: -90,
    deviceMetrics: { batteryLevel: 87, voltage: 4.011 },
    channel: 3,
    firmwareVersion: '2.5.0',
    position: { latitude: 35.123456789, longitude: -97.987654321 },
    lastHeard: 1700000000,
    ...overrides,
  };
}

describe('nodeExport', () => {
  describe('buildNodeExportRows', () => {
    it('maps node fields into stringified export rows', () => {
      const [row] = buildNodeExportRows([makeNode()], ctx);
      expect(row).toMatchObject({
        longName: 'Test Node',
        shortName: 'TN01',
        nodeId: '!12345678',
        hardware: 'RAK4631',
        role: 'Router',
        firmware: '2.5.0',
        hopsAway: '2',
        snr: '5.3', // one decimal
        rssi: '-90',
        battery: '87',
        voltage: '4.01', // two decimals
        channel: '3',
        latitude: '35.123457', // six decimals
        longitude: '-97.987654',
        lastHeard: 'T1700000000',
      });
    });

    it('blanks missing/unknown values rather than emitting null', () => {
      const sparse: DeviceInfo = { nodeNum: 0x000000ff };
      const [row] = buildNodeExportRows([sparse], ctx);
      expect(row.longName).toBe('Node 255');
      expect(row.nodeId).toBe('!000000ff'); // hex fallback, zero-padded
      expect(row.shortName).toBe('');
      expect(row.hardware).toBe('');
      expect(row.role).toBe('');
      expect(row.firmware).toBe('');
      expect(row.snr).toBe('');
      expect(row.battery).toBe('');
      expect(row.latitude).toBe('');
      expect(row.lastHeard).toBe('');
    });

    it('treats the local node as 0 hops away', () => {
      const local = makeNode({
        nodeNum: 0xaaaaaaaa,
        user: { id: '!aaaaaaaa', longName: 'Me' },
        hopsAway: 7,
      });
      const [row] = buildNodeExportRows([local], ctx);
      expect(row.hopsAway).toBe('0');
    });

    it('blanks hops when unknown (effective hops === 999)', () => {
      const unknown = makeNode({ hopsAway: undefined, lastMessageHops: undefined });
      const [row] = buildNodeExportRows([unknown], ctx);
      expect(row.hopsAway).toBe('');
    });

    it('defaults lastHeard to ISO 8601 when no formatter is provided', () => {
      const [row] = buildNodeExportRows([makeNode({ lastHeard: 1700000000 })], {
        nodeHopsCalculation: 'nodeinfo',
      });
      expect(row.lastHeard).toBe('2023-11-14T22:13:20.000Z');
    });
  });

  describe('nodesToCsv', () => {
    it('emits a header row matching the column labels', () => {
      const csv = nodesToCsv([]);
      expect(csv).toBe(NODE_EXPORT_COLUMNS.map((c) => c.label).join(','));
    });

    it('uses CRLF line endings between rows', () => {
      const csv = nodesToCsv(buildNodeExportRows([makeNode()], ctx));
      const lines = csv.split('\r\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('Long Name');
      expect(lines[1]).toContain('Test Node');
    });

    it('escapes fields containing commas, quotes and newlines per RFC 4180', () => {
      const tricky = makeNode({
        user: { id: '!1', longName: 'A, "B"\nC', shortName: 'x' },
      });
      const csv = nodesToCsv(buildNodeExportRows([tricky], ctx));
      expect(csv).toContain('"A, ""B""\nC"');
    });
  });

  describe('nodesToHtml', () => {
    it('produces a standalone document with one row per node', () => {
      const html = nodesToHtml(buildNodeExportRows([makeNode(), makeNode()], ctx));
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1].match(/<tr>/g)).toHaveLength(2);
      expect(html).toContain('<th>Long Name</th>');
    });

    it('escapes HTML to prevent injection from node names', () => {
      const xss = makeNode({
        user: { id: '!1', longName: '<script>alert(1)</script>', shortName: 'x' },
      });
      const html = nodesToHtml(buildNodeExportRows([xss], ctx));
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('shows the node count and generation time in the subtitle', () => {
      const html = nodesToHtml(buildNodeExportRows([makeNode()], ctx), {
        generatedAt: '2023-11-14 22:13',
      });
      expect(html).toContain('1 node');
      expect(html).toContain('generated 2023-11-14 22:13');
    });
  });
});
