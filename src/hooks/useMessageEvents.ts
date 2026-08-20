/**
 * useMessageEvents — TanStack Query hook for a message's delivery event
 * timeline (Delivery Diagnostics epic #4816, Phase 3, WP4).
 *
 * Lazily fetches the persisted `message_events` rows for one message via the
 * single protocol-neutral route (`GET /api/sources/:id/messages/:messageId/
 * events`) behind `ApiService.getMessageEvents`. The Delivery Details modal
 * calls this when it opens; the query is disabled until both `sourceId` and
 * `messageId` are known, so received-only views and the empty-source fallback
 * never fire a request.
 *
 * No raw fetch (banned in components) — everything goes through ApiService.
 */
import { useQuery } from '@tanstack/react-query';
import apiService from '../services/api';
import type { MessageEvent } from '../types/message';

export interface UseMessageEventsResult {
  /** Chronological-ascending events (server orders them); [] until loaded. */
  events: MessageEvent[];
  isLoading: boolean;
  isError: boolean;
}

/**
 * Fetch the delivery event timeline for a single message.
 *
 * @param sourceId owning source; the query stays disabled while falsy.
 * @param messageId the message row's string id (`messages.id` /
 *   `meshcore_messages.id`).
 */
export function useMessageEvents(sourceId: string, messageId: string): UseMessageEventsResult {
  const query = useQuery({
    queryKey: ['messageEvents', sourceId, messageId],
    queryFn: () => apiService.getMessageEvents(sourceId, messageId),
    enabled: Boolean(sourceId && messageId),
    staleTime: 15_000,
  });

  return {
    events: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
