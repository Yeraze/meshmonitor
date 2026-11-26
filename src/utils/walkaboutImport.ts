/**
 * Walkabout session import: pure, bounded parser and validator (#6573).
 * Frontend-safe: no DB, no `src/server` imports.
 *
 * Reads the lossless JSON that `GET /walkabout/sessions/:id/export` produces
 * (`WalkaboutExportDoc`). All-or-nothing: any bad field rejects the file with
 * up to COVERAGE_IMPORT_MAX_ERRORS errors and nothing is written.
 *
 * Bounded: the text is scanned for its JSON value count before `JSON.parse`,
 * so a 32 MB file of tiny records never becomes millions of objects in memory.
 * Rows (samples + receptions) are capped at COVERAGE_IMPORT_MAX_ROWS per file.
 */
import {
  COVERAGE_IMPORT_EARLIEST_MS,
  COVERAGE_IMPORT_FUTURE_SKEW_MS,
  COVERAGE_IMPORT_MAX_ERRORS,
  COVERAGE_IMPORT_MAX_ROWS,
} from './coverageImport.js';
import {
  WALKABOUT_EXPORT_FORMAT,
  WALKABOUT_EXPORT_VERSION,
  WALKABOUT_IMPORT_MAX_SESSIONS,
  WALKABOUT_MAX_ACCURACY_M,
  WALKABOUT_MAX_DURATION_MS,
  WALKABOUT_NAME_MAX,
  type WalkaboutEndReason,
} from './walkabout.js';
import type { CoverageImportRowError } from '../types/coverageImport.js';

export interface ParsedWalkaboutSample {
  /** File-local id; receptions point at it through `fileSampleId`. */
  fileId: number;
  latitude: number;
  longitude: number;
  accuracyM: number;
  deviceFixAt: number;
  fixAt: number;
  receivedAt: number;
}

export interface ParsedWalkaboutReception {
  protocol: 'meshtastic' | 'meshcore';
  creditedKey: string;
  creditedNodeNum: number | null;
  creditKind: 'direct' | 'relay';
  hopsAway: number | null;
  packetKey: string;
  snr: number | null;
  rssi: number | null;
  heardAt: number;
  fileSampleId: number | null;
  latitude: number;
  longitude: number;
  accuracyM: number;
  sampleAgeMs: number;
}

export interface ParsedWalkaboutSession {
  name: string | null;
  startedAt: number;
  /** Always set: an imported session is never live. Open in the file -> startedAt + cap. */
  endedAt: number;
  endReason: WalkaboutEndReason;
  samples: ParsedWalkaboutSample[];
  receptions: ParsedWalkaboutReception[];
}

export type WalkaboutImportErrorCode =
  | 'IMPORT_UNSUPPORTED_FILE'
  | 'IMPORT_NOT_MESHMONITOR'
  | 'IMPORT_SCHEMA_MISMATCH'
  | 'IMPORT_INVALID_ROWS'
  | 'IMPORT_TOO_MANY_ROWS'
  | 'IMPORT_EMPTY';

export type ParseWalkaboutImportResult =
  | { ok: true; sessions: ParsedWalkaboutSession[]; rowCount: number; sourceTruncated: boolean }
  | { ok: false; code: WalkaboutImportErrorCode; message: string; errors: CoverageImportRowError[]; errorCount: number };

/** Most JSON values one row can carry (a reception has 16 fields), with room for names. */
const VALUES_PER_ROW = 24;
const VALUE_SLACK = 1_000;
export const WALKABOUT_IMPORT_MAX_JSON_VALUES =
  (COVERAGE_IMPORT_MAX_ROWS + WALKABOUT_IMPORT_MAX_SESSIONS * 4) * VALUES_PER_ROW + VALUE_SLACK;

/** Where the exporter writes its marker; a sniff past this is not needed. */
const SNIFF_CHARS = 4_096;
const FORMAT_RE = new RegExp(`"format"\\s*:\\s*"${WALKABOUT_EXPORT_FORMAT}"`);

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** Cheap check for the walkabout marker near the top of the file (the exporter writes it first). */
export function isWalkaboutExportText(text: string): boolean {
  const head = stripBom(text).slice(0, SNIFF_CHARS);
  return head.trimStart().startsWith('{') && FORMAT_RE.test(head);
}

/**
 * Count JSON values (commas plus containers, outside strings) and stop at
 * `limit + 1`. Every value except the top-level one sits after a comma or
 * opens a container, so this bounds what `JSON.parse` would build (a bare
 * scalar document counts as 0).
 */
