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
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCsrf } from '../contexts/CsrfContext';

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

/**
 * Clear the unread DM badge on every source the caller may read (#5197).
 *
 * The server marks exactly what `/unread-by-source` counts — same traversal —
 * so the badges are guaranteed to reach zero rather than leaving a stubborn
 * remainder from a conversation the sweep missed.
 *
 * Invalidates `unreadCounts` as well as `unreadBySource`: the per-conversation
 * badges elsewhere in the app read the same read-state, and leaving them stale
 * would show a source with no badge whose conversations still look unread.
 */
export function useMarkAllDmsRead({ baseUrl = '' }: { baseUrl?: string } = {}) {
  const queryClient = useQueryClient();
  const { getToken: getCsrfToken } = useCsrf();

  return useMutation({
    mutationFn: async (): Promise<{ marked: number; sources: number }> => {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      const csrfToken = getCsrfToken();
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const response = await fetch(`${baseUrl}/api/messages/mark-all-dms-read`, {
        method: 'POST',
        headers,
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(`Failed to mark all DMs as read: ${response.status}`);
      }
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['unreadBySource'] });
      void queryClient.invalidateQueries({ queryKey: ['unreadCounts'] });
    },
  });
}
