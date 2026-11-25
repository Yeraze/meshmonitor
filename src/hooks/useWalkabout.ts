/**
 * TanStack hooks for Walkabout sessions (#5891 P1, spec §2.9).
 * No polling anywhere: the sample response carries the counts (§2.8).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import {
  deleteWalkabout,
  fetchLiveWalkabout,
  fetchWalkaboutSessions,
  startWalkabout,
  stopWalkabout,
} from '../services/walkaboutApi.js';

export const walkaboutKeys = {
  sessions: (sourceId: string) => ['walkabout', sourceId, 'sessions'] as const,
  live: (sourceId: string) => ['walkabout', sourceId, 'live'] as const,
};

export interface WalkaboutSourceRow {
  id: string;
  name: string;
  type?: string;
  enabled?: boolean;
}

/** Source list, fetched once (the dashboard hook polls; this card must not). */
export function useWalkaboutSources() {
  return useQuery<WalkaboutSourceRow[]>({
    queryKey: ['walkabout', 'sources'],
    queryFn: async () => {
      const rows = await api.get<WalkaboutSourceRow[]>('/api/sources');
      return Array.isArray(rows) ? rows : [];
    },
    staleTime: 60_000,
  });
}

export function useWalkaboutSessions(sourceId: string | null) {
  return useQuery({
    queryKey: walkaboutKeys.sessions(sourceId ?? ''),
    queryFn: () => fetchWalkaboutSessions(sourceId as string),
    enabled: !!sourceId,
  });
}

/** Once on mount (and when the source changes); no interval. */
export function useLiveWalkabout(sourceId: string | null) {
  return useQuery({
    queryKey: walkaboutKeys.live(sourceId ?? ''),
    queryFn: () => fetchLiveWalkabout(sourceId as string),
    enabled: !!sourceId,
    refetchOnWindowFocus: false,
    refetchInterval: false,
    staleTime: Infinity,
  });
}

function useInvalidate(sourceId: string) {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: walkaboutKeys.sessions(sourceId) }),
    qc.invalidateQueries({ queryKey: walkaboutKeys.live(sourceId) }),
  ]);
}

export function useStartWalkabout(sourceId: string) {
  const invalidate = useInvalidate(sourceId);
  return useMutation({
    mutationFn: (name?: string) => startWalkabout(sourceId, name),
    onSuccess: invalidate,
  });
}

export function useStopWalkabout(sourceId: string) {
  const invalidate = useInvalidate(sourceId);
  return useMutation({
    mutationFn: (sessionId: string) => stopWalkabout(sourceId, sessionId),
    onSuccess: invalidate,
  });
}

export function useDeleteWalkabout(sourceId: string) {
  const invalidate = useInvalidate(sourceId);
  return useMutation({
    mutationFn: (sessionId: string) => deleteWalkabout(sourceId, sessionId),
    onSuccess: invalidate,
  });
}
