/**
 * MeshCore Repeater settings: the ONE schema (#6255, P9 S1).
 *
 * Isomorphic (no Node, no DOM): the server validates and formats commands from
 * it, the settings form takes its min/max/unit/warnings from it, and P10's
 * remote transport reuses it. Firmware evidence: `meshcore-dev/MeshCore`
 * @ 81dbae59, `CommonCLI.cpp` / `CommonRadioPrefs.cpp` (see the P9 spec).
 *
 * Ranges here are MeshMonitor's: the firmware range intersected with the
 * maintainer's limits (advert 0 or 60-240 min, flood advert 0 or 6-168 h,
 * capped at 48 h below firmware 1.12).
 */

export type RepeaterSettingKey =
  | 'lat'
  | 'lon'
  | 'advertInterval'
  | 'floodAdvertInterval'
  | 'floodMax'
  | 'repeat'
  | 'af'
  | 'rxDelay'
  | 'txDelay'
  | 'directTxDelay'
  | 'adminPassword'
  | 'guestPassword'
  | 'allowReadOnly';

export type RepeaterSettingType = 'bool' | 'int' | 'float' | 'string' | 'secret';

/** What a change costs on the air (drives the form's warnings). */
export type RepeaterAirtimeClass = 'none' | 'zero-hop-advert' | 'flood-advert' | 'forwarding' | 'duty-cap';

export type RepeaterSettingValue = number | boolean | string;

export interface RepeaterSettingDef {
  key: RepeaterSettingKey;
  /** CLI read verb (`get <verb>`); null when the firmware has no read (admin password). */
  getVerb: string | null;
  /** Full write verb prefix: `set advert.interval`, or `password` for the admin password. */
  setVerb: string;
  type: RepeaterSettingType;
  /** MeshMonitor ∩ firmware range (inclusive). Passwords: byte length. */
  min?: number;
  max?: number;
  unit?: string;
  /** 0 is allowed as an explicit "Off" even when below `min`. */
  offAllowed?: boolean;
  /** Round down to a multiple of this before sending (advert.interval is stored as min/2). */
  floorTo?: number;
  /** Acceptable readback difference (the firmware prints floats with limited precision). */
  tolerance?: number;
  /** Only the local serial transport can do this (P10's remote form skips it). */
  localOnly?: boolean;
  /** Value is a secret: never logged, never returned to the browser. */
  secret?: boolean;
  /** Firmware offers no read, or the read returns a secret: cannot diff or show it. */
  writeOnly?: boolean;
  /** First firmware release that validates the range itself (older ones accept anything). */
  validatedFrom?: string;
  airtime: RepeaterAirtimeClass;
}

export const REPEATER_SETTINGS: readonly RepeaterSettingDef[] = [
  { key: 'lat', getVerb: 'lat', setVerb: 'set lat', type: 'float', min: -90, max: 90, unit: 'deg', tolerance: 1e-4, airtime: 'none' },
  { key: 'lon', getVerb: 'lon', setVerb: 'set lon', type: 'float', min: -180, max: 180, unit: 'deg', tolerance: 1e-4, airtime: 'none' },
  {
    key: 'advertInterval', getVerb: 'advert.interval', setVerb: 'set advert.interval', type: 'int',
    min: 60, max: 240, unit: 'min', offAllowed: true, floorTo: 2, airtime: 'zero-hop-advert',
  },
  {
    key: 'floodAdvertInterval', getVerb: 'flood.advert.interval', setVerb: 'set flood.advert.interval', type: 'int',
    min: 6, max: 168, unit: 'h', offAllowed: true, airtime: 'flood-advert',
  },
  { key: 'floodMax', getVerb: 'flood.max', setVerb: 'set flood.max', type: 'int', min: 0, max: 64, unit: 'hops', airtime: 'forwarding' },
  { key: 'repeat', getVerb: 'repeat', setVerb: 'set repeat', type: 'bool', airtime: 'forwarding' },
  { key: 'af', getVerb: 'af', setVerb: 'set af', type: 'float', min: 0, max: 9, tolerance: 1e-3, validatedFrom: '1.18.0', airtime: 'duty-cap' },
  { key: 'rxDelay', getVerb: 'rxdelay', setVerb: 'set rxdelay', type: 'float', min: 0, max: 20, tolerance: 1e-3, validatedFrom: '1.16.0', airtime: 'none' },
  { key: 'txDelay', getVerb: 'txdelay', setVerb: 'set txdelay', type: 'float', min: 0, max: 2, tolerance: 1e-3, validatedFrom: '1.16.0', airtime: 'none' },
  { key: 'directTxDelay', getVerb: 'direct.txdelay', setVerb: 'set direct.txdelay', type: 'float', min: 0, max: 2, tolerance: 1e-3, validatedFrom: '1.16.0', airtime: 'none' },
  {
    key: 'adminPassword', getVerb: null, setVerb: 'password', type: 'secret',
    min: 1, max: 15, unit: 'B', secret: true, writeOnly: true, localOnly: true, airtime: 'none',
  },
  {
    key: 'guestPassword', getVerb: 'guest.password', setVerb: 'set guest.password', type: 'secret',
    min: 0, max: 15, unit: 'B', secret: true, writeOnly: true, airtime: 'none',
  },
  { key: 'allowReadOnly', getVerb: 'allow.read.only', setVerb: 'set allow.read.only', type: 'bool', airtime: 'none' },
];

