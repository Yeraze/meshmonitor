/**
 * useTraceroutePairHistory (Statistical Route epic, phase 2) — every stored
 * traceroute between two nodes, either direction, on one source. Feeds the
 * statistical aggregate in the Node Details traceroute box.
 *
 * Mirrors `useNodeTraceroutes`: one-shot query (not the poll cache),
 * `useResolvedSourceId` rather than `useSource` (MessagesTab can mount outside a
 * SourceProvider), and `enabled` deferring the request until the source resolves.
 *
 * Callers gate this further — see SR_PHASE2_SPEC.md D14/S1. The hook itself never
 * decides whether an aggregate is worth fetching.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import apiService, { type TracerouteHistoryEntry } from '../services/api';
import type { AggregateTracerouteRow } from '../utils/tracerouteAggregate';
import { useResolvedSourceId } from './useResolvedSourceId';

/** SR_PHASE2_SPEC.md D17. Server default is 50, cap 1000. */
export const PAIR_HISTORY_LIMIT = 200;

/**
 * Coerce the four scalars the aggregate compares numerically. `normalizeBigInts`
 * already does this server-side for PG/MySQL BIGINT columns, so this is insurance,
 * not a fix: aggregation compares `row.fromNodeNum === localNodeNum`, and a string
 * would silently drop every row instead of failing loudly.
 */
export function toAggregateRows(rows: TracerouteHistoryEntry[]): AggregateTracerouteRow[] {
  return rows.map((row) => ({
    id: Number(row.id),
    fromNodeNum: Number(row.fromNodeNum),
    toNodeNum: Number(row.toNodeNum),
    route: row.route ?? null,
    routeBack: row.routeBack ?? null,
    snrBack: row.snrBack ?? null,
    timestamp: Number(row.timestamp),
  }));
}

export function useTraceroutePairHistory(
  fromNodeNum: number | null,
  toNodeNum: number | null,
  opts: { enabled?: boolean; limit?: number } = {},
) {
  const sourceId = useResolvedSourceId();
  const limit = opts.limit ?? PAIR_HISTORY_LIMIT;

  const query = useQuery<TracerouteHistoryEntry[]>({
    queryKey: ['traceroutePairHistory', sourceId, fromNodeNum, toNodeNum, limit],
    queryFn: () => apiService.getTracerouteHistory(fromNodeNum!, toNodeNum!, limit, sourceId),
    enabled:
      (opts.enabled ?? true) &&
      fromNodeNum != null &&
      toNodeNum != null &&
      fromNodeNum !== toNodeNum &&
      !!sourceId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const rows = useMemo(
    () => (query.data ? toAggregateRows(query.data) : undefined),
    [query.data],
  );

  return { ...query, rows };
}
