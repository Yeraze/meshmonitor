/**
 * Coverage Report import: constants and pure parser/validator
 * (#5891 Phase 3). Frontend-safe: no DB, no `src/server` imports.
 * Spec: docs/internal/dev-notes/WALKABOUT_P3_SPEC.md §3.4, §3.5.
 *
 * `src/utils/**` is in `tsconfig.server.json`'s include set, so relative
 * imports need an explicit `.js` extension (#4596).
 */
import { isBogusPosition } from './nullIsland.js';
import { parseMeshCorePathKey } from './coverage.js';
import { isAnyMeshCoreSourceType } from './nodeTypeCategory.js';
import { parseCsv } from './csvParse.js';
import type {
  CoverageImportFormat,
  CoverageImportRowError,
  ParsedCoverageImportRow,
  ParseCoverageImportResult,
} from '../types/coverageImport.js';

export const COVERAGE_IMPORT_MAX_BYTES = 32 * 1024 * 1024; // Q5
export const COVERAGE_IMPORT_MAX_ROWS = 10_000; // Q5 (= export cap and client display cap)
export const COVERAGE_IMPORT_MAX_PER_SOURCE = 50; // Q5, batches
export const COVERAGE_IMPORT_MAX_ROWS_PER_SOURCE = 200_000; // Q5, inserted rows across batches
export const COVERAGE_IMPORT_FILENAME_MAX = 200;
export const COVERAGE_IMPORT_MAX_ERRORS = 20;
export const COVERAGE_IMPORT_INSERT_CHUNK = 500;
export const COVERAGE_IMPORT_LIST_LIMIT = 200;
export const COVERAGE_IMPORT_EARLIEST_MS = Date.UTC(2020, 0, 1);
export const COVERAGE_IMPORT_FUTURE_SKEW_MS = 5 * 60_000;
export const COVERAGE_IMPORT_WRITE_GRANT = { resource: 'nodes', action: 'write' } as const; // Q3
export const COVERAGE_IMPORT_READ_GRANT = { resource: 'nodes', action: 'read' } as const;
export const COVERAGE_EXPORT_FORMAT = 'meshmonitor-coverage-report';
export const COVERAGE_EXPORT_VERSION = 1;

type ColKind = 'text' | 'number';

/**
 * The importer's own copy of the export columns (key = label). Kept separate
 * from `coverageExport.ts` to avoid an import cycle; a drift test keeps the
 * two equal.
 */
export const COVERAGE_IMPORT_COLUMNS: ReadonlyArray<{ key: string; kind: ColKind }> = [
  { key: 'receivedAt', kind: 'text' },
  { key: 'receivedAtMs', kind: 'number' },
  { key: 'protocol', kind: 'text' },
  { key: 'senderId', kind: 'text' },
  { key: 'senderName', kind: 'text' },
  { key: 'latitude', kind: 'number' },
  { key: 'longitude', kind: 'number' },
  { key: 'altitude', kind: 'number' },
  { key: 'precisionBits', kind: 'number' },
  { key: 'sourceId', kind: 'text' },
  { key: 'sourceName', kind: 'text' },
  { key: 'receiverKind', kind: 'text' },
  { key: 'receiverId', kind: 'text' },
  { key: 'receiverName', kind: 'text' },
  { key: 'receiverLatitude', kind: 'number' },
  { key: 'receiverLongitude', kind: 'number' },
  { key: 'distanceKm', kind: 'number' },
  { key: 'snr', kind: 'number' },
  { key: 'rssi', kind: 'number' },
  { key: 'hopsAway', kind: 'number' },
  { key: 'hopStart', kind: 'number' },
  { key: 'hopLimit', kind: 'number' },
  { key: 'relayNode', kind: 'number' },
  { key: 'pathKey', kind: 'text' },
  { key: 'packetKey', kind: 'text' },
  { key: 'channel', kind: 'number' },
];

type RowErrors = Array<Omit<CoverageImportRowError, 'row'>>;

function lastDotExt(filename: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  return m ? m[1].toLowerCase() : '';
}