const DEF_BY_KEY: Record<string, RepeaterSettingDef> = Object.fromEntries(REPEATER_SETTINGS.map((d) => [d.key, d]));

export function getRepeaterSettingDef(key: string): RepeaterSettingDef | undefined {
  return DEF_BY_KEY[key];
}

export function isRepeaterSettingKey(key: string): key is RepeaterSettingKey {
  return key in DEF_BY_KEY;
}

// ---------------------------------------------------------------------------
// Firmware version gates
// ---------------------------------------------------------------------------

export function parseRepeaterFirmwareVersion(ver: string | null | undefined): [number, number, number] | null {
  if (!ver) return null;
  const m = /v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(ver);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function atLeast(v: [number, number, number] | null, min: [number, number, number]): boolean {
  if (!v) return true; // unparseable: treat as latest, rely on the reply and readback
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

export interface RepeaterGates {
  /** The parsed version, or null when unknown (then every gate is open). */
  version: [number, number, number] | null;
  /** Firmware caps `flood.advert.interval` at 48 h before 1.12.0. */
  floodAdvertMaxHours: number;
  /** `poweroff` exists from 1.15.0. */
  powerOff: boolean;
  /** `get prv.key` exists from 1.8.0. */
  keyExport: boolean;
  /** `set prv.key` persists from 1.9.0. */
  keyImport: boolean;
  /** `set prv.key` replies with the new pubkey from 1.12.0. */
  keyImportReportsPubkey: boolean;
}

export function getRepeaterGates(ver?: string | null): RepeaterGates {
  const v = parseRepeaterFirmwareVersion(ver);
  return {
    version: v,
    floodAdvertMaxHours: atLeast(v, [1, 12, 0]) ? 168 : 48,
    powerOff: atLeast(v, [1, 15, 0]),
    keyExport: atLeast(v, [1, 8, 0]),
    keyImport: atLeast(v, [1, 9, 0]),
    keyImportReportsPubkey: atLeast(v, [1, 12, 0]),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface RepeaterValidationError {
  field: RepeaterSettingKey;
  code: 'VALIDATION';
  message: string;
}

export type RepeaterValueCheck =
  | { ok: true; value: RepeaterSettingValue }
  | { ok: false; error: RepeaterValidationError };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Effective max for a key under `gates` (flood advert is version-capped). */
export function effectiveRepeaterMax(def: RepeaterSettingDef, gates: RepeaterGates): number | undefined {
  if (def.key === 'floodAdvertInterval') return Math.min(def.max ?? Infinity, gates.floodAdvertMaxHours);
  return def.max;
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

function fail(def: RepeaterSettingDef, message: string): RepeaterValueCheck {
  return { ok: false, error: { field: def.key, code: 'VALIDATION', message } };
}

/** Validate and normalise one value (odd advert minutes are floored to even). */
export function validateRepeaterValue(
  key: RepeaterSettingKey,
  raw: unknown,
  gates: RepeaterGates = getRepeaterGates(null),
): RepeaterValueCheck {
  const def = DEF_BY_KEY[key];
  if (!def) {
    return { ok: false, error: { field: key, code: 'VALIDATION', message: `Unknown setting: ${key}` } };
  }
  switch (def.type) {
    case 'bool':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : fail(def, `${key} must be true or false`);
    case 'string':
    case 'secret': {
      if (typeof raw !== 'string') return fail(def, `${key} must be a string`);
      if (CONTROL_CHARS.test(raw)) return fail(def, `${key} must not contain control characters`);
      const len = utf8Length(raw);
      if (len < (def.min ?? 0) || len > (def.max ?? Infinity)) {
        return fail(def, `${key} must be ${def.min ?? 0}-${def.max} bytes`);
      }
      return { ok: true, value: raw };
    }
    case 'int':
    case 'float': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return fail(def, `${key} must be a number`);
      if (def.type === 'int' && !Number.isInteger(raw)) return fail(def, `${key} must be a whole number`);
      const max = effectiveRepeaterMax(def, gates);
      const isOff = def.offAllowed === true && raw === 0;
      if (!isOff && ((def.min !== undefined && raw < def.min) || (max !== undefined && raw > max))) {
        const off = def.offAllowed ? ' or 0 (Off)' : '';
        const range = `${def.min}-${max}${def.unit ? ` ${def.unit}` : ''}`;
        return fail(def, `${key} must be ${range}${off}`);
      }
      const value = def.floorTo ? Math.floor(raw / def.floorTo) * def.floorTo : raw;
      return { ok: true, value };
    }
  }
}

export interface RepeaterPatchValidation {
  ok: boolean;
  /** Normalised values for the keys that passed. */
  values: Partial<Record<RepeaterSettingKey, RepeaterSettingValue>>;
  errors: RepeaterValidationError[];
}

/** Validate a partial settings object. Unknown keys are errors; `undefined` values are skipped. */
export function validateRepeaterPatch(
  patch: Record<string, unknown>,
  gates: RepeaterGates = getRepeaterGates(null),
): RepeaterPatchValidation {
  const values: RepeaterPatchValidation['values'] = {};
  const errors: RepeaterValidationError[] = [];
  for (const [k, raw] of Object.entries(patch)) {
    if (raw === undefined) continue;
    if (!isRepeaterSettingKey(k)) {
      errors.push({ field: k as RepeaterSettingKey, code: 'VALIDATION', message: `Unknown setting: ${k}` });
      continue;
    }
    const r = validateRepeaterValue(k, raw, gates);
    if (r.ok) values[k] = r.value;
    else errors.push(r.error);
  }
  return { ok: errors.length === 0, values, errors };
}

/** True when two values are the same for diff / readback purposes. */
export function repeaterValuesEqual(
  key: RepeaterSettingKey,
  a: RepeaterSettingValue | undefined,
  b: RepeaterSettingValue | undefined,
): boolean {
  if (a === undefined || b === undefined) return false;
  const def = DEF_BY_KEY[key];
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= (def?.tolerance ?? 0);
  return a === b;
}

// ---------------------------------------------------------------------------
// Commands and replies
// ---------------------------------------------------------------------------

function formatNumber(v: number): string {
  const s = v.toFixed(6);
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
}

/** The read command for a key, or null when the firmware has none. */
export function formatGet(key: RepeaterSettingKey): string | null {
  const def = DEF_BY_KEY[key];
  return def?.getVerb ? `get ${def.getVerb}` : null;
}

/** The write command for a (validated) value. Throws on a control character. */
export function formatSet(key: RepeaterSettingKey, value: RepeaterSettingValue): string {
  const def = DEF_BY_KEY[key];
  if (!def) throw new Error(`Unknown setting: ${key}`);
  let arg: string;
  if (typeof value === 'boolean') arg = value ? 'on' : 'off';
  else if (typeof value === 'number') arg = formatNumber(value);
  else {
    if (CONTROL_CHARS.test(value)) throw new Error(`${key} must not contain control characters`);
    arg = value;
  }
  // The firmware matches the verb with its trailing space, so an empty guest
  // password is still `set guest.password ` (CommonCLI.cpp:513-516).
  return `${def.setVerb} ${arg}`;
}

export type RepeaterReplyKind = 'ok' | 'error' | 'unknown' | 'value' | 'empty' | 'other';

export interface RepeaterReply {
  kind: RepeaterReplyKind;
  /** The reply text without the `->` prefix. Secret echoes are masked. */
  text: string;
  /** For `value`: the text after the `> ` prompt. */
  value?: string;
}

/** Strip a leading `  -> ` (local serial form); remote replies have none. */
export function stripReplyPrefix(line: string): string {
  return line.replace(/^\s*->\s?/, '');
}

/**
 * Classify one CLI reply. Local replies look like `  -> OK`, remote ones are
 * the bare text. Multi-line input: the first `->` line wins, else the first
 * non-empty line.
 */
export function parseCliReply(reply: string | null | undefined): RepeaterReply {
  const lines = (reply ?? '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { kind: 'empty', text: '' };
  const line = lines.find((l) => /^\s*->/.test(l)) ?? lines[0];
  const text = stripReplyPrefix(line).trim();
  if (text.length === 0) return { kind: 'empty', text: '' };
  if (/^password now:/i.test(text)) return { kind: 'ok', text: 'password now: [redacted]' };
  if (text.startsWith('>')) return { kind: 'value', text, value: text.replace(/^>\s?/, '') };
  if (/^\??\(?(?:unknown command|unknown config)\b/i.test(text) || text.startsWith('??:')) {
    return { kind: 'unknown', text };
  }
  if (/^\(?(?:ERR|Error)\b/i.test(text)) return { kind: 'error', text };
  if (/^\(?OK\b/i.test(text)) return { kind: 'ok', text };
  return { kind: 'other', text };
}

/**
 * True when a serial line ends a reply read. Superset of the original
 * `-> >` / OK / Error / Unknown command set: adds `??:`, `unknown config`,
 * anything holding `ERR` (`ERROR:`, `(ERR:`), the `password now:` echo and a bare
 * `-> ok|error`.
 */
export function isRepeaterReplyTerminator(line: string): boolean {
  return (
    line.includes('-> >') ||
    line.includes('OK') ||
    line.includes('Error') ||
    line.includes('Unknown command') ||
    line.includes('??:') ||
    line.includes('unknown config') ||
    line.includes('ERR') ||
    line.includes('password now:') ||
    /^\s*->\s*(?:ok|error)$/i.test(line)
  );
}