export function countJsonValues(text: string, limit: number): number {
  let n = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++; // backslash: skip the escaped char
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x2c || c === 0x7b || c === 0x5b) {
      n++;
      if (n > limit) return n;
    }
  }
  return n;
}

const MESHTASTIC_KEY_RE = /^![0-9a-fA-F]{8}$/;
const MESHCORE_KEY_RE = /^[0-9a-fA-F]{64}$/;
const MESHTASTIC_PACKET_RE = /^[0-9a-f]{8}:\d{1,10}$/;
const MESHCORE_PACKET_RE = /^[0-9A-Fa-f]{16}$/;
const MAX_SAMPLE_AGE_SPAN_MS = 86_400_000;

type Errs = Array<Omit<CoverageImportRowError, 'row'>>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isFin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function checkTime(v: unknown, field: string, errs: Errs, nowMs: number): number {
  if (!isInt(v) || v < COVERAGE_IMPORT_EARLIEST_MS || v > nowMs + COVERAGE_IMPORT_FUTURE_SKEW_MS) {
    errs.push({ field, message: 'must be a millisecond timestamp between 2020 and now' });
    return 0;
  }
  return v;
}

function checkPosition(o: Record<string, unknown>, prefix: string, errs: Errs): { latitude: number; longitude: number } {
  const lat = o.latitude;
  const lon = o.longitude;
  const okLat = isFin(lat) && lat >= -90 && lat <= 90;
  const okLon = isFin(lon) && lon >= -180 && lon <= 180;
  if (!okLat) errs.push({ field: `${prefix}latitude`, message: 'must be a number from -90 to 90' });
  if (!okLon) errs.push({ field: `${prefix}longitude`, message: 'must be a number from -180 to 180' });
  if (okLat && okLon && lat === 0 && lon === 0) {
    errs.push({ field: `${prefix}latitude`, message: '0,0 is not a real fix' });
  }
  return { latitude: okLat ? lat : 0, longitude: okLon ? lon : 0 };
}

function checkAccuracy(v: unknown, field: string, errs: Errs): number {
  if (!isFin(v) || v < 0 || v > WALKABOUT_MAX_ACCURACY_M) {
    errs.push({ field, message: `must be a number from 0 to ${WALKABOUT_MAX_ACCURACY_M}` });
    return 0;
  }
  return v;
}

function nullableInt(v: unknown, field: string, min: number, max: number, errs: Errs): number | null {
  if (v === null || v === undefined) return null;
  if (!isInt(v) || v < min || v > max) {
    errs.push({ field, message: `must be empty or a whole number from ${min} to ${max}` });
    return null;
  }
  return v;
}

function validateSample(raw: unknown, p: string, errs: Errs, nowMs: number): ParsedWalkaboutSample | null {
  if (!isObj(raw)) {
    errs.push({ field: p.slice(0, -1), message: 'must be an object' });
    return null;
  }
  const before = errs.length;
  if (!isInt(raw.id) || raw.id < 0) errs.push({ field: `${p}id`, message: 'must be a whole number of 0 or more' });
  const pos = checkPosition(raw, p, errs);
  const accuracyM = checkAccuracy(raw.accuracyM, `${p}accuracyM`, errs);
  if (!isInt(raw.deviceFixAt) || raw.deviceFixAt <= 0) {
    errs.push({ field: `${p}deviceFixAt`, message: 'must be a positive millisecond timestamp' });
  }
  const fixAt = checkTime(raw.fixAt, `${p}fixAt`, errs, nowMs);
  const receivedAt = checkTime(raw.receivedAt, `${p}receivedAt`, errs, nowMs);
  if (errs.length > before) return null;
  return { fileId: raw.id as number, ...pos, accuracyM, deviceFixAt: raw.deviceFixAt as number, fixAt, receivedAt };
}