export function detectCoverageImportFormat(filename: string, text: string): CoverageImportFormat | null {
  const ext = lastDotExt(filename);
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const first = stripped.trimStart().charAt(0);
  if (ext === 'csv') return first === '{' ? null : 'csv';
  if (ext === 'geojson' || ext === 'json') return first === '{' ? 'geojson' : null;
  return null;
}

const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;

/** Inverse of `guardFormulaInjection`. */
export function unguardFormulaInjection(value: string): string {
  return value.startsWith("'") && FORMULA_TRIGGER_RE.test(value.slice(1)) ? value.slice(1) : value;
}

const MESHTASTIC_ID_RE = /^![0-9a-fA-F]{8}$/;
const MESHCORE_ID_RE = /^[0-9a-fA-F]{64}$/;
const MESHTASTIC_PATH_RE = /^r(\d{1,3}|-):h(\d{1,2}|-)$/;
const MESHCORE_PACKET_RE = /^[0-9A-Fa-f]{16}$/;
const PACKET_KEY_MAX = 4294967295;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate one raw record (CSV cells already coerced: `''` -> null, numeric
 * text -> number, text unguarded; GeoJSON properties as-is). Collects every
 * field error for the row.
 */
export function validateCoverageImportRow(
  raw: Record<string, unknown>,
  nowMs: number,
): { row: ParsedCoverageImportRow } | { skipped: 'bogus_position' } | { errors: RowErrors } {
  const errors: RowErrors = [];
  let bogusPosition = false;
  const bad = (field: string, message: string) => errors.push({ field, message });
  const blank = (v: unknown) => v === null || v === undefined;

  const reqText = (field: string): string | null => {
    const v = raw[field];
    if (blank(v) || v === '') {
      bad(field, 'is required');
      return null;
    }
    if (typeof v !== 'string') {
      bad(field, 'must be text');
      return null;
    }
    return v;
  };
  const optNum = (field: string, min: number, max: number, integer: boolean): number | null => {
    const v = raw[field];
    if (blank(v)) return null;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      bad(field, 'must be a number');
      return null;
    }
    if (integer && !Number.isInteger(v)) {
      bad(field, 'must be a whole number');
      return null;
    }
    if (v < min || v > max) {
      bad(field, `must be between ${min} and ${max}`);
      return null;
    }
    return v;
  };

  const protocolRaw = reqText('protocol');
  const protocol = protocolRaw === 'meshtastic' || protocolRaw === 'meshcore' ? protocolRaw : null;
  if (protocolRaw !== null && protocol === null) bad('protocol', 'must be meshtastic or meshcore');

  const kindRaw = reqText('receiverKind');
  const receiverKind = kindRaw === 'local' || kindRaw === 'mqtt_gateway' ? kindRaw : null;
  if (kindRaw !== null && receiverKind === null) bad('receiverKind', 'must be local or mqtt_gateway');

  const checkId = (field: string): string | null => {
    const v = reqText(field);
    if (v === null || protocol === null) return null;
    if (protocol === 'meshtastic') {
      if (!MESHTASTIC_ID_RE.test(v)) {
        bad(field, 'must look like !0123abcd for Meshtastic');
        return null;
      }
    } else if (!MESHCORE_ID_RE.test(v)) {
      bad(field, 'must be 64 hex characters for MeshCore');
      return null;
    }
    return v.toLowerCase();
  };
  const senderId = checkId('senderId');
  const receiverId = checkId('receiverId');

  let packetKey: string | null = null;
  let packetId: number | null = null;
  const pk = reqText('packetKey');
  if (pk !== null && protocol !== null) {
    if (protocol === 'meshtastic') {
      if (/^\d{1,10}$/.test(pk) && Number(pk) <= PACKET_KEY_MAX) {
        packetId = Number(pk);
        packetKey = String(packetId);
      } else bad('packetKey', 'must be a whole number from 0 to 4294967295 for Meshtastic');
    } else if (MESHCORE_PACKET_RE.test(pk)) {
      packetKey = pk.toUpperCase();
    } else bad('packetKey', 'must be 16 hex characters for MeshCore');
  }

  let pathKey: string | null = null;
  const pth = reqText('pathKey');
  if (pth !== null && protocol !== null) {
    const ok = protocol === 'meshtastic' ? MESHTASTIC_PATH_RE.test(pth) : parseMeshCorePathKey(pth) !== null;
    if (ok) pathKey = pth;
    else bad('pathKey', `is not a valid ${protocol} path key`);
  }

  const reqCoord = (field: string, min: number, max: number): number | null => {
    const v = raw[field];
    if (blank(v)) {
      bad(field, 'is required');
      return null;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      bad(field, 'must be a number');
      return null;
    }
    if (v < min || v > max) {
      bad(field, `must be between ${min} and ${max}`);
      return null;
    }
    return v;
  };
  const latitude = reqCoord('latitude', -90, 90);
  const longitude = reqCoord('longitude', -180, 180);
  const precisionBits = optNum('precisionBits', 0, 32, true);
  if (latitude !== null && longitude !== null && isBogusPosition(latitude, longitude, precisionBits)) {
    bogusPosition = true;
  }
  const altitude = optNum('altitude', -100_000, 100_000, false);

  const rLat = optNum('receiverLatitude', -90, 90, false);
  const rLon = optNum('receiverLongitude', -180, 180, false);
  if ((rLat === null) !== (rLon === null) && !errors.some((e) => e.field === 'receiverLatitude' || e.field === 'receiverLongitude')) {
    bad(rLat === null ? 'receiverLatitude' : 'receiverLongitude', 'receiver latitude and longitude must both be set or both empty');
  } else if (rLat !== null && rLon !== null && isBogusPosition(rLat, rLon)) {
    bogusPosition = true;
  }

  const snr = optNum('snr', -50, 50, false);
  const rssi = optNum('rssi', -200, 20, true);
  const hopsAway = optNum('hopsAway', 0, 63, true);
  const hopStart = optNum('hopStart', 0, 7, true);
  const hopLimit = optNum('hopLimit', 0, 7, true);
  const relayNode = optNum('relayNode', 0, 255, true);
  const channel = optNum('channel', 0, 2 ** 31 - 1, true);

  // receivedAtMs / receivedAt
  let receivedAt: number | null = null;
  const ms = raw.receivedAtMs;
  if (blank(ms)) bad('receivedAtMs', 'is required');
  else if (typeof ms !== 'number' || !Number.isInteger(ms)) bad('receivedAtMs', 'must be a whole number of milliseconds');
  else if (ms < COVERAGE_IMPORT_EARLIEST_MS) bad('receivedAtMs', 'is before 2020-01-01');
  else if (ms > nowMs + COVERAGE_IMPORT_FUTURE_SKEW_MS) bad('receivedAtMs', 'is in the future');
  else receivedAt = ms;
  const iso = reqText('receivedAt');
  if (iso !== null && receivedAt !== null && Date.parse(iso) !== receivedAt) {
    bad('receivedAt', 'does not match receivedAtMs');
  }

  if (errors.length > 0) return { errors };
  if (bogusPosition) return { skipped: 'bogus_position' };

  const isMt = protocol === 'meshtastic';
  const nodeNum = (id: string): number | null => (isMt ? parseInt(id.slice(1), 16) : null);
  return {
    row: {
      protocol: protocol!,
      receiverKind: receiverKind!,
      receiverId: receiverId!,
      receiverNodeNum: nodeNum(receiverId!),
      receiverLatitude: rLat,
      receiverLongitude: rLon,
      senderId: senderId!,
      senderNodeNum: nodeNum(senderId!),
      packetKey: packetKey!,
      packetId,
      pathKey: pathKey!,
      latitude: latitude!,
      longitude: longitude!,
      altitude,
      precisionBits,
      snr,
      rssi,
      hopStart,
      hopLimit,
      hopsAway,
      relayNode,
      channel,
      receivedAt: receivedAt!,
    },
  };
}

