/**
 * Poll query keys, kept in a module with no imports so a component can
 * invalidate the poll cache without pulling in `usePoll.ts` (which loads
 * `init.ts` and its side effects). `usePoll.ts` re-exports both names.
 */

/**
 * Query key for the poll endpoint.
 *
 * Use this when you need to:
 * - Invalidate the poll cache: `queryClient.invalidateQueries({ queryKey: POLL_QUERY_KEY })`
 * - Manually refetch: `queryClient.refetchQueries({ queryKey: POLL_QUERY_KEY })`
 * - Set up custom query observers
 *
 * For accessing cached data, prefer the helper functions in useServerData.ts:
 * `getNodesFromCache()`, `getChannelsFromCache()`, `getCurrentNodeIdFromCache()`
 */
export const POLL_QUERY_KEY = ['poll'] as const;

/**
 * Build a per-source poll query key. Use this when invalidating/reading cache
 * for a specific source rather than the global poll.
 */
export function sourcePollQueryKey(sourceId: string | null) {
  return sourceId ? (['poll', sourceId] as const) : POLL_QUERY_KEY;
}
