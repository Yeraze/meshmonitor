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
  walkaboutMapParams,
} from '../services/walkaboutApi.js';
import type { WalkaboutH3Res, WalkaboutMapQuery } from '../types/walkabout.js';

export const walkaboutKeys = {
  sessions: (sourceId: string) => ['walkabout', sourceId, 'sessions'] as const,
  live: (sourceId: string) => ['walkabout', sourceId, 'live'] as const,
  cells: (sourceId: string, q: WalkaboutMapQuery, res: WalkaboutH3Res) =>
    ['walkabout', sourceId, 'cells', walkaboutMapParams(q), res] as const,
  cellNodes: (sourceId: string, q: WalkaboutMapQuery, cell: string) =>
    ['walkabout', sourceId, 'cell-nodes', walkaboutMapParams(q), cell] as const,
  track: (sourceId: string, sessionId: string) => ['walkabout', sourceId, 'track', sessionId] as const,
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

export function useDeleteWalkabout(sourceId: string) {
  const invalidate = useInvalidate(sourceId);
  return useMutation({
    mutationFn: (sessionId: string) => deleteWalkabout(sourceId, sessionId),
    onSuccess: invalidate,
  });
}

// --- Phase 2: map (WALKABOUT_P2_SPEC.md §2.9). Skeletons; WP2 fills the bodies. ---

export function useWalkaboutCells(_sourceId: string | null, _q: WalkaboutMapQuery | null, _res: WalkaboutH3Res): never {
  throw new Error('not implemented');
}

/** Enabled only while a popup is open (cell non-null). */
export function useWalkaboutCellNodes(_sourceId: string | null, _q: WalkaboutMapQuery | null, _cell: string | null): never {
  throw new Error('not implemented');
}

export function useWalkaboutTrack(_sourceId: string | null, _sessionId: string | null): never {
  throw new Error('not implemented');
}
