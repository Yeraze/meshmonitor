/**
 * Auto-Acknowledge "Maximum number of responses" (`autoAckMaxResponses`):
 * bounds, default and parsing, shared by the server (which enforces it) and the
 * settings UI (which edits it). See `src/server/autoAckResponseCap.ts` for what
 * the setting does.
 */

/** Default: stay quiet once 2 other nodes have answered. */
export const AUTO_ACK_MAX_RESPONSES_DEFAULT = 2;
/** Lower bound. 0 = no cap (wait, then always answer). */
export const AUTO_ACK_MAX_RESPONSES_MIN = 0;
/** Upper bound. */
export const AUTO_ACK_MAX_RESPONSES_MAX = 10;

/**
 * Resolve a stored value. Absent / blank / malformed reads as the default (2);
 * numbers are clamped to 0-10. A stored `0` stays 0 — never use `|| default`
 * on this setting.
 */
export function resolveAutoAckMaxResponses(raw: string | null | undefined): number {
  if (raw == null) return AUTO_ACK_MAX_RESPONSES_DEFAULT;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return AUTO_ACK_MAX_RESPONSES_DEFAULT;
  const n = parseInt(text, 10);
  return Math.min(Math.max(n, AUTO_ACK_MAX_RESPONSES_MIN), AUTO_ACK_MAX_RESPONSES_MAX);
}

/** True when `value` is a legal thing to SAVE: a whole number 0-10. */
export function isValidAutoAckMaxResponses(value: unknown): boolean {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,2}$/.test(text.trim())) return false;
  const n = parseInt(text.trim(), 10);
  return n >= AUTO_ACK_MAX_RESPONSES_MIN && n <= AUTO_ACK_MAX_RESPONSES_MAX;
}
