/**
 * MeshCore Analyzer Observer — per-broker status polling (#5014 Phase 2 WP3).
 *
 * Thin TanStack Query wrapper around `ApiService.getObserverStatus`, mirroring
 * `useSourceStatuses` (src/hooks/useDashboardData.ts): same poll cadence
 * (`DASHBOARD_POLL_INTERVAL`, 15s) and the same `retry: false` so a broken
 * source does not retry-storm the server. Consumed by
 * `MeshCoreObserverBrokerPanel`, which is only mounted on the MeshCore
 * Configuration view — so this adds no new recurring request beyond what
 * that view already costs while open (spec §5.2).
 */
import { useQuery } from '@tanstack/react-query';
import api, { type ObserverStatusResponse } from '../../../services/api';
import { DASHBOARD_POLL_INTERVAL } from '../../../hooks/useDashboardData';

export interface UseObserverStatusResult {
  status: ObserverStatusResponse | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useObserverStatus(
  sourceId: string,
  opts?: { enabled?: boolean },
): UseObserverStatusResult {
  const enabled = opts?.enabled ?? true;

  const query = useQuery({
    queryKey: ['observer', 'status', sourceId],
    queryFn: () => api.getObserverStatus(sourceId),
    refetchInterval: DASHBOARD_POLL_INTERVAL,
    enabled,
    retry: false,
  });

  return {
    status: query.data ?? null,
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error : query.error ? new Error(String(query.error)) : null,
    refetch: () => {
      void query.refetch();
    },
  };
}
