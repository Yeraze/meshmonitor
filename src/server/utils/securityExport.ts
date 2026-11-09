/**
 * One export for the Security tab (#6281 S6): CSV or JSON of every node the
 * collector reports, on both protocols. CSV goes through `csvRow`, so quotes,
 * commas, newlines and formula triggers are escaped properly.
 *
 * Meshtastic columns keep their order and new columns are appended; MeshCore
 * has its own column set. Nodes flagged only for spam or clock offset are
 * included (the old export listed key-issue nodes only).
 */
import { csvRow } from './messageCsv.js';
import type { CollectedSecurityIssues, SecurityIssueNode } from '../services/securityIssuesService.js';

export type SecurityExportFormat = 'csv' | 'json';

const ADV_TYPE_NAME: Record<number, string> = { 1: 'Companion', 2: 'Repeater', 3: 'Room Server' };

const yesNo = (b: boolean | undefined): string => (b ? 'Yes' : 'No');
const iso = (sec: number | null | undefined): string => (sec ? new Date(sec * 1000).toISOString() : 'Never');
const nodeId = (n: SecurityIssueNode): string =>
  n.protocol === 'meshcore' ? n.nodeKey : `!${Number(n.nodeNum).toString(16).padStart(8, '0')}`;

const MESHTASTIC_HEADER = [
  'Node ID', 'Short Name', 'Long Name', 'Hardware Model', 'Last Heard', 'Low-Entropy Key', 'Duplicate Key',
  'Time Offset', 'Offset (seconds)', 'Issue Details', 'Key Hash Prefix', 'Excessive Packets', 'Packets per Hour',
];

const MESHCORE_HEADER = [
  'Node Key', 'Name', 'Type', 'Last Heard', 'Excessive Packets', 'Packets per Hour', 'Adverts per Hour',
  'Time Offset', 'Offset (seconds)', 'Offset Source', 'Advert Signature Failed', 'Name Reused', 'Key Prefix',
];

function meshtasticRow(n: SecurityIssueNode): Array<string | number | null> {
  return [
    nodeId(n), n.shortName || 'Unknown', n.longName || 'Unknown', n.hwModel ?? '', iso(n.lastHeard),
    yesNo(n.keyIsLowEntropy), yesNo(n.duplicateKeyDetected), yesNo(n.isTimeOffsetIssue), n.timeOffsetSeconds ?? '',
    n.keySecurityIssueDetails || '', n.publicKey ? n.publicKey.substring(0, 16) : '',
    yesNo(n.isExcessivePackets), n.packetRatePerHour ?? '',
  ];
}

function meshcoreRow(n: SecurityIssueNode): Array<string | number | null> {
  return [
    n.nodeKey, n.longName || n.shortName || 'Unknown', n.advType != null ? (ADV_TYPE_NAME[n.advType] ?? '') : '',
    iso(n.lastHeard), yesNo(n.isExcessivePackets), n.packetRatePerHour ?? '', n.advertRatePerHour ?? '',
    yesNo(n.isTimeOffsetIssue), n.timeOffsetSeconds ?? '', n.timeOffsetSource ?? '',
    yesNo(n.advertSignatureFailed), yesNo(n.nameReused), n.publicKey ? n.publicKey.substring(0, 16) : '',
  ];
}

function jsonNode(n: SecurityIssueNode): Record<string, unknown> {
  const base = {
    nodeKey: n.nodeKey,
    protocol: n.protocol,
    nodeNum: n.nodeNum,
    nodeId: nodeId(n),
    shortName: n.shortName || 'Unknown',
    longName: n.longName || 'Unknown',
    hwModel: n.hwModel ?? null,
    lastHeard: n.lastHeard,
    lastHeardDate: n.lastHeard ? new Date(n.lastHeard * 1000).toISOString() : null,
    keyIsLowEntropy: n.keyIsLowEntropy,
    duplicateKeyDetected: n.duplicateKeyDetected,
    keySecurityIssueDetails: n.keySecurityIssueDetails ?? null,
    isExcessivePackets: n.isExcessivePackets,
    packetRatePerHour: n.packetRatePerHour,
    isTimeOffsetIssue: n.isTimeOffsetIssue,
    timeOffsetSeconds: n.timeOffsetSeconds,
    // Partial key hash for identification (first 16 chars only)
    keyHashPrefix: n.publicKey ? n.publicKey.substring(0, 16) : null,
  };
  if (n.protocol !== 'meshcore') return base;
  return {
    ...base,
    advType: n.advType ?? null,
    advertRatePerHour: n.advertRatePerHour ?? null,
    timeOffsetSource: n.timeOffsetSource ?? null,
    advertSignatureFailed: !!n.advertSignatureFailed,
    nameReused: !!n.nameReused,
  };
}

export function buildSecurityExport(
  issues: CollectedSecurityIssues,
  format: SecurityExportFormat,
  exportDate: string = new Date().toISOString(),
): { contentType: string; extension: string; body: string } {
  if (format === 'json') {
    const body = {
      exportDate,
      protocol: issues.protocol,
      total: issues.total,
      lowEntropyCount: issues.lowEntropyCount,
      duplicateKeyCount: issues.duplicateKeyCount,
      excessivePacketsCount: issues.excessivePacketsCount,
      timeOffsetCount: issues.timeOffsetCount,
      ...(issues.protocol === 'meshcore'
        ? {
            signatureFailureCount: issues.signatureFailureCount,
            nameReuseCount: issues.nameReuseCount,
            ownKeyChange: issues.ownKeyChange,
          }
        : {}),
      nodes: issues.nodes.map(jsonNode),
    };
    return { contentType: 'application/json', extension: 'json', body: JSON.stringify(body, null, 2) };
  }
  const meshcore = issues.protocol === 'meshcore';
  const header = meshcore ? MESHCORE_HEADER : MESHTASTIC_HEADER;
  const rows = issues.nodes.map(meshcore ? meshcoreRow : meshtasticRow);
  return {
    contentType: 'text/csv',
    extension: 'csv',
    body: csvRow(header) + rows.map((r) => csvRow(r)).join(''),
  };
}
