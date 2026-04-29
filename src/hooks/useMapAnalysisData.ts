import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchPositionsPage,
  fetchTraceroutesPage,
  fetchNeighbors,
  fetchCoverageGrid,
  fetchHopCounts,
} from '../services/analysisApi';

interface PaginatedHookArgs {
  enabled: boolean;
  sources: string[];
  lookbackHours: number;
}

export interface PaginatedHookResult<T> {
  items: T[];
  isLoading: boolean;
  isError: boolean;
  progress: { loaded: number; estimatedTotal: number | null; percent: number };
  error: Error | null;
}

const PAGE_SIZE = 500;

function lookbackToSinceMs(hours: number): number {
  return hours <= 0 ? 0 : Date.now() - hours * 3_600_000;
}

function useAggregatedPaginated<T>(
  key: readonly unknown[],
  fetchPage: (args: {
    sources: string[];
    sinceMs: number;
    pageSize: number;
    cursor: string | null;
  }) => Promise<{ items: T[]; hasMore: boolean; nextCursor: string | null }>,
  args: PaginatedHookArgs,
): PaginatedHookResult<T> {
  const [items, setItems] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const cancelRef = useRef<AbortController | null>(null);
  const sinceMs = useMemo(
    () => lookbackToSinceMs(args.lookbackHours),
    [args.lookbackHours],
  );
  const argsKey = useMemo(
    () => JSON.stringify([args.enabled, args.sources, args.lookbackHours, ...key]),
    [args.enabled, args.sources, args.lookbackHours, key],
  );

  useEffect(() => {
    if (!args.enabled || args.sources.length === 0) {
      setItems([]);
      setIsLoading(false);
      setError(null);
      return;
    }
    cancelRef.current?.abort();
    const ctrl = new AbortController();
    cancelRef.current = ctrl;

    setItems([]);
    setIsLoading(true);
    setError(null);
    let cursor: string | null = null;
    let acc: T[] = [];

    (async () => {
      try {
        do {
          const res = await fetchPage({
            sources: args.sources,
            sinceMs,
            pageSize: PAGE_SIZE,
            cursor,
          });
          if (ctrl.signal.aborted) return;
          acc = acc.concat(res.items);
          setItems([...acc]);
          cursor = res.hasMore ? res.nextCursor : null;
        } while (cursor && !ctrl.signal.aborted);
        if (!ctrl.signal.aborted) setIsLoading(false);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setError(e as Error);
        setIsLoading(false);
      }
    })();

    return () => ctrl.abort();
    // argsKey already encodes the inputs that matter; sinceMs is derived from
    // lookbackHours which is part of argsKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [argsKey]);

  const progress = useMemo(() => {
    if (!isLoading) {
      return { loaded: items.length, estimatedTotal: items.length, percent: 100 };
    }
    const estimatedTotal = items.length + PAGE_SIZE;
    return {
      loaded: items.length,
      estimatedTotal,
      percent: Math.min(99, Math.round((items.length / estimatedTotal) * 100)),
    };
  }, [items, isLoading]);

  return { items, isLoading, isError: error !== null, error, progress };
}

export function usePositions(args: PaginatedHookArgs) {
  return useAggregatedPaginated(['positions'], fetchPositionsPage, args);
}

export function useTraceroutes(args: PaginatedHookArgs) {
  return useAggregatedPaginated(['traceroutes'], fetchTraceroutesPage, args);
}

export function useNeighbors(args: PaginatedHookArgs) {
  return useQuery({
    queryKey: ['analysis', 'neighbors', args.sources, args.lookbackHours],
    enabled: args.enabled && args.sources.length > 0,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchNeighbors({
        sources: args.sources,
        sinceMs: lookbackToSinceMs(args.lookbackHours),
        signal,
      }),
  });
}

export function useCoverageGrid(args: PaginatedHookArgs & { zoom: number }) {
  return useQuery({
    queryKey: ['analysis', 'coverage', args.sources, args.lookbackHours, args.zoom],
    enabled: args.enabled && args.sources.length > 0,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchCoverageGrid({
        sources: args.sources,
        sinceMs: lookbackToSinceMs(args.lookbackHours),
        zoom: args.zoom,
        signal,
      }),
  });
}

export function useHopCounts(args: { enabled: boolean; sources: string[] }) {
  return useQuery({
    queryKey: ['analysis', 'hopCounts', args.sources],
    enabled: args.enabled && args.sources.length > 0,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchHopCounts({ sources: args.sources, signal }),
  });
}

/**
 * Aggregate progress across multiple paginated/loading hooks. Returns null
 * when nothing is currently loading, or the average percent (0-100) of all
 * hooks reporting `isLoading: true`. Hooks without a `progress` field are
 * treated as 0%.
 */
export function useAggregateProgress(
  states: Array<{ isLoading: boolean; progress?: { percent: number } }>,
): number | null {
  const loading = states.filter((s) => s.isLoading);
  if (loading.length === 0) return null;
  const sum = loading.reduce(
    (acc: number, s) => acc + (s.progress?.percent ?? 0),
    0,
  );
  return Math.round(sum / loading.length);
}
