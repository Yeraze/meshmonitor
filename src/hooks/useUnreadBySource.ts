/**
 * Per-source unread DM counts for the Sources list badge (#5124).
 *
 * One request for every source, rather than one `useUnreadCounts` call per
 * source: the list refetches on a timer and the reporter who asked for this
 * runs 5+ sources, so per-source polling would multiply the request rate by
 * the number of sources for a single row of badges.
 *
 * The server decides what the caller may see — `messages:read` is re-checked
 * per source id, senders are filtered by channel visibility, muted DMs are
 * dropped — and omits anything it will not answer for. So a source missing
 * from the map means "no badge", never "zero, honest".
 */
import { useQuery } from '@tanstack/react-query';

export interface UnreadBySourceData {
  /** Source id -> counts. A source the caller cannot read is absent, not 0. */
  sources: { [sourceId: string]: { directMessages: number } };
}

interface UseUnreadBySourceOptions {
  baseUrl?: string;
  /** Pass the user's `unreadIndicatorEnabled` preference — off means no polling at all. */
  enabled?: boolean;
  refetchInterval?: number;
}

const EMPTY: UnreadBySourceData = { sources: {} };

export function useUnreadBySource({
  baseUrl = '',
  enabled = true,
  refetchInterval = 15000,
}: UseUnreadBySourceOptions = {}) {
  return useQuery({
    queryKey: ['unreadBySource', baseUrl],
    queryFn: async (): Promise<UnreadBySourceData> => {
      const response = await fetch(`${baseUrl}/api/messages/unread-by-source`, {
        credentials: 'include',
      });

      // Anonymous / unauthorized is a normal state for this endpoint, not an
      // error worth surfacing — the badge simply does not appear.
      if (response.status === 401 || response.status === 403) return EMPTY;

      if (!response.ok) {
        throw new Error(`Failed to fetch per-source unread counts: ${response.status}`);
      }
      return response.json();
    },
    enabled,
    refetchInterval,
    staleTime: Math.max(refetchInterval - 2000, 0),
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