const NUM_TEXT_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

type Collector = {
  rows: ParsedCoverageImportRow[];
  errors: CoverageImportRowError[];
  invalid: number;
  skippedBogus: number;
};

function addErrors(c: Collector, row: number, errs: RowErrors): void {
  c.invalid++;
  for (const e of errs) {
    if (c.errors.length >= COVERAGE_IMPORT_MAX_ERRORS) break;
    c.errors.push({ row, ...e });
  }
}

function fail(
  code: Extract<ParseCoverageImportResult, { ok: false }>['code'],
  message: string,
  errors: CoverageImportRowError[] = [],
): ParseCoverageImportResult {
  return { ok: false, code, message, errors };
}

function invalidRows(c: Collector): ParseCoverageImportResult {
  const more = c.invalid > c.errors.length ? ` (showing the first ${c.errors.length})` : '';
  return fail('IMPORT_INVALID_ROWS', `${c.invalid} invalid row${c.invalid === 1 ? '' : 's'}${more}; nothing was imported`, c.errors);
}

function parseCsvImport(text: string, nowMs: number): ParseCoverageImportResult {
  const { records, lines } = parseCsv(text);
  if (records.length === 0) return fail('IMPORT_EMPTY', 'The file has no header row');
  const header = records[0];
  for (let i = 0; i < Math.max(header.length, COVERAGE_IMPORT_COLUMNS.length); i++) {
    const want = COVERAGE_IMPORT_COLUMNS[i]?.key;
    const got = header[i];
    if (want !== got) {
      return fail(
        'IMPORT_SCHEMA_MISMATCH',
        want === undefined
          ? `Unexpected extra column "${got}" at position ${i + 1}`
          : `Column ${i + 1} should be "${want}" but is ${got === undefined ? 'missing' : `"${got}"`}`,
        [{ row: lines[0], field: want ?? got ?? null, message: 'header does not match the Coverage Report export' }],
      );
    }
  }
  const dataCount = records.length - 1;
  if (dataCount === 0) return fail('IMPORT_EMPTY', 'The file has no data rows');
  if (dataCount > COVERAGE_IMPORT_MAX_ROWS) {
    return fail('IMPORT_TOO_MANY_ROWS', `The file has ${dataCount} rows; the limit is ${COVERAGE_IMPORT_MAX_ROWS}`);
  }
  const c: Collector = { rows: [], errors: [], invalid: 0, skippedBogus: 0 };
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    if (rec.length !== COVERAGE_IMPORT_COLUMNS.length) {
      addErrors(c, lines[r], [
        { field: null, message: `has ${rec.length} cells, expected ${COVERAGE_IMPORT_COLUMNS.length}` },
      ]);
      continue;
    }
    const raw: Record<string, unknown> = {};
    COVERAGE_IMPORT_COLUMNS.forEach((col, i) => {
      const cell = rec[i];
      if (cell === '') raw[col.key] = null;
      else if (col.kind === 'number') raw[col.key] = NUM_TEXT_RE.test(cell) ? Number(cell) : cell;
      else raw[col.key] = unguardFormulaInjection(cell);
    });
    const res = validateCoverageImportRow(raw, nowMs);
    if ('row' in res) c.rows.push(res.row);
    else if ('skipped' in res) c.skippedBogus++;
    else addErrors(c, lines[r], res.errors);
  }
  if (c.invalid > 0) return invalidRows(c);
  return { ok: true, format: 'csv', rows: c.rows, gapFeatures: 0, sourceTruncated: false, skippedBogusPositions: c.skippedBogus };
}

