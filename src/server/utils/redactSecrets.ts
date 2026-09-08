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

const normalizeKey = (key: string): string => key.replace(/[_\-\s]/g, '').toLowerCase();

const isSecretKey = (key: string): boolean => SECRET_KEYS.has(normalizeKey(key));

/**
 * Redact through a `JSON.stringify` replacer rather than by copying into a new
 * object.
 *
 * The first version deep-copied, writing `out[k] = ...` where `k` came off the
 * radio. CodeQL flagged that as `js/remote-property-injection` (high) and was
 * right to: a crafted `__proto__` key reassigns the copy's prototype instead of
 * adding a property. A null-prototype target plus a denylist fixes the actual
 * vulnerability, but leaves a dynamic write with a tainted key that the query
 * still — reasonably — cannot prove safe.
 *
 * A replacer has no such sink. Substituting a value for a key is exactly what
 * the API is for, no property is ever written from remote input, and the result
 * is simpler and faster than building a parallel object. The vulnerability is
 * gone by construction rather than mitigated in place.
 */

/** Describe a redacted value without revealing it. */
function describe(value: unknown): string {
  if (typeof value === 'string') return `${REDACTED}: ${value.length} chars`;
  if (typeof value === 'number') return REDACTED;
  if (value && typeof value === 'object' && typeof (value as { length?: unknown }).length === 'number') {
    return `${REDACTED}: ${(value as { length: number }).length} bytes`;
  }
  return REDACTED;
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
  // Reported for a value already emitted elsewhere in the same document, which
  // includes genuine cycles. Logs care about "don't hang or throw", not about
  // distinguishing a cycle from a shared reference.
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (key && isSecretKey(key)) return describe(val);
        if (val !== null && typeof val === 'object') {
          if (seen.has(val as object)) return '[circular]';
          seen.add(val as object);
        }
        return val;
      },
      space,
    );
  } catch {
    return '[unserializable]';
  }
}
