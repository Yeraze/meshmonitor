/**
 * Ordering for MeshCore message streams.
 *
 * ## DMs and channel messages: receipt time (#5973)
 *
 * These sort on MeshMonitor's own receipt clock (`receivedAt`, or `createdAt`
 * on a raw DB row), not on the sender's `sender_timestamp`. Every MeshCore
 * node keeps its own clock and nothing keeps them in step: a sender whose
 * clock is 15 minutes off passes the #5339 plausibility gate and would still
 * put its messages 15 minutes out of sequence. Our clock is the one clock
 * every row shares, at millisecond resolution, for both directions, so it
 * also settles the older same-second inversion (a remote auto-reply stamped
 * in whole seconds sorting before the ms-precision send that triggered it).
 *
 * ## Room posts: sender time
 *
 * A room server replays its backlog when we log in, so receipt time there is
 * the login time, not the post time. Room posts keep the old rule: compare
 * `timestamp` truncated to the second (the wire's real resolution) and break
 * ties on the receipt clock. A stated time that could not have been real when
 * we observed the post (#5339) is replaced by the receipt clock.
 *
 * Ties fall back to the receipt clock, then to `id`, so the order is total and
 * never depends on input sequence.
 */
import type { MeshCoreMessage } from './hooks/useMeshCore';
import { isPlausibleMeshCoreMessageTimeMs } from '../../utils/meshcoreTimestamp';
import { isMeshCoreRoomPost, meshcoreReceiptTimeMs } from '../../utils/meshcoreMessageTime';

type Orderable = Pick<MeshCoreMessage, 'id' | 'timestamp' | 'receivedAt' | 'messageType'> & {
  createdAt?: number | null;
};

/** Primary sort key (ms). */
function orderingTime(m: Orderable): number {
  const receipt = meshcoreReceiptTimeMs(m);
  if (!isMeshCoreRoomPost(m)) return receipt;
  const stated = m.timestamp ?? 0;
  const hasReceipt = typeof m.receivedAt === 'number' || typeof m.createdAt === 'number';
  if (hasReceipt && !isPlausibleMeshCoreMessageTimeMs(stated, receipt)) return receipt;
  // Whole seconds: a room post's stated time has no finer resolution.
  return Math.floor(stated / 1000) * 1000;
}

/**
 * Comparator for oldest-first message streams. Stable and total: equal keys
 * fall back to the receipt clock, then to `id`.
 */
export function compareMeshCoreMessages(a: Orderable, b: Orderable): number {
  const byKey = orderingTime(a) - orderingTime(b);
  if (byKey !== 0) return byKey;

  const byObserved = meshcoreReceiptTimeMs(a) - meshcoreReceiptTimeMs(b);
  if (byObserved !== 0) return byObserved;

  return String(a.id).localeCompare(String(b.id));
}

/** Convenience: oldest-first copy of a message list. */
export function sortMeshCoreMessages<T extends Orderable>(messages: T[]): T[] {
  return [...messages].sort(compareMeshCoreMessages);
}
