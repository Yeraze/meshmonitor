import type { DeviceInfo } from '../types/device';
import type { NodeHopsCalculation } from '../contexts/SettingsContext';
import { getRoleName, getHardwareModelName, getEffectivePosition } from './nodeHelpers';
import { getEffectiveHops } from './nodeHops';

/**
 * Node List Export (Issue #3499)
 *
 * Produces CSV / HTML exports of the currently-displayed node list for mesh
 * upgrade planning. Values are the same *current* values shown in the UI — not
 * historical averages — so columns are labelled accordingly (e.g. "SNR (dB)",
 * not "Avg. SNR"), because MeshMonitor stores instantaneous node state.
 *
 * This module is pure/transform-only and framework-agnostic so it can be unit
 * tested without a DOM; the single DOM helper (`downloadTextFile`) is isolated
 * at the bottom.
 */

/** Traceroute shape accepted by getEffectiveHops (its own type is not exported). */
type TracerouteList = Parameters<typeof getEffectiveHops>[2];

export interface NodeExportContext {
  /** Hop calculation mode (mirrors the node list display). */
  nodeHopsCalculation: NodeHopsCalculation;
  /** Traceroute data, only used by the 'traceroute' hop calculation mode. */
  traceroutes?: TracerouteList;
  /** Local node number, used by the 'traceroute' hop calculation mode. */
  currentNodeNum?: number | null;
  /** Local node id (hex). The local node is always treated as 0 hops away. */
  currentNodeId?: string | null;
  /** Formats a Unix timestamp (seconds). Defaults to ISO 8601 UTC. */
  formatLastHeard?: (unixSeconds: number) => string;
}

/** One fully-stringified export row, keyed by column. */
export interface NodeExportRow {
  longName: string;
  shortName: string;
  nodeId: string;
  hardware: string;
  role: string;
  firmware: string;
  hopsAway: string;
  snr: string;
  rssi: string;
  battery: string;
  voltage: string;
  channel: string;
  latitude: string;
  longitude: string;
  lastHeard: string;
}

/** Ordered column definitions shared by CSV and HTML output. */
export const NODE_EXPORT_COLUMNS: { key: keyof NodeExportRow; label: string }[] = [
  { key: 'longName', label: 'Long Name' },
  { key: 'shortName', label: 'Short Name' },
  { key: 'nodeId', label: 'Node ID' },
  { key: 'hardware', label: 'Hardware' },
  { key: 'role', label: 'Role' },
  { key: 'firmware', label: 'Firmware' },
  { key: 'hopsAway', label: 'Hops Away' },
  { key: 'snr', label: 'SNR (dB)' },
  { key: 'rssi', label: 'RSSI (dBm)' },
  { key: 'battery', label: 'Battery (%)' },
  { key: 'voltage', label: 'Voltage (V)' },
  { key: 'channel', label: 'Channel' },
  { key: 'latitude', label: 'Latitude' },
  { key: 'longitude', label: 'Longitude' },
  { key: 'lastHeard', label: 'Last Heard' },
];

/** Format a node number as a Meshtastic hex id (e.g. !a1b2c3d4). */
function formatNodeIdHex(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Convert displayed nodes into fully-stringified export rows. Mirrors the
 * values the node list shows: effective hops, effective position, current
 * SNR/RSSI/battery/voltage.
 */
export function buildNodeExportRows(
  nodes: DeviceInfo[],
  ctx: NodeExportContext,
): NodeExportRow[] {
  const formatLastHeard =
    ctx.formatLastHeard ?? ((s: number) => new Date(s * 1000).toISOString());

  return nodes.map((node) => {
    const isLocal = !!ctx.currentNodeId && node.user?.id === ctx.currentNodeId;
    const hops = isLocal
      ? 0
      : getEffectiveHops(node, ctx.nodeHopsCalculation, ctx.traceroutes, ctx.currentNodeNum);
    const pos = getEffectivePosition(node);

    return {
      longName: node.user?.longName || `Node ${node.nodeNum}`,
      shortName: node.user?.shortName || '',
      nodeId: node.user?.id || formatNodeIdHex(node.nodeNum),
      hardware: getHardwareModelName(node.user?.hwModel) || '',
      role: getRoleName(node.user?.role) || '',
      firmware: node.firmwareVersion || '',
      hopsAway: hops < 999 ? String(hops) : '',
      snr: node.snr != null ? node.snr.toFixed(1) : '',
      rssi: node.rssi != null ? String(node.rssi) : '',
      battery:
        node.deviceMetrics?.batteryLevel != null
          ? String(node.deviceMetrics.batteryLevel)
          : '',
      voltage:
        node.deviceMetrics?.voltage != null
          ? node.deviceMetrics.voltage.toFixed(2)
          : '',
      channel: node.channel != null ? String(node.channel) : '',
      latitude: pos.latitude != null ? pos.latitude.toFixed(6) : '',
      longitude: pos.longitude != null ? pos.longitude.toFixed(6) : '',
      lastHeard: node.lastHeard ? formatLastHeard(node.lastHeard) : '',
    };
  });
}

/** Escape a single CSV field per RFC 4180. */
function escapeCsv(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Render export rows as RFC 4180 CSV (CRLF line endings, no BOM). */
export function nodesToCsv(rows: NodeExportRow[]): string {
  const header = NODE_EXPORT_COLUMNS.map((c) => escapeCsv(c.label)).join(',');
  const body = rows.map((row) =>
    NODE_EXPORT_COLUMNS.map((c) => escapeCsv(row[c.key])).join(','),
  );
  return [header, ...body].join('\r\n');
}

/** Escape text for safe interpolation into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface NodesToHtmlOptions {
  title?: string;
  /** Optional human-readable generation timestamp shown in the subtitle. */
  generatedAt?: string;
}

/** Render export rows as a standalone, styled, printable HTML document. */
export function nodesToHtml(rows: NodeExportRow[], opts: NodesToHtmlOptions = {}): string {
  const title = opts.title || 'MeshMonitor Node List';
  const subtitle = [
    `${rows.length} node${rows.length === 1 ? '' : 's'}`,
    opts.generatedAt ? `generated ${opts.generatedAt}` : null,
  ]
    .filter(Boolean)
    .join(' • ');

  const thead = NODE_EXPORT_COLUMNS.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('');
  const tbody = rows
    .map(
      (row) =>
        `<tr>${NODE_EXPORT_COLUMNS.map((c) => `<td>${escapeHtml(row[c.key])}</td>`).join('')}</tr>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  .subtitle { color: #666; font-size: 0.9rem; margin-bottom: 1rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; white-space: nowrap; }
  th { background: #2c3e50; color: #fff; position: sticky; top: 0; }
  tbody tr:nth-child(even) { background: #f6f8fa; }
  @media print { th { position: static; } body { margin: 0.5rem; } }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="subtitle">${escapeHtml(subtitle)}</div>
<table>
<thead><tr>${thead}</tr></thead>
<tbody>
${tbody}
</tbody>
</table>
</body>
</html>`;
}

/**
 * Trigger a browser download of text content. Isolated DOM side-effect so the
 * rest of this module stays pure and unit-testable.
 */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
