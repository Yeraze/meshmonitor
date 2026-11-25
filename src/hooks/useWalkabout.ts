/**
 * TanStack hooks for Walkabout sessions (#5891 P1, spec §2.9).
 * No polling anywhere: the sample response carries the counts (§2.8).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import {
  deleteWalkabout,
  fetchLiveWalkabout,
  fetchWalkaboutCellNodes,
  fetchWalkaboutCells,
  fetchWalkaboutSessions,
  fetchWalkaboutTrack,
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

// --- Phase 2: map (WALKABOUT_P2_SPEC.md §2.9) ---


const MAP_QUERY_OPTS = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export function useWalkaboutCells(sourceId: string | null, q: WalkaboutMapQuery | null, res: WalkaboutH3Res) {
  return useQuery({
    queryKey: q && sourceId
      ? walkaboutKeys.cells(sourceId, q, res)
      : ['walkabout', sourceId ?? '', 'cells', null, res],
    queryFn: () => fetchWalkaboutCells(sourceId as string, q as WalkaboutMapQuery, res),
    enabled: !!sourceId && !!q,
    // Keep the previous hexes only when just `res` changed.
    placeholderData: (prev, prevQuery) => {
      const prevKey = prevQuery?.queryKey as readonly unknown[] | undefined;
      if (!prev || !prevKey || !q || !sourceId) return undefined;
      const cur = walkaboutKeys.cells(sourceId, q, res);
      return prevKey[1] === cur[1] && JSON.stringify(prevKey[3]) === JSON.stringify(cur[3]) ? prev : undefined;
    },
    ...MAP_QUERY_OPTS,
  });
}

/** Enabled only while a popup is open (cell non-null). */
export function useWalkaboutCellNodes(sourceId: string | null, q: WalkaboutMapQuery | null, cell: string | null) {
  return useQuery({
    queryKey: q && sourceId && cell
      ? walkaboutKeys.cellNodes(sourceId, q, cell)
      : ['walkabout', sourceId ?? '', 'cell-nodes', null, cell],
    queryFn: () => fetchWalkaboutCellNodes(sourceId as string, q as WalkaboutMapQuery, cell as string),
    enabled: !!sourceId && !!q && !!cell,
    ...MAP_QUERY_OPTS,
  });
}

export function useWalkaboutTrack(sourceId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: walkaboutKeys.track(sourceId ?? '', sessionId ?? ''),
    queryFn: () => fetchWalkaboutTrack(sourceId as string, sessionId as string),
    enabled: !!sourceId && !!sessionId,
    ...MAP_QUERY_OPTS,
  });
}
