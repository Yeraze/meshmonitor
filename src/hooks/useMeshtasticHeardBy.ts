/**
 * useMeshtasticHeardBy — TanStack Query hook for a Meshtastic message's
 * Heard-By list (Delivery Diagnostics epic #4816, Phase 4, WP3).
 *
 * Lazily fetches the persisted `meshtastic_heard_repeaters` rows for one
 * message via `GET /api/sources/:id/messages/:messageId/heard-by` behind
 * `ApiService.getMeshtasticHeardBy`. Candidate resolution (relay byte → node
 * names) happens server-side; this hook stays dumb. The Delivery Details
 * modal calls this when it opens; the query is disabled until both
 * `sourceId` and `messageId` are known — the modal additionally gates on
 * protocol/channel (Meshtastic channel messages only) before calling this.
 *
 * No raw fetch (banned in components) — everything goes through ApiService.
 */
import { useQuery } from '@tanstack/react-query';
import apiService from '../services/api';
import type { MeshtasticHeardByEntry } from '../types/message';

export interface UseMeshtasticHeardByResult {
  /** Observed relay bytes ordered by best SNR first (server orders them); [] until loaded. */
  heardBy: MeshtasticHeardByEntry[];
  isLoading: boolean;
  isError: boolean;
}

/**
 * Fetch the Meshtastic Heard-By list for a single message.
 *
 * @param sourceId owning source; the query stays disabled while falsy.
 * @param messageId the message row's string id (`messages.id`).
 */
export function useMeshtasticHeardBy(sourceId: string, messageId: string): UseMeshtasticHeardByResult {
  const query = useQuery({
    queryKey: ['meshtasticHeardBy', sourceId, messageId],
    queryFn: () => apiService.getMeshtasticHeardBy(sourceId, messageId),
    enabled: Boolean(sourceId && messageId),
    staleTime: 15_000,
  });

  return {
    heardBy: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
