/**
 * Display helpers for Reticulum destinations (#6341 P3).
 *
 * An announce's `displayName` is decoded from announce bytes any peer can forge,
 * so it must be cleaned before it reaches a notification.
 */

const MAX_NAME_CODE_POINTS = 64;

/** Control chars other than the tab/CR/LF that we collapse to a space. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Clean an announced display name. Cuts at the first NUL, turns tab/CR/LF into
 * spaces, drops the name if it still holds a control char or U+FFFD, trims, caps
 * at 64 code points. Returns null when nothing is left.
 */
export function sanitizeReticulumName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const nul = raw.indexOf('\u0000');
  let s = nul >= 0 ? raw.slice(0, nul) : raw;
  s = s.replace(/[\t\r\n]/g, ' ');
  if (CONTROL_CHARS.test(s) || s.includes('�')) return null;
  s = s.trim();
  if (!s) return null;
  const points = Array.from(s);
  if (points.length > MAX_NAME_CODE_POINTS) s = points.slice(0, MAX_NAME_CODE_POINTS).join('').trim();
  return s || null;
}

/** First 8 hex chars of a destination hash plus an ellipsis. */
export function shortReticulumHash(hash: string): string {
  return `${hash.slice(0, 8)}…`;
}
