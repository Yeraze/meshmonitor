/**
 * Unread counts hook using TanStack Query
 *
 * Provides a hook for fetching unread message counts
 * with automatic caching and periodic refetching.
 * Used for displaying unread badges on channels and DMs.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCsrf } from '../contexts/CsrfContext';

/**
 * Unread counts response from the backend
 */
export interface UnreadCountsData {
  /** Unread count per channel ID */
  channels: { [channelId: number]: number };
  /** Unread count per node ID (for DMs) */
  directMessages: { [nodeId: string]: number };
}

/**
 * Options for useUnreadCounts hook
 */
interface UseUnreadCountsOptions {
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
  /** Refetch interval in milliseconds (default: 10000) */
  refetchInterval?: number;
}

/**
 * Hook to fetch unread message counts
 *
 * Uses TanStack Query for:
 * - Automatic request deduplication (prevents duplicate in-flight requests)
 * - Caching with configurable stale time
 * - Automatic background refetching
 * - Loading and error states
 *
 * @param options - Configuration options
 * @returns TanStack Query result with unread counts data
 *
 * @example
 * ```tsx
 * const { data: unreadCounts } = useUnreadCounts({ baseUrl });
 *
 * // Check if channel has unread messages
 * const hasUnread = unreadCounts?.channels[channelId] > 0;
 * ```
 */
export function useUnreadCounts({
  baseUrl = '',
  enabled = true,
  refetchInterval = 10000,
}: UseUnreadCountsOptions = {}) {
  return useQuery({
    queryKey: ['unreadCounts', baseUrl],
    queryFn: async (): Promise<UnreadCountsData> => {
      const response = await fetch(`${baseUrl}/api/messages/unread-counts`, {
        credentials: 'include',
      });

      // Return empty data on auth errors (403/401) instead of throwing
      // This prevents the UI from breaking when user is not authenticated
      if (response.status === 401 || response.status === 403) {
        return { channels: {}, directMessages: {} };
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch unread counts: ${response.status} ${response.statusText}`);
      }

      return response.json();
    },
    enabled,
    refetchInterval,
    staleTime: refetchInterval - 2000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/**
 * Options for markMessagesAsRead mutation
 */
interface MarkAsReadOptions {
  /** Specific message IDs to mark as read */
  messageIds?: string[];
  /** Mark all messages in a channel as read */
  channelId?: number;
  /** Mark all DMs with a node as read */
  nodeId?: string;
  /** Mark ALL DMs as read (across all nodes) */
  allDMs?: boolean;
}

/**
 * Options for useMarkAsRead hook
 */
interface UseMarkAsReadOptions {
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
}

/**
 * Hook to mark messages as read
 *
 * Uses TanStack Query mutation with automatic cache invalidation.
 *
 * @param options - Configuration options
 * @returns TanStack Query mutation for marking messages as read
 *
 * @example
 * ```tsx
 * const { mutate: markAsRead } = useMarkAsRead({ baseUrl });
 *
 * // Mark all messages in channel 0 as read
 * markAsRead({ channelId: 0 });
 *
 * // Mark DMs with a specific node as read
 * markAsRead({ nodeId: '!abcd1234' });
 * ```
 */
export function useMarkAsRead({ baseUrl = '' }: UseMarkAsReadOptions = {}) {
  const queryClient = useQueryClient();
  const { getToken: getCsrfToken } = useCsrf();

  return useMutation({
    mutationFn: async (options: MarkAsReadOptions): Promise<void> => {
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };

      const csrfToken = getCsrfToken();
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(`${baseUrl}/api/messages/mark-read`, {
        method: 'POST',
        headers,
        body: JSON.stringify(options),
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error(`Failed to mark messages as read: ${response.status} ${response.statusText}`);
      }
    },
    onSuccess: () => {
      // Invalidate and refetch unread counts after marking as read
      queryClient.invalidateQueries({ queryKey: ['unreadCounts'] });
    },
  });
}
