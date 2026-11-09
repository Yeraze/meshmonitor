/**
 * Repeater structured settings over a CLI transport (#6255, P9 S2).
 *
 * The transport hides how a command reaches the repeater: P9 passes the local
 * serial CLI, P10 will pass a remote-admin adapter. Everything here is local
 * to the radio and sends no RF on the local transport.
 *
 * Write flow: validate every key (one bad key sends nothing) -> diff against
 * `current` -> `set` ONLY the changed keys (a firmware `set` of an interval
 * restarts that timer, so repeated saves must not touch unchanged ones) -> one
 * full re-read -> per-key results; a readback that differs is a key error.
 *
 * Secrets: the guest password is read internally for the diff and readback but
 * never leaves this module (`guestPasswordSet` only); the admin password has no
 * read and is judged by the firmware's reply alone. No result or error text
 * carries either value.
 */
import {
  REPEATER_SETTINGS,
  formatGet,
  formatSet,
  parseCliReply,
  repeaterValuesEqual,
  settingsFor,
  validateRepeaterPatch,
  type RepeaterDeviceType,
  type RepeaterGates,
  type RepeaterSettingDef,
  type RepeaterSettingKey,
  type RepeaterSettingValue,
  type RepeaterValidationError,
} from '../../utils/meshcoreRepeaterSettings.js';

export interface RepeaterCliTransport {
  /** Run one CLI line and resolve with the raw reply (`  -> ...` locally, bare remotely). */
  run(cmd: string, opts?: { secret?: boolean; timeoutMs?: number }): Promise<string>;
  mode: 'local' | 'remote';
}

export type RepeaterSettingsValues = Partial<Record<RepeaterSettingKey, RepeaterSettingValue>>;

export interface RepeaterSettingsRead {
  /** Readable, non-secret values. Keys the firmware would not answer are absent. */
  values: RepeaterSettingsValues;
  /** True when a guest password is set (the password itself is never returned). */
  guestPasswordSet: boolean;
  /** Per-key read failures (unsupported, no reply, unparseable). */
  errors: Partial<Record<RepeaterSettingKey, string>>;
  /** Remote only: the key whose read failed and stopped the run (the rest are in `errors` as not read). */
  stoppedAt?: RepeaterSettingKey;
}

export interface RepeaterKeyResult {
  ok: boolean;
  /** Value after the write (non-secret keys, from the readback). */
  value?: RepeaterSettingValue;
  /** True when this key was sent (it differed from `current`, or is a secret). */
  changed: boolean;
  error?: string;
  code?: 'VALIDATION' | 'REJECTED' | 'NO_REPLY' | 'TRANSPORT' | 'READBACK_MISMATCH' | 'NOT_SENT';
  /** False when the key was accepted but no readback ran (a remote run that stopped early). */
  verified?: boolean;
}

export interface ReadRepeaterOptions {
  /** Read exactly these keys (default: the P9 local set, or every key offered remotely). */
  keys?: readonly RepeaterSettingKey[];
  deviceType?: RepeaterDeviceType;
}

export interface WriteRepeaterOptions {
  /** 'all' re-reads every default key (local); 'sent' re-reads only what was sent (remote). Default by transport mode. */
  readback?: 'all' | 'sent';
  deviceType?: RepeaterDeviceType;
}

export interface RepeaterWriteResult {
  /** True when validation passed and every sent key was accepted and verified. */
  ok: boolean;
  /** Validation failed: nothing was sent. */
  validationFailed: boolean;
  validationErrors: RepeaterValidationError[];
  /** One entry per key in the patch. */
  results: Partial<Record<RepeaterSettingKey, RepeaterKeyResult>>;
  /** The re-read after the writes (all keys, or only the sent ones with `readback: 'sent'`). */
  read: RepeaterSettingsRead;
  /** Keys NOT in the patch whose value moved (e.g. the firmware zeroes advert.interval on first save). */
  drifted: RepeaterSettingKey[];
}

/** Default read set: the P9 local keys (name / tx / radio belong to other local sections). */
const LOCAL_DEFAULT = REPEATER_SETTINGS.filter((d) => d.getVerb !== null && d.localDefault !== false);

function parseValue(def: RepeaterSettingDef, raw: string): RepeaterSettingValue | null {
  const v = raw.trim();
  switch (def.type) {
    case 'bool':
      if (/^on$/i.test(v)) return true;
      if (/^off$/i.test(v)) return false;
      return null;
    case 'int':
    case 'float': {
      if (v === '' || !/^-?\d+(\.\d+)?$/.test(v)) return null;
      return Number(v);
    }
    default:
      return v;
  }
}

