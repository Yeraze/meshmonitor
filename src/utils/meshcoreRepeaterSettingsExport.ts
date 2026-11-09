/**
 * Export / import of already-read Repeater settings (#6256, P10).
 *
 * Isomorphic. Export sends no RF: it serialises values the caller already
 * read. Secrets never leave; identity keys (name, lat, lon, radio) only with
 * `includeIdentity`. Import validates through the one schema and returns a
 * draft for the form to show; it never writes.
 */
import {
  REPEATER_SETTINGS,
  getRepeaterSettingDef,
  isRepeaterSettingKey,
  settingsFor,
  validateRepeaterPatch,
  type RepeaterDeviceType,
  type RepeaterGates,
  type RepeaterMode,
  type RepeaterSettingKey,
  type RepeaterSettingValue,
} from './meshcoreRepeaterSettings.js';

export const REPEATER_EXPORT_SCHEMA = 'meshmonitor.meshcore.repeater-settings';
export const REPEATER_EXPORT_VERSION = 1;

/** Keys that identify the node: left out unless the user opts in. */
export const REPEATER_IDENTITY_KEYS: readonly RepeaterSettingKey[] = ['name', 'lat', 'lon', 'radio'];

export interface RepeaterSettingsExport {
  schema: typeof REPEATER_EXPORT_SCHEMA;
  v: typeof REPEATER_EXPORT_VERSION;
  deviceType: RepeaterDeviceType;
  firmware: string | null;
  exportedAt: string;
  values: Partial<Record<RepeaterSettingKey, RepeaterSettingValue>>;
}

export interface BuildExportMeta {
  deviceType: RepeaterDeviceType;
  firmware?: string | null;
  includeIdentity?: boolean;
  /** Override the timestamp (tests). */
  now?: Date;
}

export function buildExport(
  values: Partial<Record<RepeaterSettingKey, RepeaterSettingValue>>,
  meta: BuildExportMeta,
): RepeaterSettingsExport {
  const out: RepeaterSettingsExport['values'] = {};
  for (const def of REPEATER_SETTINGS) {
    const v = values[def.key];
    if (v === undefined || def.secret) continue;
    if (!def.deviceTypes.includes(meta.deviceType)) continue;
    if (!meta.includeIdentity && REPEATER_IDENTITY_KEYS.includes(def.key)) continue;
    out[def.key] = v;
  }
  return {
    schema: REPEATER_EXPORT_SCHEMA,
    v: REPEATER_EXPORT_VERSION,
    deviceType: meta.deviceType,
    firmware: meta.firmware ?? null,
    exportedAt: (meta.now ?? new Date()).toISOString(),
    values: out,
  };
}

export interface ParseImportOptions {
  deviceType: RepeaterDeviceType;
  gates: RepeaterGates;
  /** Where the draft will be saved: remote drops read-only keys (radio). Default local. */
  mode?: RepeaterMode;
  includeIdentity?: boolean;
}

export interface ParseImportResult {
  ok: boolean;
  /** Validated, normalised values to put in the form draft. */
  draft: Partial<Record<RepeaterSettingKey, RepeaterSettingValue>>;
  /** Keys dropped (unsupported, secret, identity, out of range), each with a reason. */
  notes: { key: string; reason: string }[];
  /** Fatal: the file is not a settings export. */
  error?: string;
}

export function parseImport(json: unknown, opts: ParseImportOptions): ParseImportResult {
  let doc: unknown = json;
  if (typeof json === 'string') {
    try {
      doc = JSON.parse(json);
    } catch {
      return { ok: false, draft: {}, notes: [], error: 'The file is not valid JSON' };
    }
  }
  const o = doc as Partial<RepeaterSettingsExport> | null;
  if (!o || typeof o !== 'object' || o.schema !== REPEATER_EXPORT_SCHEMA) {
    return { ok: false, draft: {}, notes: [], error: 'The file is not a MeshMonitor repeater settings export' };
  }
  if (o.v !== REPEATER_EXPORT_VERSION) {
    return { ok: false, draft: {}, notes: [], error: `Unsupported export version: ${String(o.v)}` };
  }
  if (!o.values || typeof o.values !== 'object' || Array.isArray(o.values)) {
    return { ok: false, draft: {}, notes: [], error: 'The export holds no values' };
  }

  const mode = opts.mode ?? 'local';
  const offered = new Set(settingsFor({ mode, deviceType: opts.deviceType }).map((d) => d.key));
  const notes: ParseImportResult['notes'] = [];
  const candidate: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o.values as Record<string, unknown>)) {
    const def = isRepeaterSettingKey(k) ? getRepeaterSettingDef(k) : undefined;
    if (!def) {
      notes.push({ key: k, reason: 'unknown setting' });
    } else if (def.secret) {
      notes.push({ key: k, reason: 'secrets are never imported' });
    } else if (!def.deviceTypes.includes(opts.deviceType)) {
      notes.push({ key: k, reason: 'not available on this device type' });
    } else if (!offered.has(def.key) || (mode === 'remote' && def.remote !== 'rw')) {
      notes.push({ key: k, reason: 'cannot be changed over the air' });
    } else if (!opts.includeIdentity && REPEATER_IDENTITY_KEYS.includes(def.key)) {
      notes.push({ key: k, reason: 'identity setting skipped' });
    } else {
      candidate[k] = v;
    }
  }

  // Validate key by key so one bad value drops only itself.
  const draft: ParseImportResult['draft'] = {};
  for (const [k, v] of Object.entries(candidate)) {
    const r = validateRepeaterPatch({ [k]: v }, opts.gates, { mode, deviceType: opts.deviceType });
    if (r.ok) Object.assign(draft, r.values);
    else notes.push({ key: k, reason: r.errors[0]?.message ?? 'invalid value' });
  }
  return { ok: true, draft, notes };
}
