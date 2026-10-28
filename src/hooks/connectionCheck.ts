/**
 * Connection checks for a source that is not connected.
 *
 * While a source is not connected, App checks its link every few seconds.
 * That check used to read the whole `/api/poll` (nodes, messages, channels,
 * traceroutes): 4.7 MB per call on a large MQTT source, every 5 s, for as long
 * as the source stayed down. It now reads `/api/connection`, which returns the
 * same four link flags in about 100 bytes, and reads the full poll once, when
 * the source comes back.
 */
import type { QueryClient } from '@tanstack/react-query';
import { sourcePollQueryKey } from './pollQueryKey';
import { fetchPollData, type ConnectionStatus as PollConnectionStatus, type PollData } from './usePoll';

type AuthFetch = (url: string, options?: RequestInit, signal?: AbortSignal) => Promise<Response>;

/**
 * `staleTime` for the one full poll read made when a source comes back (and on
 * Retry). Short, so a later reconnect gets a live fetch rather than an old
 * snapshot; long enough to share a fetch with a mount-time observer of the same
 * query key that is already running or just finished.
 */
export const POLL_STATUS_STALE_TIME_MS = 3000;

/**
 * Delay before each connection check while the status stays the same: 5 s,
 * then 10 s, 20 s, and 30 s from then on. A change of status, or the tab
 * becoming visible again, starts over at 5 s.
 */
export const CONNECTION_CHECK_DELAYS_MS = [5000, 10000, 20000, 30000] as const;

/** Delay for the given number of unchanged checks in a row. */
export function connectionCheckDelay(unchangedChecks: number): number {
  const i = Math.min(Math.max(0, unchangedChecks), CONNECTION_CHECK_DELAYS_MS.length - 1);
  return CONNECTION_CHECK_DELAYS_MS[i];
}

/**
 * Read one source's link status from `GET /api/connection`, the lightweight
 * endpoint that reports what `/api/poll`'s `connection` section reports (same
 * manager lookup, same address rule), without the data sections.
 */
export async function fetchConnectionStatus(
  authFetch: AuthFetch,
  baseUrl: string,
  sourceId: string | null,
  signal?: AbortSignal,
): Promise<PollConnectionStatus> {
  const url = sourceId
    ? `${baseUrl}/api/connection?sourceId=${encodeURIComponent(sourceId)}`
    : `${baseUrl}/api/connection`;
  const response = await authFetch(url, undefined, signal);
  if (!response.ok) {
    throw new Error(`Connection status request failed: ${response.status}`);
  }
  return response.json();
}

/**
 * Copy a fresh link status into the cached poll entry, so readers of
 * `pollData.connection` (useConnectionInfo, the firmware page's "gateway
 * online" check) stay current while the full poll is not being read. Keeps the
 * entry's fetch time, so the next full read is not skipped as "still fresh".
 * Does nothing when no poll has been cached yet.
 */
export function mergeConnectionIntoPollCache(
  queryClient: QueryClient,
  sourceId: string | null,
  connection: PollConnectionStatus,
): void {
  const key = sourcePollQueryKey(sourceId);
  const state = queryClient.getQueryState<PollData>(key);
  if (!state?.data) return;
  queryClient.setQueryData<PollData>(
    key,
    (old) => (old ? { ...old, connection: { ...old.connection, ...connection } } : old),
    { updatedAt: state.dataUpdatedAt },
  );
}

/**
 * Read the full poll once, through the same query entry `usePoll()` uses, so
 * it shares a fetch with any observer already reading it.
 */
export function refreshPollCache(
  queryClient: QueryClient,
  authFetch: AuthFetch,
  baseUrl: string,
  sourceId: string | null,
): Promise<PollData> {
  return queryClient.fetchQuery({
    queryKey: sourcePollQueryKey(sourceId),
    queryFn: ({ signal }) => fetchPollData(authFetch, baseUrl, sourceId, signal),
    staleTime: POLL_STATUS_STALE_TIME_MS,
  });
}