interface InternalRead extends RepeaterSettingsRead {
  /** Guest password as the device reported it. Never exported from this module. */
  guestPlain: string | null;
}

async function readKeys(t: RepeaterCliTransport, defs: readonly RepeaterSettingDef[]): Promise<InternalRead> {
  const values: RepeaterSettingsValues = {};
  const errors: RepeaterSettingsRead['errors'] = {};
  let guestPlain: string | null = null;
  let stoppedAt: RepeaterSettingKey | undefined;
  for (const def of defs) {
    if (def.getVerb === null) continue;
    if (stoppedAt) {
      errors[def.key] = 'not read';
      continue;
    }
    const cmd = formatGet(def.key);
    if (!cmd) continue;
    let reply;
    try {
      reply = parseCliReply(await t.run(cmd, { secret: def.secret === true }));
    } catch (e) {
      errors[def.key] = e instanceof Error ? e.message : 'transport error';
      if (t.mode === 'remote') stoppedAt = def.key;
      continue;
    }
    if (reply.kind !== 'value') {
      errors[def.key] =
        reply.kind === 'empty'
          ? 'no reply'
          : reply.kind === 'unknown'
            ? 'not supported by this firmware'
            : reply.text;
      if (reply.kind === 'empty' && t.mode === 'remote') stoppedAt = def.key;
      continue;
    }
    if (def.key === 'guestPassword') {
      guestPlain = reply.value ?? '';
      continue;
    }
    const parsed = parseValue(def, reply.value ?? '');
    if (parsed === null) errors[def.key] = 'unparseable reply';
    else values[def.key] = parsed;
  }
  const out: InternalRead = { values, errors, guestPasswordSet: (guestPlain ?? '').length > 0, guestPlain };
  if (stoppedAt) out.stoppedAt = stoppedAt;
  return out;
}

function defsFor(t: RepeaterCliTransport, opts?: ReadRepeaterOptions): RepeaterSettingDef[] {
  if (opts?.keys) {
    const want = new Set<RepeaterSettingKey>(opts.keys);
    return REPEATER_SETTINGS.filter((d) => want.has(d.key));
  }
  return t.mode === 'remote'
    ? settingsFor({ mode: 'remote', deviceType: opts?.deviceType })
    : [...LOCAL_DEFAULT];
}

function publicRead(r: InternalRead): RepeaterSettingsRead {
  const out: RepeaterSettingsRead = { values: r.values, errors: r.errors, guestPasswordSet: r.guestPasswordSet };
  if (r.stoppedAt) out.stoppedAt = r.stoppedAt;
  return out;
}

/**
 * Read settings. Default: the P9 local set (local) or every key the device type
 * offers remotely. `keys` limits it (P10 reads per group). A remote run stops at
 * the first transport error or empty reply; `gates` is accepted for symmetry.
 */
export async function readRepeaterSettings(
  t: RepeaterCliTransport,
  _gates?: RepeaterGates,
  opts?: ReadRepeaterOptions,
): Promise<RepeaterSettingsRead> {
  return publicRead(await readKeys(t, defsFor(t, opts)));
}

/** A reply text safe to surface: never longer than one line, secrets already masked by parseCliReply. */
function safeText(text: string, def: RepeaterSettingDef): string {
  if (def.secret) return 'rejected by the device';
  return text.slice(0, 160);
}

