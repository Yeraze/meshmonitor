/**
 * MQTT root topic helpers (#6287). Shared by the browser and the server.
 *
 * Implements the client rules of meshtastic/design#167 (R4, R8): which roots
 * are valid, how a heard topic maps back to a root, and how a segment is
 * cleaned and trimmed to the firmware's 31-byte limit.
 */

export const MAX_ROOT_BYTES = 31;

export type MqttRootErrorCode =
  | 'WHITESPACE'
  | 'CONTROL'
  | 'INVISIBLE'
  | 'WILDCARD'
  | 'SLASH'
  | 'ENDS_WITH_2'
  | 'TOO_LONG';

export type MqttRootValidation = { ok: true } | { ok: false; code: MqttRootErrorCode };

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function utf8ByteLength(s: string): number {
  return encoder.encode(s).length;
}

/**
 * Check a root against R8. An empty string is valid: it means "firmware
 * default" for a device.
 */
export function validateMqttRoot(s: string): MqttRootValidation {
  if (s === '') return { ok: true };
  // Cf covers ZWSP/ZWJ/BOM and bidi marks. Checked before whitespace because
  // JS \s also matches U+FEFF.
  if (/[\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u.test(s)) return { ok: false, code: 'INVISIBLE' };
  if (/[\s\p{Z}]/u.test(s)) return { ok: false, code: 'WHITESPACE' };
  if (/\p{Cc}/u.test(s)) return { ok: false, code: 'CONTROL' };
  if (/[+#]/.test(s)) return { ok: false, code: 'WILDCARD' };
  if (s.startsWith('/') || s.endsWith('/') || s.includes('//')) {
    return { ok: false, code: 'SLASH' };
  }
  if (s === '2' || s.endsWith('/2')) return { ok: false, code: 'ENDS_WITH_2' };
  if (utf8ByteLength(s) > MAX_ROOT_BYTES) return { ok: false, code: 'TOO_LONG' };
  return { ok: true };
}

/**
 * True when a root differs from the saved one and breaks R8. The server
 * refuses exactly this on save (#6338); an unchanged bad root still saves.
 */
export function isChangedInvalidMqttRoot(next: string, saved: string | null | undefined): boolean {
  if (next === (saved ?? '')) return false;
  return !validateMqttRoot(next).ok;
}

/** NFC-compose and keep only letters and digits in any script. */
export function sanitizeSegment(s: string): string {
  return s.normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '').normalize('NFC');
}

/** Cut a string to at most `maxBytes` UTF-8 bytes, never inside a code point. */
export function trimToBytes(root: string, maxBytes: number = MAX_ROOT_BYTES): string {
  if (utf8ByteLength(root) <= maxBytes) return root;
  let out = '';
  let used = 0;
  for (const ch of root) {
    const n = utf8ByteLength(ch);
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

/**
 * Strip the `/2/e/<channel>/<gateway>` or `/2/map/` tail off a topic and return
 * the root. Anything else returns null.
 */
export function rootFromTopic(topic: string): string | null {
  const m = /^(.+?)\/2\/(?:e\/[^/]+\/[^/]+|map\/?)$/.exec(topic);
  if (!m) return null;
  const root = m[1];
  if (root.startsWith('/') || root.includes('//')) return null;
  return root;
}

/** The gateway id (last segment) of a `/2/e/<channel>/<gateway>` topic, else null. */
export function gatewayFromTopic(topic: string): string | null {
  const m = /\/2\/e\/[^/]+\/([^/]+)$/.exec(topic);
  return m ? m[1] : null;
}

/** Number of `/`-separated segments in a root. */
export function rootDepth(root: string): number {
  return root === '' ? 0 : root.split('/').length;
}
