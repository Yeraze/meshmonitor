/**
 * Web Push size guard (#6278).
 *
 * An encrypted Web Push record holds about 4078 bytes. The whole JSON payload
 * (title, body, data, tag) must fit, and a long message text in 4-byte
 * characters can push it over. Shorten the body until the payload fits.
 * This protects against oversized payloads whatever length the user picked.
 */
import { truncate } from '../../utils/notificationTemplate.js';

/** Leaves margin under the ~4078 byte record limit. */
export const WEB_PUSH_PAYLOAD_MAX_BYTES = 3800;

const byteLength = (payload: unknown): number => Buffer.byteLength(JSON.stringify(payload), 'utf8');

/**
 * Return the payload unchanged when it fits, else a copy with a shorter
 * `body` (never splitting an emoji). Only the body is touched.
 */
export function fitWebPushPayload<T extends { body?: string }>(
  payload: T,
  maxBytes: number = WEB_PUSH_PAYLOAD_MAX_BYTES,
): T {
  if (byteLength(payload) <= maxBytes || typeof payload.body !== 'string') return payload;
  let length = Array.from(payload.body).length;
  let next = payload;
  // Each pass drops the overshoot (a code point is at most 4 bytes, and JSON
  // escapes can add more), so this ends in a few passes.
  while (length > 4 && byteLength(next) > maxBytes) {
    const over = byteLength(next) - maxBytes;
    length = Math.max(4, length - Math.max(1, Math.ceil(over / 4)));
    next = { ...payload, body: truncate(payload.body, length) };
  }
  return next;
}