export async function writeRepeaterSettings(
  t: RepeaterCliTransport,
  gates: RepeaterGates,
  current: RepeaterSettingsValues,
  patch: Record<string, unknown>,
  opts?: WriteRepeaterOptions,
): Promise<RepeaterWriteResult> {
  const remote = t.mode === 'remote';
  const readback = opts?.readback ?? (remote ? 'sent' : 'all');
  const validation = validateRepeaterPatch(patch, gates, { mode: t.mode, deviceType: opts?.deviceType });
  if (!validation.ok) {
    const results: RepeaterWriteResult['results'] = {};
    for (const e of validation.errors) {
      results[e.field] = { ok: false, changed: false, error: e.message, code: 'VALIDATION' };
    }
    return {
      ok: false,
      validationFailed: true,
      validationErrors: validation.errors,
      results,
      read: { values: { ...current }, errors: {}, guestPasswordSet: false },
      drifted: [],
    };
  }

  const results: RepeaterWriteResult['results'] = {};
  const sent: RepeaterSettingKey[] = [];
  // Local: the guest password compare uses a pre-read so an unchanged value is not re-sent.
  // Remote: no pre-read (each read is a round trip over the air); a supplied guest password is always sent.
  const before =
    !remote && 'guestPassword' in validation.values
      ? await readKeys(t, LOCAL_DEFAULT)
      : null;
  let stopped = false;

  for (const def of REPEATER_SETTINGS) {
    if (!(def.key in validation.values)) continue;
    if (stopped) {
      results[def.key] = { ok: false, changed: false, code: 'NOT_SENT', error: 'not sent: an earlier command got no answer' };
      continue;
    }
    const value = validation.values[def.key] as RepeaterSettingValue;
    let isChange: boolean;
    if (def.key === 'guestPassword') {
      isChange = before?.guestPlain === null || before?.guestPlain !== value;
    } else if (def.secret) {
      isChange = true; // no read: a supplied admin password is always a change
    } else {
      isChange = !repeaterValuesEqual(def.key, current[def.key], value);
    }
    if (!isChange) {
      results[def.key] = { ok: true, changed: false, value };
      continue;
    }
    let reply;
    try {
      reply = parseCliReply(await t.run(formatSet(def.key, value), { secret: def.secret === true }));
    } catch (e) {
      results[def.key] = {
        ok: false,
        changed: true,
        code: 'TRANSPORT',
        error: e instanceof Error ? e.message : 'transport error',
      };
      if (remote) stopped = true;
      continue;
    }
    if (reply.kind === 'ok') {
      sent.push(def.key);
      results[def.key] = { ok: true, changed: true };
    } else if (reply.kind === 'empty') {
      results[def.key] = { ok: false, changed: true, code: 'NO_REPLY', error: 'no reply from the device' };
      if (remote) stopped = true;
    } else {
      results[def.key] = {
        ok: false,
        changed: true,
        code: 'REJECTED',
        error: safeText(reply.text, def) || 'rejected by the device',
      };
    }
  }

  // Readback. 'all' re-reads the default set. 'sent' re-reads the accepted keys, plus advert.interval when it
  // was cached at 1-59 (the firmware zeroes it on the first save of any setting). A run that stopped on a
  // dead link reads nothing more: those keys stay unverified.
  let readDefs: RepeaterSettingDef[];
  if (readback === 'all') readDefs = [...LOCAL_DEFAULT];
  else {
    const want = new Set<RepeaterSettingKey>(sent);
    const cached = current.advertInterval;
    if (sent.length > 0 && typeof cached === 'number' && cached >= 1 && cached <= 59) want.add('advertInterval');
    readDefs = REPEATER_SETTINGS.filter((d) => want.has(d.key) && d.getVerb !== null);
  }
  if (stopped) readDefs = [];
  const after = await readKeys(t, readDefs);
  if (stopped) {
    for (const key of sent) results[key] = { ...results[key]!, verified: false };
  }
  for (const key of sent) {
    const res = results[key]!;
    const def = REPEATER_SETTINGS.find((d) => d.key === key)!;
    const expected = validation.values[key] as RepeaterSettingValue;
    if (key === 'adminPassword') continue; // no read; the reply was the proof
    if (stopped) continue;
    if (key === 'guestPassword') {
      if (after.guestPlain !== expected) {
        results[key] = { ok: false, changed: true, code: 'READBACK_MISMATCH', error: 'the device did not keep the new value' };
      }
      continue;
    }
    const got = after.values[key];
    if (got === undefined) {
      results[key] = { ...res, ok: false, code: 'READBACK_MISMATCH', error: after.errors[key] ?? 'could not read the value back' };
    } else if (!repeaterValuesEqual(key, got, expected)) {
      results[key] = {
        ok: false,
        changed: true,
        value: got,
        code: 'READBACK_MISMATCH',
        error: `the device reports ${String(got)}${def.unit ? ` ${def.unit}` : ''}, not ${String(expected)}`,
      };
    } else {
      results[key] = { ok: true, changed: true, value: got };
    }
  }
  for (const [k, r] of Object.entries(results) as [RepeaterSettingKey, RepeaterKeyResult][]) {
    if (r.ok && !r.changed && r.value === undefined && after.values[k] !== undefined) r.value = after.values[k];
    if (REPEATER_SETTINGS.find((d) => d.key === k)?.secret) delete r.value;
  }

  const drifted: RepeaterSettingKey[] = [];
  for (const [k, v] of Object.entries(after.values) as [RepeaterSettingKey, RepeaterSettingValue][]) {
    if (k in validation.values) continue;
    if (current[k] !== undefined && !repeaterValuesEqual(k, current[k], v)) drifted.push(k);
  }

  return {
    ok: Object.values(results).every((r) => r?.ok),
    validationFailed: false,
    validationErrors: [],
    results,
    read: publicRead(after),
    drifted,
  };
}
