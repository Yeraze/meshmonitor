/**
 * Coverage Report CSV/GeoJSON export builders (#5277 Phase 4a WP1).
 *
 * Client-side, over exactly the rows the report has already loaded
 * (`receptionsQuery.data.items` — Decision A4): what the user sees is what
 * gets exported, filters/privacy/10k-cap included, and a truncated load says
 * so. See `COVERAGE_P4_SPEC.md` §2a.4.
 *
 * `escapeCsv` (`nodeExport.ts`) is reused verbatim, per the reuse inventory
 * ("exported for reuse, do not fork"). The formula-injection guard lives
 * here, not in `escapeCsv` (Decision A5).
 *
 * `src/utils/**` is in `tsconfig.server.json`'s include set, so relative
 * imports need an explicit `.js` extension (#4596).
 */
import type { CoverageReceptionDto } from '../types/coverage.js';
import type { CoverageExportContext, CoverageGap } from '../types/coverageAnalysis.js';
import { calculateDistance } from './distance.js';
import { escapeCsv } from './nodeExport.js';
import { receiverKey } from './coverageReceiverFilter.js';

export type { CoverageExportContext } from '../types/coverageAnalysis.js';

type ExportColumnKind = 'text' | 'number';

interface ExportColumn {
  key: string;
  label: string;
  kind: ExportColumnKind;
}

/**
 * Column order is part of the export contract (§2a.4) — do not reorder
 * without a spec update; consumers may rely on positional columns.
 */
const CSV_COLUMNS: ExportColumn[] = [
  { key: 'receivedAt', label: 'receivedAt', kind: 'text' },
  { key: 'receivedAtMs', label: 'receivedAtMs', kind: 'number' },
  { key: 'protocol', label: 'protocol', kind: 'text' },
  { key: 'senderId', label: 'senderId', kind: 'text' },
  { key: 'senderName', label: 'senderName', kind: 'text' },
  { key: 'latitude', label: 'latitude', kind: 'number' },
  { key: 'longitude', label: 'longitude', kind: 'number' },
  { key: 'altitude', label: 'altitude', kind: 'number' },
  { key: 'precisionBits', label: 'precisionBits', kind: 'number' },
  { key: 'sourceId', label: 'sourceId', kind: 'text' },
  { key: 'sourceName', label: 'sourceName', kind: 'text' },
  { key: 'receiverKind', label: 'receiverKind', kind: 'text' },
  { key: 'receiverId', label: 'receiverId', kind: 'text' },
  { key: 'receiverName', label: 'receiverName', kind: 'text' },
  { key: 'receiverLatitude', label: 'receiverLatitude', kind: 'number' },
  { key: 'receiverLongitude', label: 'receiverLongitude', kind: 'number' },
  { key: 'distanceKm', label: 'distanceKm', kind: 'number' },
  { key: 'snr', label: 'snr', kind: 'number' },
  { key: 'rssi', label: 'rssi', kind: 'number' },
  { key: 'hopsAway', label: 'hopsAway', kind: 'number' },
  { key: 'hopStart', label: 'hopStart', kind: 'number' },
  { key: 'hopLimit', label: 'hopLimit', kind: 'number' },
  { key: 'relayNode', label: 'relayNode', kind: 'number' },
  { key: 'pathKey', label: 'pathKey', kind: 'text' },
  { key: 'packetKey', label: 'packetKey', kind: 'text' },
  { key: 'channel', label: 'channel', kind: 'number' },
];

/**
 * A cell starting with `=`, `+`, `-`, `@`, tab, or CR is a formula trigger in
 * Excel/LibreOffice/Sheets. Node/sender names come off the mesh, so a name
 * like `=HYPERLINK(...)` must not execute when the export is opened. Applied
 * to TEXT columns only — never to numbers, so a genuine `-7.5` SNR value
 * stays numeric (it is written by `String(number)`, which never matches this
 * pattern for a column of `kind: 'number'` since those are never guarded).
 */
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;

function guardFormulaInjection(value: string): string {
  return FORMULA_TRIGGER_RE.test(value) ? `'${value}` : value;
}

