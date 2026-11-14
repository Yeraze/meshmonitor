/**
 * Direct RF Contacts report (#6210): shared types plus the pure helpers
 * (window presets, sorting, CSV) so they are tested without a DOM.
 */
import { escapeCsv } from '../../utils/nodeExport';
import { guardFormulaInjection } from '../../utils/coverageExport';

/** One row of `GET /api/sources/:id/direct-rf-contacts`. */
export interface DirectRfContact {
  nodeKey: string;
  nodeNum: number | null;
  protocol: 'meshtastic' | 'meshcore';
  name: string | null;
  shortName: string | null;
  firstHeardAt: number;
  lastHeardAt: number;
  receptionCount: number;
  daysHeard: number;
  bestSnr: number | null;
  avgSnr: number | null;
  bestRssi: number | null;
  avgRssi: number | null;
  distanceKm: number | null;
}

export interface DirectRfContactsResponse {
  sourceId: string;
  from: number;
  to: number;
  retentionDays: number;
  contacts: DirectRfContact[];
}

export interface DirectRfDailyPoint {
  dayBucket: number;
  receptionCount: number;
  firstHeardAt: number;
  lastHeardAt: number;
  bestSnr: number | null;
  bestRssi: number | null;
}

export interface DirectRfNodeResponse {
  sourceId: string;
  nodeKey: string;
  from: number;
  to: number;
  retentionDays: number;
  summary: DirectRfContact | null;
  daily: DirectRfDailyPoint[];
}

export type DirectRfPreset = '24h' | '7d' | '30d' | 'custom';

export const PRESET_MS: Record<Exclude<DirectRfPreset, 'custom'>, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

/**
 * Resolve a preset (or a custom pair of `YYYY-MM-DD` local dates) to a
 * [from, to] window in ms. Null when a custom range is incomplete or empty.
 */
export function resolveWindow(
  preset: DirectRfPreset,
  nowMs: number,
  customFrom?: string,
  customTo?: string,
): { from: number; to: number } | null {
  if (preset !== 'custom') return { from: nowMs - PRESET_MS[preset], to: nowMs };
  if (!customFrom || !customTo) return null;
  const from = new Date(`${customFrom}T00:00:00`).getTime();
  const to = new Date(`${customTo}T23:59:59.999`).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null;
  return { from, to };
}

export type DirectRfSortKey =
  | 'name'
  | 'firstHeardAt'
  | 'lastHeardAt'
  | 'receptionCount'
  | 'bestSnr'
  | 'avgSnr'
  | 'bestRssi'
  | 'avgRssi'
  | 'distanceKm';

export function contactLabel(c: Pick<DirectRfContact, 'name' | 'shortName' | 'nodeKey' | 'protocol'>): string {
  if (c.name) return c.name;
  if (c.shortName) return c.shortName;
  return c.protocol === 'meshcore' ? `${c.nodeKey.slice(0, 12)}…` : c.nodeKey;
}

/** Sort rows; nulls always last whatever the direction. Returns a new array. */
export function sortContacts(rows: DirectRfContact[], key: DirectRfSortKey, dir: 'asc' | 'desc'): DirectRfContact[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === 'name') {
      return sign * contactLabel(a).localeCompare(contactLabel(b), undefined, { sensitivity: 'base' });
    }
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return sign * (av - bv);
  });
}

const iso = (ms: number): string => new Date(ms).toISOString();
const numCell = (n: number | null): string => (n == null ? '' : String(n));
const textCell = (s: string | null): string => escapeCsv(guardFormulaInjection(s ?? ''));

const CSV_HEADER = [
  'node_id', 'name', 'short_name', 'protocol',
  'first_heard_direct', 'last_heard_direct', 'direct_receptions', 'days_heard',
  'best_snr_db', 'avg_snr_db', 'best_rssi_dbm', 'avg_rssi_dbm', 'distance_km',
];

/** RFC 4180 CSV (CRLF). Names come off the mesh, so text cells are formula-guarded. */
export function buildDirectRfCsv(rows: DirectRfContact[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push([
      textCell(r.nodeKey),
      textCell(r.name),
      textCell(r.shortName),
      r.protocol,
      iso(r.firstHeardAt),
      iso(r.lastHeardAt),
      String(r.receptionCount),
      String(r.daysHeard),
      numCell(r.bestSnr),
      numCell(r.avgSnr),
      numCell(r.bestRssi),
      numCell(r.avgRssi),
      numCell(r.distanceKm),
    ].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

export function directRfCsvFilename(sourceName: string, from: number, to: number): string {
  const safe = sourceName.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'source';
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return `direct-rf-contacts_${safe}_${day(from)}_${day(to)}.csv`;
}

/** Source types whose own radio feeds this report. */
export function isDirectRfSourceType(type: string | undefined): boolean {
  return type === 'meshtastic_tcp' || type === 'meshcore';
}

/** Days shown by the node detail "Direct RF" section. */
export const DIRECT_RF_SECTION_DAYS = 30;

/** One slot per UTC day ending today, oldest first; days with no row count 0. */
export function buildDailySlots(daily: DirectRfDailyPoint[], nowMs: number, days = DIRECT_RF_SECTION_DAYS): number[] {
  const dayMs = 86_400_000;
  const today = Math.floor(nowMs / dayMs) * dayMs;
  const byDay = new Map(daily.map((d) => [d.dayBucket, d.receptionCount]));
  const out: number[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(byDay.get(today - i * dayMs) ?? 0);
  return out;
}
