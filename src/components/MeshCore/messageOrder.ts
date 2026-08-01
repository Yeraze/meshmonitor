/**
 * Ordering for MeshCore message streams.
 *
 * Sorting on `timestamp` alone is wrong, because the two directions do not
 * share a clock or a resolution:
 *
 *   received:  timestamp = sender_timestamp * 1000   ← remote clock, WHOLE SECONDS
 *   sent:      timestamp = Date.now()                ← our clock, milliseconds
 *
 * A remote auto-responder that replies within the same second as the message
 * that triggered it therefore sorts BEFORE its own trigger. Observed in the
 * field on a MeshCore channel:
 *
 *   trigger (ours)   timestamp 1785604213050   created 1785604213050
 *   reply   (remote) timestamp 1785604213000   observed 1785604214478
 *
 * The reply arrived 1.4 s later but carried a timestamp 50 ms earlier, purely
 * because the remote could only express whole seconds.
 *
 * So: compare `timestamp` truncated to the second — the real resolution of the
 * wire format — and break ties with `receivedAt`, MeshMonitor's own monotonic
 * clock, which is stamped identically for both directions. Sub-second detail in
 * a locally-sent `timestamp` is deliberately NOT used for ordering; it is
 * precision we cannot have for the other side, and trusting it is exactly what
 * produced the inversion.
 *
 * Display continues to use `timestamp` — the sender's stated time is still the
 * honest thing to show.
 */
import type { MeshCoreMessage } from './hooks/useMeshCore';

/** Whole-second bucket of a message's stated time. */
function timestampSecond(m: Pick<MeshCoreMessage, 'timestamp'>): number {
  return Math.floor((m.timestamp ?? 0) / 1000);
}

/**
 * Tie-break clock. Falls back to `timestamp` for rows persisted before
 * `receivedAt` existed, which keeps legacy history in a stable, sensible order
 * instead of collapsing it all to zero.
 */
function observedAt(m: Pick<MeshCoreMessage, 'timestamp' | 'receivedAt'>): number {
  return typeof m.receivedAt === 'number' ? m.receivedAt : (m.timestamp ?? 0);
}

/**
 * Comparator for oldest-first message streams. Stable and total: equal seconds
 * fall back to the observed clock, and identical observed clocks fall back to
 * `id` so the order never depends on input sequence.
 */
export function compareMeshCoreMessages(
  a: Pick<MeshCoreMessage, 'id' | 'timestamp' | 'receivedAt'>,
  b: Pick<MeshCoreMessage, 'id' | 'timestamp' | 'receivedAt'>,
): number {
  const bySecond = timestampSecond(a) - timestampSecond(b);
  if (bySecond !== 0) return bySecond;

  const byObserved = observedAt(a) - observedAt(b);
  if (byObserved !== 0) return byObserved;

  return String(a.id).localeCompare(String(b.id));
}

/** Convenience: oldest-first copy of a message list. */
export function sortMeshCoreMessages<T extends Pick<MeshCoreMessage, 'id' | 'timestamp' | 'receivedAt'>>(
  messages: T[],
): T[] {
  return [...messages].sort(compareMeshCoreMessages);
}