function buildExportFields(
  item: CoverageReceptionDto,
  ctx: Pick<CoverageExportContext, 'senderNames' | 'receiverNames' | 'sourceNames'>,
): Record<string, string | number | null> {
  const key = receiverKey(item.sourceId, item.receiverId);
  const senderName = ctx.senderNames.get(item.senderId) ?? '';
  const receiverName = ctx.receiverNames.get(key) ?? '';
  const sourceName = ctx.sourceNames.get(item.sourceId) ?? '';

  const distanceKm =
    item.receiverLatitude != null && item.receiverLongitude != null
      ? calculateDistance(item.receiverLatitude, item.receiverLongitude, item.latitude, item.longitude)
      : null;

  return {
    receivedAt: new Date(item.receivedAt).toISOString(),
    receivedAtMs: item.receivedAt,
    protocol: item.protocol,
    senderId: item.senderId,
    senderName,
    latitude: item.latitude,
    longitude: item.longitude,
    altitude: item.altitude,
    precisionBits: item.precisionBits,
    sourceId: item.sourceId,
    sourceName,
    receiverKind: item.receiverKind,
    receiverId: item.receiverId,
    receiverName,
    receiverLatitude: item.receiverLatitude,
    receiverLongitude: item.receiverLongitude,
    distanceKm,
    snr: item.snr,
    rssi: item.rssi,
    hopsAway: item.hopsAway,
    hopStart: item.hopStart,
    hopLimit: item.hopLimit,
    relayNode: item.relayNode,
    pathKey: item.pathKey,
    packetKey: item.packetKey,
    channel: item.channel,
  };
}

function formatCsvCell(raw: string | number | null, kind: ExportColumnKind): string {
  if (raw === null || raw === undefined) return '';
  if (kind === 'text') {
    return escapeCsv(guardFormulaInjection(String(raw)));
  }
  return escapeCsv(String(raw));
}

/**
 * RFC 4180 CSV (CRLF line endings), one row per reception, columns per
 * `CSV_COLUMNS`. Formula-injection guarded on text columns (see
 * {@link guardFormulaInjection}).
 */
export function buildCoverageCsv(items: CoverageReceptionDto[], ctx: CoverageExportContext): string {
  const header = CSV_COLUMNS.map((c) => escapeCsv(c.label)).join(',');
  const rows = items.map((item) => {
    const fields = buildExportFields(item, ctx);
    return CSV_COLUMNS.map((c) => formatCsvCell(fields[c.key], c.kind)).join(',');
  });
  return [header, ...rows].join('\r\n');
}

/**
 * RFC 7946 GeoJSON `FeatureCollection`. One `Point` feature per reception
 * (`[lon, lat]`, `[lon, lat, alt]` when altitude is known), properties =
 * the same fields as the CSV columns (as native JSON types, not
 * formula-guarded — that guard exists for spreadsheet software, not
 * geojson.io/GIS tooling). Gaps (when passed) become `LineString` features
 * tagged `{ kind: 'likely_gap', durationSec, distanceM, missedEstimate }`.
 * Top-level foreign member `meshmonitor: { generatedAt, truncated, filters }`.
 */
export function buildCoverageGeoJson(
  items: CoverageReceptionDto[],
  ctx: CoverageExportContext & { gaps?: CoverageGap[] },
): string {
  const pointFeatures = items.map((item) => {
    const fields = buildExportFields(item, ctx);
    const coordinates =
      item.altitude != null ? [item.longitude, item.latitude, item.altitude] : [item.longitude, item.latitude];
    return {
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates },
      properties: fields,
    };
  });

  const gapFeatures = (ctx.gaps ?? []).map((gap) => ({
    type: 'Feature' as const,
    geometry: {
      type: 'LineString' as const,
      coordinates: [
        [gap.from.longitude, gap.from.latitude],
        [gap.to.longitude, gap.to.latitude],
      ],
    },
    properties: {
      kind: 'likely_gap' as const,
      durationSec: gap.durationSec,
      distanceM: gap.distanceM,
      missedEstimate: gap.missedEstimate,
    },
  }));

  const featureCollection = {
    type: 'FeatureCollection' as const,
    features: [...pointFeatures, ...gapFeatures],
    meshmonitor: {
      generatedAt: ctx.generatedAt,
      truncated: ctx.truncated,
      filters: ctx.filters,
    },
  };

  return JSON.stringify(featureCollection, null, 2);
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '') || 'x';
}

function formatFilenameTimestamp(ms: number): string {
  // '2026-09-24T10:00:00.000Z' -> '20260924T100000Z'
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** `coverage_<sender-or-all>_<since>_<until>.<ext>`, filesystem-safe. */
export function coverageExportFilename(
  ext: 'csv' | 'geojson',
  senderId: string | null,
  sinceMs: number,
  untilMs: number,
): string {
  const senderPart = senderId ? sanitizeForFilename(senderId) : 'all';
  const sincePart = formatFilenameTimestamp(sinceMs);
  const untilPart = formatFilenameTimestamp(untilMs);
  return `coverage_${senderPart}_${sincePart}_${untilPart}.${ext}`;
}
