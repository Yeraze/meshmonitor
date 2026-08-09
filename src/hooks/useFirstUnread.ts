/**
 * First-unread timestamps hook (#4607).
 *
 * Companion to `useUnreadCounts`: where that answers "how many unread?", this
 * answers "which message did I stop reading at?" — the timestamp of the oldest
 * still-unread message in each Meshtastic conversation, for the unread divider
 * and the jump-to-first-unread entry scroll.
 *
 * Meshtastic has no separate watermark table. Read state already lives in
 * `read_messages` (durable, per-user), so the anchor is derived from it server
 * side rather than duplicated — one source of truth, so "Mark all read" can
 * never disagree with the divider.
 *
 * The polled value is a snapshot of what was unread BEFORE the user opened a
 * conversation. That is exactly right: the views mark a conversation read
 * within a tick of entry, so consumers pin the value at entry (see
 * `MessagingContext.pinnedFirstUnread*`) rather than reading it live.
 */

import { useQuery } from '@tanstack/react-query';

export interface FirstUnreadData {
  /** Oldest unread message timestamp (ms) per channel id. */
  channels: { [channelId: number]: number };
  /** Oldest unread message timestamp (ms) per DM peer node id. */
  directMessages: { [nodeId: string]: number };
}

interface UseFirstUnreadOptions {
  baseUrl?: string;
  enabled?: boolean;
  /** Poll interval in ms (default 10s, matching useUnreadCounts). */
  refetchInterval?: number;
  /** Optional source scope — when set, results are filtered to this source. */
  sourceId?: string | null;
  /** When true, MQTT/bridge messages are excluded, matching the badge counts. */
  excludeMqtt?: boolean;
}

const EMPTY: FirstUnreadData = { channels: {}, directMessages: {} };

export function useFirstUnread({
  baseUrl = '',
  enabled = true,
  refetchInterval = 10000,
  sourceId,
  excludeMqtt,
}: UseFirstUnreadOptions = {}) {
  return useQuery<FirstUnreadData>({
    queryKey: ['firstUnread', baseUrl, sourceId ?? null, !!excludeMqtt],
    queryFn: async (): Promise<FirstUnreadData> => {
      const params = new URLSearchParams();
      if (sourceId) params.set('sourceId', sourceId);
      if (excludeMqtt) params.set('excludeMqtt', 'true');
      const qs = params.toString();
      const url = qs
        ? `${baseUrl}/api/messages/first-unread?${qs}`
        : `${baseUrl}/api/messages/first-unread`;

      const response = await fetch(url, { credentials: 'include' });

      // An unauthenticated / unpermitted session simply has no divider — the
      // rest of the messaging UI must keep working.
      if (response.status === 401 || response.status === 403) return EMPTY;
      if (!response.ok) {
        throw new Error(`Failed to fetch first-unread: ${response.status} ${response.statusText}`);
      }

      // `ok(res, data)` envelope; ApiService does not unwrap, so we do.
      const body = await response.json();
      const data = body?.data ?? body;
      return {
        channels: data?.channels ?? {},
        directMessages: data?.directMessages ?? {},
      };
    },
    enabled,
    refetchInterval,
    staleTime: Math.max(refetchInterval - 2000, 0),
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
