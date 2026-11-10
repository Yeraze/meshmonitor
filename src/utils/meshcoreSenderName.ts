/**
 * Validation for the optional `senderName` override on MeshCore channel sends
 * (#6282). The name is written into the packet as `"<name>: <text>"`, so it
 * must be a name the firmware could hold (`node_name` is `char[32]`, so at most
 * 31 UTF-8 bytes) and must not be able to forge the `": "` separator, hide
 * itself with control or bidi characters, or look like a `#region` name.
 */

export const SENDER_NAME_MAX_BYTES = 31;
export const SENDER_NAME_ALLOWLIST_MAX = 16;

export type SenderNameProblem =
  | 'empty'
  | 'too_long'
  | 'colon'
  | 'control'
  | 'bidi_or_zero_width'
  | 'leading_hash'
  | 'not_string';

export type SenderNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: SenderNameProblem };

// C0 (incl. NUL, \n, \r, \t), DEL, C1.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;
// Zero-width, bidi marks and overrides/isolates, BOM.
const BIDI_ZW_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

/** NFC-normalise, trim, then validate. Never throws. */
export function validateMeshcoreSenderName(input: unknown): SenderNameResult {
  if (typeof input !== 'string') return { ok: false, reason: 'not_string' };
  // Scan before trim: String.trim() strips U+FEFF and would hide it.
  const normalized = input.normalize('NFC');
  if (CONTROL_RE.test(normalized)) return { ok: false, reason: 'control' };
  if (BIDI_ZW_RE.test(normalized)) return { ok: false, reason: 'bidi_or_zero_width' };
  const name = normalized.trim();
  if (name.length === 0) return { ok: false, reason: 'empty' };
  if (name.includes(':')) return { ok: false, reason: 'colon' };
  if (name.startsWith('#')) return { ok: false, reason: 'leading_hash' };
  if (new TextEncoder().encode(name).length > SENDER_NAME_MAX_BYTES) return { ok: false, reason: 'too_long' };
  return { ok: true, name };
}

/** Normalised form used for allowlist comparison (NFC + trim, case-sensitive). */
export function normalizeSenderName(input: string): string {
  return input.normalize('NFC').trim();
}