function validateReception(raw: unknown, p: string, errs: Errs, nowMs: number): ParsedWalkaboutReception | null {
  if (!isObj(raw)) {
    errs.push({ field: p.slice(0, -1), message: 'must be an object' });
    return null;
  }
  const before = errs.length;
  const protocol = raw.protocol;
  if (protocol !== 'meshtastic' && protocol !== 'meshcore') {
    errs.push({ field: `${p}protocol`, message: 'must be meshtastic or meshcore' });
  }
  const mc = protocol === 'meshcore';
  let creditedKey = '';
  let creditedNodeNum: number | null = null;
  if (typeof raw.creditedKey !== 'string' || !(mc ? MESHCORE_KEY_RE : MESHTASTIC_KEY_RE).test(raw.creditedKey)) {
    errs.push({ field: `${p}creditedKey`, message: mc ? 'must be a 64-hex public key' : 'must be a !xxxxxxxx node id' });
  } else {
    creditedKey = raw.creditedKey.toLowerCase();
    // Re-derived, never trusted: the key is the identity.
    creditedNodeNum = mc ? null : parseInt(creditedKey.slice(1), 16);
    if (raw.creditedNodeNum != null && raw.creditedNodeNum !== creditedNodeNum) {
      errs.push({ field: `${p}creditedNodeNum`, message: 'does not match creditedKey' });
    }
  }
  if (raw.creditKind !== 'direct' && raw.creditKind !== 'relay') {
    errs.push({ field: `${p}creditKind`, message: 'must be direct or relay' });
  }
  const hopsAway = nullableInt(raw.hopsAway, `${p}hopsAway`, 0, 63, errs);
  if (typeof raw.packetKey !== 'string' || !(mc ? MESHCORE_PACKET_RE : MESHTASTIC_PACKET_RE).test(raw.packetKey)) {
    errs.push({ field: `${p}packetKey`, message: 'is not a valid packet key' });
  }
  let snr: number | null = null;
  if (raw.snr != null) {
    if (!isFin(raw.snr) || raw.snr < -50 || raw.snr > 50) errs.push({ field: `${p}snr`, message: 'must be empty or a number from -50 to 50' });
    else snr = raw.snr;
  }
  const rssi = nullableInt(raw.rssi, `${p}rssi`, -200, 20, errs);
  const heardAt = checkTime(raw.heardAt, `${p}heardAt`, errs, nowMs);
  const fileSampleId = nullableInt(raw.sampleId, `${p}sampleId`, 0, Number.MAX_SAFE_INTEGER, errs);
  const pos = checkPosition(raw, p, errs);
  const accuracyM = checkAccuracy(raw.accuracyM, `${p}accuracyM`, errs);
  if (!isInt(raw.sampleAgeMs) || Math.abs(raw.sampleAgeMs) > MAX_SAMPLE_AGE_SPAN_MS) {
    errs.push({ field: `${p}sampleAgeMs`, message: 'must be a whole number of milliseconds' });
  }
  if (errs.length > before) return null;
  return {
    protocol: protocol as 'meshtastic' | 'meshcore',
    creditedKey,
    creditedNodeNum,
    creditKind: raw.creditKind as 'direct' | 'relay',
    hopsAway,
    packetKey: raw.packetKey as string,
    snr,
    rssi,
    heardAt,
    fileSampleId,
    ...pos,
    accuracyM,
    sampleAgeMs: raw.sampleAgeMs as number,
  };
}

