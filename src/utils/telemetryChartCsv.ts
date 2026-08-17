/**
 * CSV builders for telemetry graph export.
 *
 * Pure, DOM-free — download side-effect is `downloadTextFile` (nodeExport.ts).
 */
import { escapeCsv } from './nodeExport.js';

/** One plotted point (display-scaled series from TelemetryGraphs / TelemetryChart). */
export interface TelemetryCsvRow {
  timestamp: number;
  value: number | null;
  solarEstimate?: number | null;
  paxWifi?: number | null;
  paxBle?: number | null;
}

export interface TelemetryCsvMeta {
  nodeId: string;
  telemetryType: string;
  unit: string;
  hours: number;
}

export const TELEMETRY_CSV_BASE_COLUMNS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'timestamp', label: 'Timestamp' },
  { key: 'timestampMs', label: 'Timestamp Ms' },
  { key: 'value', label: 'Value' },
  { key: 'unit', label: 'Unit' },
  { key: 'telemetryType', label: 'Telemetry Type' },
  { key: 'nodeId', label: 'Node Id' },
];

export const TELEMETRY_CSV_OPTIONAL_COLUMNS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'solarEstimate', label: 'Solar Estimate' },
  { key: 'paxWifi', label: 'Pax Wifi' },
  { key: 'paxBle', label: 'Pax Ble' },
];

function csvRow(cells: string[]): string {
  return cells.map(escapeCsv).join(',');
}

function formatIso(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp === 0) return '';
  return new Date(timestamp).toISOString();
}

function formatCell(value: string | number | null | undefined): string {
  if (value == null) return '';
  return String(value);
}

function hasAny(
  rows: TelemetryCsvRow[],
  key: 'solarEstimate' | 'paxWifi' | 'paxBle',
): boolean {
  return rows.some((row) => row[key] != null);
}

/**
 * RFC 4180, CRLF, no BOM. Base columns always; optional solar/pax columns
 * only when any row carries that field.
 */
export function telemetrySeriesToCsv(rows: TelemetryCsvRow[], meta: TelemetryCsvMeta): string {
  const includeSolar = hasAny(rows, 'solarEstimate');
  const includePaxWifi = hasAny(rows, 'paxWifi');
  const includePaxBle = hasAny(rows, 'paxBle');

  const labels = [
    ...TELEMETRY_CSV_BASE_COLUMNS.map((c) => c.label),
    ...(includeSolar ? ['Solar Estimate'] : []),
    ...(includePaxWifi ? ['Pax Wifi'] : []),
    ...(includePaxBle ? ['Pax Ble'] : []),
  ];

  const header = csvRow(labels);
  const body = rows.map((row) => {
    const cells = [
      formatIso(row.timestamp),
      formatCell(row.timestamp),
      formatCell(row.value),
      formatCell(meta.unit),
      formatCell(meta.telemetryType),
      formatCell(meta.nodeId),
    ];
    if (includeSolar) cells.push(formatCell(row.solarEstimate));
    if (includePaxWifi) cells.push(formatCell(row.paxWifi));
    if (includePaxBle) cells.push(formatCell(row.paxBle));
    return csvRow(cells);
  });

  return [header, ...body].join('\r\n');
}

/** Strip characters unsafe in filenames; keep alphanumerics, `!`, `-`, `_`. */
export function sanitizeTelemetryFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9!_-]/g, '_');
}

/** `telemetry-{nodeId}-{type}-{hours}h.csv` */
export function buildTelemetryFilename(
  nodeId: string,
  telemetryType: string,
  hours: number,
): string {
  const node = sanitizeTelemetryFilenamePart(nodeId);
  const type = sanitizeTelemetryFilenamePart(telemetryType);
  const h = Number.isFinite(hours) ? Math.max(0, Math.round(hours)) : 0;
  return `telemetry-${node}-${type}-${h}h.csv`;
}
