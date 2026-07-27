/**
 * CSV builders for the ok_to_mqtt violations report (#4114 Phase 3 §2(d) / §3.4).
 *
 * Pure, DOM-free — no `Blob`/`document`/`URL` anywhere in this file. The download
 * side-effect is `downloadTextFile` (src/utils/nodeExport.ts), mirroring the split
 * that module documents for `nodesToCsv`.
 */
import { escapeCsv } from '../../utils/nodeExport';
import type { ViolationGatewayRow, ViolationPacketRow } from './mqttViolationTypes';

export const GATEWAY_CSV_COLUMNS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'gatewayId', label: 'Gateway ID' },
  { key: 'gatewayNodeNum', label: 'Gateway Node Num' },
  // Name columns sit beside the id they describe rather than at the end: these
  // files are read by people, and a name several columns away from its id is
  // barely easier to scan than the bare id the report used to show. This does
  // shift the later columns' positions — a consumer indexing by position rather
  // than by header will need updating.
  { key: 'gatewayLongName', label: 'Gateway Long Name' },
  { key: 'gatewayShortName', label: 'Gateway Short Name' },
  { key: 'violationCount', label: 'Violation Count' },
  { key: 'suspectedCount', label: 'Suspected Count' },
  { key: 'distinctOriginators', label: 'Distinct Originators' },
  { key: 'sourceIds', label: 'Source IDs' },
  { key: 'firstSeen', label: 'First Seen' },
  { key: 'lastSeen', label: 'Last Seen' },
];

export const PACKET_CSV_COLUMNS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'kind', label: 'Kind' },
  { key: 'timestamp', label: 'Timestamp' },
  { key: 'sourceId', label: 'Source ID' },
  { key: 'packetId', label: 'Packet ID' },
  { key: 'fromNode', label: 'From Node' },
  { key: 'fromNodeId', label: 'From Node ID' },
  { key: 'fromLongName', label: 'From Long Name' },
  { key: 'fromShortName', label: 'From Short Name' },
  { key: 'gatewayId', label: 'Gateway ID' },
  { key: 'gatewayNodeNum', label: 'Gateway Node Num' },
  { key: 'gatewayLongName', label: 'Gateway Long Name' },
  { key: 'gatewayShortName', label: 'Gateway Short Name' },
  { key: 'channelId', label: 'Channel ID' },
  { key: 'portnum', label: 'Port Num' },
  { key: 'portnumName', label: 'Port Num Name' },
  { key: 'bitfield', label: 'Bitfield' },
  { key: 'topic', label: 'Topic' },
  { key: 'rxTime', label: 'RX Time' },
];

function csvRow(cells: string[]): string {
  return cells.map(escapeCsv).join(',');
}

/** ms epoch -> ISO-8601 UTC; `null`/`0` -> empty string (PHASE3 §2(d)). */
function formatMs(value: number | null | undefined): string {
  if (value == null || value === 0) return '';
  return new Date(value).toISOString();
}

/** Generic scalar cell: `null`/`undefined` -> '', everything else (incl. `0`) -> its string form. */
function formatCell(value: string | number | null | undefined): string {
  if (value == null) return '';
  return String(value);
}

/** RFC 4180, CRLF, no BOM. Column order per PHASE3 §2(d). */
export function buildGatewaysCsv(rows: ViolationGatewayRow[]): string {
  const header = csvRow(GATEWAY_CSV_COLUMNS.map((c) => c.label));
  const body = rows.map((row) =>
    csvRow([
      formatCell(row.gatewayId),
      formatCell(row.gatewayNodeNum),
      formatCell(row.gatewayLongName),
      formatCell(row.gatewayShortName),
      formatCell(row.violationCount),
      formatCell(row.suspectedCount),
      formatCell(row.distinctOriginators),
      row.sourceIds.join('; '),
      formatMs(row.firstSeen),
      formatMs(row.lastSeen),
    ]),
  );
  return [header, ...body].join('\r\n');
}

/** RFC 4180, CRLF, no BOM. Column order per PHASE3 §2(d). */
export function buildPacketsCsv(rows: ViolationPacketRow[]): string {
  const header = csvRow(PACKET_CSV_COLUMNS.map((c) => c.label));
  const body = rows.map((row) =>
    csvRow([
      formatCell(row.kind),
      formatMs(row.timestamp),
      formatCell(row.sourceId),
      formatCell(row.packetId),
      formatCell(row.fromNode),
      formatCell(row.fromNodeId),
      formatCell(row.fromLongName),
      formatCell(row.fromShortName),
      formatCell(row.gatewayId),
      formatCell(row.gatewayNodeNum),
      formatCell(row.gatewayLongName),
      formatCell(row.gatewayShortName),
      formatCell(row.channelId),
      formatCell(row.portnum),
      formatCell(row.portnumName),
      formatCell(row.bitfield),
      formatCell(row.topic),
      formatMs(row.rxTime),
    ]),
  );
  return [header, ...body].join('\r\n');
}

/** Colon-free timestamp stamp shared by both filename builders. */
function filenameStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** `mqtt-oktomqtt-violations-gateways-<stamp>.csv` */
export function gatewaysCsvFilename(now: Date = new Date()): string {
  return `mqtt-oktomqtt-violations-gateways-${filenameStamp(now)}.csv`;
}

/** `mqtt-oktomqtt-violations-<gatewaySlug>-<stamp>.csv` — strips the leading `!`. */
export function packetsCsvFilename(gatewayId: string, now: Date = new Date()): string {
  const slug = gatewayId.replace(/[^a-zA-Z0-9]/g, '');
  return `mqtt-oktomqtt-violations-${slug}-${filenameStamp(now)}.csv`;
}
