/**
 * Redaction for anything a log line might carry (#5122 follow-up).
 *
 * MeshMonitor logs decoded protobufs liberally at debug level, and several of
 * those messages carry credentials in the clear:
 *
 *   - `config.security.private_key` / `admin_key` — the node's identity
 *   - `config.network.wifi_psk` — the operator's WiFi password
 *   - `moduleConfig.mqtt.password` — broker credentials
 *   - `channel.settings.psk` — the channel key everything is encrypted with
 *   - `config.bluetooth.fixed_pin` — the pairing PIN
 *
 * A reporter found these written on every poll cycle while a config sync was
 * running, which on a mesh where the sync keeps restarting means they land in
 * the log over and over. Anyone who then shares a debug log to get help — the
 * normal thing to ask of a bug reporter — hands over their WiFi password and
 * node private key with it.
 *
 * The value is replaced rather than dropped, and the replacement keeps the
 * length: "is the PSK present, and is it 16 or 32 bytes?" is a real debugging
 * question, and neither fact is sensitive. Only the bytes are.
 */

/**
 * Keys whose VALUE is a secret, compared case-insensitively with separators
 * stripped — so `wifi_psk`, `wifiPsk` and `WIFIPSK` all match. protobufjs hands
 * us camelCase, the .proto files use snake_case, and both spellings reach logs.
 *
 * `publicKey` is deliberately absent: it is public by definition, it is printed
 * all over the UI, and redacting it would make key-mismatch debugging painful
 * for no benefit.
 */
const SECRET_KEYS = new Set([
  'psk',
  'wifipsk',
  'privatekey',
  'adminkey',
  'password',
  'fixedpin',
  'sessionpasskey',
  'passkey',
]);

const REDACTED = '[redacted]';

/**
 * Keys that must never be written back onto the copy.
 *
 * The object being walked comes off the radio, so its key names are remote
 * input. Writing `out['__proto__'] = ...` on a normal object literal reassigns
 * that object's prototype rather than adding a property — prototype injection,
 * which CodeQL flags as `js/remote-property-injection`. The copy is built with
 * a null prototype so there is nothing to pollute, and these keys are dropped
 * outright so the dynamic write can never reach a prototype slot at all.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Guard against a pathological or cyclic shape in a logging path. */
const MAX_DEPTH = 12;

const normalizeKey = (key: string): string => key.replace(/[_\-\s]/g, '').toLowerCase();

const isSecretKey = (key: string): boolean => SECRET_KEYS.has(normalizeKey(key));

/** Describe a redacted value without revealing it. */
function describe(value: unknown): string {
  if (typeof value === 'string') return `${REDACTED}: ${value.length} chars`;
  if (typeof value === 'number') return REDACTED;
  if (value instanceof Uint8Array || Array.isArray(value)) {
    return `${REDACTED}: ${(value as { length: number }).length} bytes`;
  }
  if (value && typeof value === 'object' && typeof (value as { length?: unknown }).length === 'number') {
    return `${REDACTED}: ${(value as { length: number }).length} bytes`;
  }
  return REDACTED;
}

/**
 * Deep-copy `value`, replacing any secret-keyed value with a safe placeholder.
 *
 * Never throws: this runs on a logging path, where blowing up would be a worse
 * outcome than an unredacted line. A cycle or an over-deep object collapses to
 * a marker rather than recursing forever.
 */
export function redactSecrets(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return '[depth limit]';
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  // Binary blobs log as-is; only a secret-KEYED one gets replaced, by the
  // parent. Left intact here so a public key still prints.
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1, seen));
  }

  // Null prototype: the keys below are remote input, so there must be no
  // prototype for a crafted name to reach.
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(k)) {
      // Dropped rather than copied — a device sending one of these is either
      // broken or hostile, and either way the log line should say so.
      out[`${k} (dropped)`] = '[unsafe key]';
      continue;
    }
    out[k] = isSecretKey(k) ? describe(v) : redactSecrets(v, depth + 1, seen);
  }
  return out;
}

/**
 * Drop-in replacement for `JSON.stringify` on a logging path.
 *
 * Use this instead of `JSON.stringify` in every `logger.*` call that prints a
 * decoded protobuf, a device config, or anything else originating from the
 * radio — it is impossible to be sure at the call site that a given message
 * type will never grow a credential field, and the cost of being wrong is a
 * secret in a shared log file.
 */
export function safeJson(value: unknown, space?: number): string {
  try {
    return JSON.stringify(redactSecrets(value), null, space);
  } catch {
    return '[unserializable]';
  }
}
