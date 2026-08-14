/**
 * Ordering for Reticulum LXMF message streams (#3960 Phase 2 WP5).
 *
 * Unlike MeshCore's `messageOrder.ts` (whose comparator truncates to whole
 * seconds to work around a remote-clock precision mismatch), Reticulum
 * doesn't have that problem: every bridge->Node envelope carries its own
 * `ts` field in epoch **milliseconds** (`reticulumProtocol.ts`'s `Envelope.ts`
 * doc: "epoch_ms"), and `ReticulumManager` copies that same field straight
 * into the persisted `timestamp` column for inbound messages
 * (`persistLxmfMessage`: `timestamp: msg.ts`) — it is NOT the LXMF message's
 * own embedded float-seconds timestamp. Outbound messages use `Date.now()`
 * for the same column. So both directions share one millisecond-resolution
 * clock and a plain numeric comparison on `timestamp` is correct — no
 * per-second bucketing needed.
 *
 * Ties (identical `timestamp`, e.g. a reflected/duplicate delivery) fall
 * back to `receivedAt` — MeshMonitor's own monotonic ingestion clock — then
 * to `id`, so the order is always total and stable regardless of input
 * sequence.
 */
import type { ReticulumMessageRow } from '../../types/reticulum';

/** Tie-break clock. Falls back to `timestamp` when `receivedAt` is absent (e.g. an optimistic outbound row hasn't been reconciled with a server-assigned `receivedAt` yet). */
function observedAt(m: Pick<ReticulumMessageRow, 'timestamp' | 'receivedAt'>): number {
  return typeof m.receivedAt === 'number' ? m.receivedAt : m.timestamp;
}

/**
 * Comparator for oldest-first message streams. Stable and total: equal
 * timestamps fall back to the observed clock, and identical observed clocks
 * fall back to `id` so the order never depends on input sequence.
 */
export function compareReticulumMessages(
  a: Pick<ReticulumMessageRow, 'id' | 'timestamp' | 'receivedAt'>,
  b: Pick<ReticulumMessageRow, 'id' | 'timestamp' | 'receivedAt'>,
): number {
  const byTimestamp = a.timestamp - b.timestamp;
  if (byTimestamp !== 0) return byTimestamp;

  const byObserved = observedAt(a) - observedAt(b);
  if (byObserved !== 0) return byObserved;

  return String(a.id).localeCompare(String(b.id));
}

/** Convenience: oldest-first copy of a message list. */
export function sortReticulumMessages<T extends Pick<ReticulumMessageRow, 'id' | 'timestamp' | 'receivedAt'>>(
  messages: T[],
): T[] {
  return [...messages].sort(compareReticulumMessages);
}
