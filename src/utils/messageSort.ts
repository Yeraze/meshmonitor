/**
 * Sort helpers for `MeshMessage` lists.
 *
 * Issue #3187: messages from nodes with bad/uninitialized RTC carry a wildly
 * wrong `timestamp`, which used to sort them to the top or bottom of channel
 * and DM lists even when MeshMonitor had received them at a normal time.
 * The server now exposes its ingest time as `receivedAt`; UI sort sites
 * should use this helper so the fallback to `timestamp` is consistent
 * (pre-migration rows from older server builds may not carry `receivedAt`).
 *
 * Display sites (per-message timestamp labels, date separators) deliberately
 * keep using `msg.timestamp` so users still see the radio's claimed time and
 * can spot misconfigured nodes.
 */
import { MeshMessage } from '../types/message';

/**
 * Returns the millisecond timestamp to use for sorting/comparison of a
 * message. Prefers server-side ingest time; falls back to the radio's
 * reported timestamp when `receivedAt` is missing.
 */
export function getMessageSortTime(msg: MeshMessage): number {
  return (msg.receivedAt ?? msg.timestamp).getTime();
}