function parseGeoJsonImport(text: string, nowMs: number): ParseCoverageImportResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return fail('IMPORT_UNSUPPORTED_FILE', 'The file is not valid JSON');
  }
  if (!isObj(doc) || doc.type !== 'FeatureCollection') {
    return fail('IMPORT_NOT_MESHMONITOR', 'The file is not a GeoJSON FeatureCollection');
  }
  const mm = doc.meshmonitor;
  if (!isObj(mm)) {
    return fail('IMPORT_NOT_MESHMONITOR', 'The file was not exported by MeshMonitor (no "meshmonitor" member)');
  }
  if (mm.format !== undefined && mm.format !== COVERAGE_EXPORT_FORMAT) {
    return fail('IMPORT_SCHEMA_MISMATCH', `Unknown export format "${String(mm.format)}"`);
  }
  if (mm.version !== undefined && (typeof mm.version !== 'number' || !(mm.version >= 1) || mm.version > COVERAGE_EXPORT_VERSION)) {
    return fail('IMPORT_SCHEMA_MISMATCH', `Unsupported export version ${String(mm.version)}; this server reads version ${COVERAGE_EXPORT_VERSION}`);
  }
  if (!Array.isArray(doc.features)) {
    return fail('IMPORT_SCHEMA_MISMATCH', 'The file has no "features" array');
  }
  const features: unknown[] = doc.features;
  const isGap = (f: unknown) =>
    isObj(f) && isObj(f.geometry) && f.geometry.type === 'LineString' && isObj(f.properties) && f.properties.kind === 'likely_gap';
  const gapFeatures = features.filter(isGap).length;
  const pointCount = features.length - gapFeatures;
  if (pointCount === 0) return fail('IMPORT_EMPTY', 'The file has no reception features');
  if (pointCount > COVERAGE_IMPORT_MAX_ROWS) {
    return fail('IMPORT_TOO_MANY_ROWS', `The file has ${pointCount} rows; the limit is ${COVERAGE_IMPORT_MAX_ROWS}`);
  }
  const c: Collector = { rows: [], errors: [], invalid: 0, skippedBogus: 0 };
  features.forEach((f, idx) => {
    if (isGap(f)) return;
    const row = idx + 1;
    if (!isObj(f) || f.type !== 'Feature' || !isObj(f.geometry) || f.geometry.type !== 'Point') {
      addErrors(c, row, [{ field: 'geometry', message: 'must be a Point feature' }]);
      return;
    }
    const props = f.properties;
    if (!isObj(props)) {
      addErrors(c, row, [{ field: 'properties', message: 'is missing' }]);
      return;
    }
    const missing = COVERAGE_IMPORT_COLUMNS.filter((col) => !(col.key in props));
    if (missing.length > 0) {
      addErrors(c, row, missing.map((col) => ({ field: col.key, message: 'is missing' })));
      return;
    }
    const res = validateCoverageImportRow(props, nowMs);
    const errs: RowErrors = 'errors' in res ? [...res.errors] : [];
    const skipped = 'skipped' in res;
    const coords = f.geometry.coordinates;
    if (
      !Array.isArray(coords) ||
      typeof coords[0] !== 'number' ||
      typeof coords[1] !== 'number' ||
      (typeof props.longitude === 'number' && Math.abs(coords[0] - props.longitude) > 1e-9) ||
      (typeof props.latitude === 'number' && Math.abs(coords[1] - props.latitude) > 1e-9)
    ) {
      errs.push({ field: 'geometry', message: 'coordinates do not match latitude/longitude' });
    }
    if (errs.length > 0) addErrors(c, row, errs);
    else if (skipped) c.skippedBogus++;
    else if ('row' in res) c.rows.push(res.row);
  });
  if (c.invalid > 0) return invalidRows(c);
  return { ok: true, format: 'geojson', rows: c.rows, gapFeatures, sourceTruncated: mm.truncated === true, skippedBogusPositions: c.skippedBogus };
}

export function parseCoverageImport(filename: string, text: string, nowMs: number = Date.now()): ParseCoverageImportResult {
  const format = detectCoverageImportFormat(filename, text);
  if (format === null) {
    return fail('IMPORT_UNSUPPORTED_FILE', 'Use a .csv or .geojson file exported from the Coverage Report');
  }
  return format === 'csv' ? parseCsvImport(text, nowMs) : parseGeoJsonImport(text, nowMs);
}

/** null = reticulum / unsupported source type. */
export function coverageImportProtocolFor(sourceType: string): 'meshtastic' | 'meshcore' | null {
  if (sourceType === 'reticulum') return null;
  return isAnyMeshCoreSourceType(sourceType) ? 'meshcore' : 'meshtastic';
}

export function sanitizeImportFilename(raw: string): string | null {
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (base.length === 0 || base.length > COVERAGE_IMPORT_FILENAME_MAX) return null;
  return /\.(csv|geojson|json)$/i.test(base) ? base : null;
}
