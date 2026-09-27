/**
 * ADS-B flight match hooks (#5374).
 *
 * `useAdsbMatchEnabled` reads the non-secret global `adsbMatchEnabled` flag
 * from `GET /api/settings` (a bare settings map, readable anonymously), the
 * same way `useElevationEnabled` does.
 *
 * `useFlightMatch` fetches one node's match lazily — only while the popup or
 * details panel showing a likely aircraft is mounted, and only when matching
 * is on. It reads stored data only; the server does the feed lookups.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import apiService from '../services/api';
import type { FlightMatch } from '../types/flightMatch';

export const FLIGHT_MATCH_STALE_MS = 60_000;

export function useAdsbMatchEnabled(): boolean {
  const { data } = useQuery({
    queryKey: ['settings', 'adsbMatchEnabled'],
    queryFn: () => apiService.get<{ adsbMatchEnabled?: string }>('/api/settings'),
    staleTime: 5 * 60_000,
  });
  return data?.adsbMatchEnabled === 'true';
}

export function flightMatchQueryKey(sourceId: string | null | undefined, nodeNum: number | null | undefined) {
  return ['flightMatch', sourceId ?? null, nodeNum ?? null] as const;
}

export interface UseFlightMatchArgs {
  sourceId: string | null | undefined;
  nodeNum: number | null | undefined;
  /** The node is flagged likely-aircraft. */
  likelyAircraft: boolean;
}

export function useFlightMatch({ sourceId, nodeNum, likelyAircraft }: UseFlightMatchArgs): UseQueryResult<FlightMatch | null> {
  const matchingOn = useAdsbMatchEnabled();
  const enabled = matchingOn && likelyAircraft && !!sourceId && nodeNum != null && Number.isFinite(nodeNum);
  return useQuery({
    queryKey: flightMatchQueryKey(sourceId, nodeNum),
    queryFn: () => apiService.getFlightMatch(sourceId as string, nodeNum as number),
    enabled,
    staleTime: FLIGHT_MATCH_STALE_MS,
    retry: false,
  });
}
