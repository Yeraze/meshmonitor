/**
 * useSourceChannels — the channel list of one named source (#5685).
 *
 * `useChannels()` reads the poll cache of the ACTIVE source. A surface that
 * lets the user pick the source (the Map Analysis waypoint editor) needs the
 * picked source's channels instead, or the waypoint goes out on a slot that
 * means something else on that radio (#4341). The route applies the caller's
 * per-channel read permission and never returns a PSK to a reader.
 */
import { useQuery } from '@tanstack/react-query';
import apiService from '../services/api';
import type { Channel } from '../types/device';

export function useSourceChannels(sourceId: string | null | undefined) {
  const query = useQuery<Channel[]>({
    queryKey: ['sourceChannels', sourceId ?? ''],
    queryFn: async () => {
      const body = await apiService.get<Channel[]>(`/api/sources/${encodeURIComponent(sourceId as string)}/channels`);
      return Array.isArray(body) ? body : [];
    },
    enabled: Boolean(sourceId),
    staleTime: 30_000,
  });
  return { channels: query.data ?? [], isLoading: query.isLoading };
}
