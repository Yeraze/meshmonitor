/**
 * Which clock a MeshCore message shows and sorts by, and how far the sender's
 * clock sits from ours (#5973).
 *
 * A MeshCore message carries its sender's `sender_timestamp`. Every node keeps
 * its own clock and nothing keeps them in step, so a sender a few minutes off
 * passes the #5339 plausibility gate and still lands out of order. So:
 *
 * - DMs and channel messages show and sort by MeshMonitor's own receipt time
 *   (`receivedAt` on live and reloaded rows, `createdAt` on raw DB rows).
 * - Room posts keep the sender's time. A room server replays its backlog on
 *   login, so receipt time there is the login time, not the post time.
 * - Beside the time, the stream shows the sender's offset (receipt minus
 *   sender time) when it is believable and at least
 *   {@link MESHCORE_CLOCK_OFFSET_MIN_MS}.
 *
 * The raw wire second stays stored and keeps feeding the cross-source dedup
 * key, the MC1 reaction hash and channel resend; this module only reads it.
 */
import { isPlausibleMeshCoreMessageTimeMs } from './meshcoreTimestamp.js';
import { storedWireSecond } from './meshcoreReactionTarget.js';

/** Offsets smaller than this are ordinary skew and are not shown. */
export const MESHCORE_CLOCK_OFFSET_MIN_MS = 5_000;

/** The fields this module reads. Every one but `id` and `timestamp` is optional. */
export interface MeshCoreTimedMessage {
  id: string;
  timestamp: number;
  receivedAt?: number | null;
  createdAt?: number | null;
  senderTimestamp?: number | null;
  messageType?: string | null;
}

/** True for a room server post, which keeps sender-time display and order. */
export function isMeshCoreRoomPost(m: Pick<MeshCoreTimedMessage, 'messageType'>): boolean {
  return m.messageType === 'room_post';
}

/**
 * MeshMonitor's own receipt clock (ms): `receivedAt`, else `createdAt`, else
 * `timestamp` for rows from before either existed.
 */
export function meshcoreReceiptTimeMs(
  m: Pick<MeshCoreTimedMessage, 'timestamp' | 'receivedAt' | 'createdAt'>,
): number {
  if (typeof m.receivedAt === 'number' && m.receivedAt > 0) return m.receivedAt;
  if (typeof m.createdAt === 'number' && m.createdAt > 0) return m.createdAt;
  return m.timestamp ?? 0;
}

/**
 * The time a message shows (ms). Receipt time, except for a room post, which
 * shows `timestamp` (the sender's time, or the receipt clock when the server
 * rejected the sender's).
 */
export function meshcoreDisplayTimeMs(m: MeshCoreTimedMessage): number {
  return isMeshCoreRoomPost(m) ? (m.timestamp ?? 0) : meshcoreReceiptTimeMs(m);
}

/**
 * Receipt time minus sender time (ms), or null when it should not be shown:
 * no sender time stored, a sender time that fails the ±24 h check
 * ({@link isPlausibleMeshCoreMessageTimeMs}), or an offset under
 * {@link MESHCORE_CLOCK_OFFSET_MIN_MS} either way.
 */
export function meshcoreClockOffsetMs(
  receiptMs: number,
  senderTimestampSec: number | null | undefined,
): number | null {
  if (typeof senderTimestampSec !== 'number' || !Number.isFinite(senderTimestampSec) || senderTimestampSec <= 0) {
    return null;
  }
  if (!Number.isFinite(receiptMs) || receiptMs <= 0) return null;
  const senderMs = senderTimestampSec * 1000;
  if (!isPlausibleMeshCoreMessageTimeMs(senderMs, receiptMs)) return null;
  const offset = receiptMs - senderMs;
  return Math.abs(offset) < MESHCORE_CLOCK_OFFSET_MIN_MS ? null : offset;
}

/** {@link meshcoreClockOffsetMs} for one message. Room posts never show one. */
export function meshcoreMessageClockOffsetMs(m: MeshCoreTimedMessage): number | null {
  if (isMeshCoreRoomPost(m)) return null;
  return meshcoreClockOffsetMs(meshcoreReceiptTimeMs(m), storedWireSecond(m));
}

/**
 * A signed short duration, rounded to the second, with zero units left out:
 * `+15m30s`, `-15m30s`, `+1h2m3s`, `+45s`, `+2m`. Zero is `+0s`.
 */
export function formatMeshCoreClockOffset(offsetMs: number): string {
  const sign = offsetMs < 0 ? '-' : '+';
  let total = Math.round(Math.abs(offsetMs) / 1000);
  const h = Math.floor(total / 3600);
  total -= h * 3600;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  let out = '';
  if (h > 0) out += `${h}h`;
  if (m > 0) out += `${m}m`;
  if (s > 0 || out === '') out += `${s}s`;
  return `${sign}${out}`;
}