const CONTROL_RE = /[\u0000-\u001f\u007f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function validateSessionHead(
  raw: Record<string, unknown>,
  errs: Errs,
  nowMs: number,
): { name: string | null; startedAt: number; endedAt: number; endReason: WalkaboutEndReason } {
  let name: string | null = null;
  if (raw.name != null) {
    if (typeof raw.name !== 'string') errs.push({ field: 'name', message: 'must be text' });
    else {
      const clean = raw.name.replace(CONTROL_RE, '').trim();
      if (clean.length > WALKABOUT_NAME_MAX) errs.push({ field: 'name', message: `must be at most ${WALKABOUT_NAME_MAX} characters` });
      name = clean.length > 0 ? clean : null;
    }
  }
  const startedAt = checkTime(raw.startedAt, 'startedAt', errs, nowMs);
  let endedAt = startedAt + WALKABOUT_MAX_DURATION_MS;
  let endReason: WalkaboutEndReason = 'cap';
  let endedAtOk = false;
  if (raw.endedAt != null) {
    if (!isInt(raw.endedAt) || raw.endedAt < startedAt || raw.endedAt > startedAt + WALKABOUT_MAX_DURATION_MS) {
      errs.push({ field: 'endedAt', message: 'must be empty or within 2 hours after startedAt' });
    } else {
      endedAt = raw.endedAt;
      endReason = 'user';
      endedAtOk = true;
    }
  }
  if (raw.endReason != null) {
    if (raw.endReason !== 'user' && raw.endReason !== 'cap') errs.push({ field: 'endReason', message: 'must be user or cap' });
    else if (endedAtOk) endReason = raw.endReason;
  }
  return { name, startedAt, endedAt, endReason };
}

function fail(code: WalkaboutImportErrorCode, message: string, errors: CoverageImportRowError[] = [], errorCount = errors.length): ParseWalkaboutImportResult {
  return { ok: false, code, message, errors, errorCount };
}

/**
 * Parse a walkabout export. `row` in an error is the 1-based session index;
 * `field` names the sample or reception inside it (`samples[3].latitude`).
 */
export function parseWalkaboutImport(text: string, nowMs: number = Date.now()): ParseWalkaboutImportResult {
  const body = stripBom(text);
  if (!body.trimStart().startsWith('{')) return fail('IMPORT_UNSUPPORTED_FILE', 'A walkabout import must be the JSON file MeshMonitor exported');
  if (countJsonValues(body, WALKABOUT_IMPORT_MAX_JSON_VALUES) > WALKABOUT_IMPORT_MAX_JSON_VALUES) {
    return fail('IMPORT_TOO_MANY_ROWS', `The file holds more than ${COVERAGE_IMPORT_MAX_ROWS} rows; the limit is ${COVERAGE_IMPORT_MAX_ROWS}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return fail('IMPORT_UNSUPPORTED_FILE', 'The file is not valid JSON');
  }
  if (!isObj(doc) || !isObj(doc.meshmonitor) || doc.meshmonitor.format !== WALKABOUT_EXPORT_FORMAT) {
    return fail('IMPORT_NOT_MESHMONITOR', 'The file is not a MeshMonitor walkabout export');
  }
  const mm = doc.meshmonitor;
  if (typeof mm.version !== 'number' || !(mm.version >= 1) || mm.version > WALKABOUT_EXPORT_VERSION) {
    return fail('IMPORT_SCHEMA_MISMATCH', `Unsupported export version ${String(mm.version)}; this server reads version ${WALKABOUT_EXPORT_VERSION}`);
  }
  if (!Array.isArray(doc.sessions)) return fail('IMPORT_SCHEMA_MISMATCH', 'The file has no "sessions" array');
  const sessions: unknown[] = doc.sessions;
  if (sessions.length === 0) return fail('IMPORT_EMPTY', 'The file holds no sessions');
  if (sessions.length > WALKABOUT_IMPORT_MAX_SESSIONS) {
    return fail('IMPORT_TOO_MANY_ROWS', `The file holds ${sessions.length} sessions; the limit is ${WALKABOUT_IMPORT_MAX_SESSIONS}`);
  }
  // Shape and row count before any per-row work.
  let rowCount = 0;
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (!isObj(s) || !Array.isArray(s.samples) || !Array.isArray(s.receptions)) {
      return fail('IMPORT_SCHEMA_MISMATCH', `Session ${i + 1} needs "samples" and "receptions" arrays`);
    }
    rowCount += s.samples.length + s.receptions.length;
  }
  if (rowCount > COVERAGE_IMPORT_MAX_ROWS) {
    return fail('IMPORT_TOO_MANY_ROWS', `The file has ${rowCount} rows; the limit is ${COVERAGE_IMPORT_MAX_ROWS}`);
  }
  if (rowCount === 0) return fail('IMPORT_EMPTY', 'The sessions hold no samples or receptions');

  const errors: CoverageImportRowError[] = [];
  let errorCount = 0;
  const report = (row: number, errs: Errs) => {
    errorCount += errs.length;
    for (const e of errs) if (errors.length < COVERAGE_IMPORT_MAX_ERRORS) errors.push({ row, ...e });
  };
  const out: ParsedWalkaboutSession[] = [];
  sessions.forEach((rawSession, si) => {
    const s = rawSession as Record<string, unknown> & { samples: unknown[]; receptions: unknown[] };
    const errs: Errs = [];
    const head = validateSessionHead(s, errs, nowMs);
    const samples: ParsedWalkaboutSample[] = [];
    const ids = new Set<number>();
    s.samples.forEach((raw, i) => {
      const smp = validateSample(raw, `samples[${i}].`, errs, nowMs);
      if (!smp) return;
      if (ids.has(smp.fileId)) errs.push({ field: `samples[${i}].id`, message: 'is used twice in this session' });
      ids.add(smp.fileId);
      samples.push(smp);
    });
    const receptions: ParsedWalkaboutReception[] = [];
    s.receptions.forEach((raw, i) => {
      const rx = validateReception(raw, `receptions[${i}].`, errs, nowMs);
      if (!rx) return;
      if (rx.fileSampleId != null && !ids.has(rx.fileSampleId)) {
        errs.push({ field: `receptions[${i}].sampleId`, message: 'names no sample in this session' });
        return;
      }
      receptions.push(rx);
    });
    if (errs.length > 0) report(si + 1, errs);
    else out.push({ ...head, samples, receptions });
  });
  if (errorCount > 0) {
    return fail('IMPORT_INVALID_ROWS', `${errorCount} field error(s); nothing was imported`, errors, errorCount);
  }
  return { ok: true, sessions: out, rowCount, sourceTruncated: mm.truncated === true };
}
