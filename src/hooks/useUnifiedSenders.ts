/**
 * Who can send where, for the Unified Messages composer (#3045 P2).
 *
 * Reads `GET /api/unified/senders`, which wraps its list in
 * `{ success, data: { channels } }`; `apiService.get` does not unwrap it. Live
 * state, so it polls once a minute, only while the tab is visible and the
 * composer is mounted. Neither read touches a radio.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import apiService from '../services/api';
import type { SenderRef } from '../pages/unifiedSendRequest';

export interface UnifiedSenderChannel {
  name: string;
  sources: SenderRef[];
}

export const UNIFIED_SENDERS_QUERY_KEY = ['unified', 'senders'] as const;
export const UNIFIED_SENDERS_POLL_MS = 60_000;

/** Pull the channel list out of the response. Anything unexpected reads as empty. */
export function parseUnifiedSenders(body: unknown): UnifiedSenderChannel[] {
  const data = (body as { data?: { channels?: unknown } } | null | undefined)?.data;
  const channels = data?.channels;
  return Array.isArray(channels) ? (channels as UnifiedSenderChannel[]) : [];
}

export function useUnifiedSenders(enabled: boolean): UseQueryResult<UnifiedSenderChannel[]> {
  return useQuery({
    queryKey: UNIFIED_SENDERS_QUERY_KEY,
    queryFn: async () => parseUnifiedSenders(await apiService.get<unknown>('/api/unified/senders')),
    enabled,
    refetchInterval: UNIFIED_SENDERS_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/**
 * The refs for one channel: exact name match first, then case-insensitive.
 */
export function sendersForChannel(
  channels: UnifiedSenderChannel[] | undefined,
  channelName: string,
): SenderRef[] {
  if (!channels) return [];
  const lower = channelName.toLowerCase();
  const hit =
    channels.find((c) => c.name === channelName) ??
    channels.find((c) => c.name.toLowerCase() === lower);
  return hit?.sources ?? [];
}
