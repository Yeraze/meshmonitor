/**
 * Hooks for fetching dashboard data using TanStack Query
 *
 * Provides source lists, per-source statuses, and per-source node/traceroute/neighbor data
 * with automatic polling every 15 seconds.
 */

import { useQuery, useQueries } from '@tanstack/react-query';
import { appBasename } from '../init';
import { useAuth } from '../contexts/AuthContext';

/**
 * A data source configured in MeshMonitor
 */
export interface DashboardSource {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Connection/status information for a source
 */
export interface SourceStatus {
  sourceId: string;
  sourceName?: string;
  sourceType?: string;
  connected: boolean;
  [key: string]: unknown;
}

/** Default poll interval for dashboard data (15 seconds) */
export const DASHBOARD_POLL_INTERVAL = 15_000;

/**
 * Fetch helper that throws on non-ok so TanStack Query marks it as an error
 * and retries on the next poll interval (important for post-login refetch).
 */
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Hook to fetch the list of all configured sources
 *
 * @returns TanStack Query result with DashboardSource[]
 */
export function useDashboardSources() {
  return useQuery<DashboardSource[]>({
    queryKey: ['dashboard', 'sources'],
    queryFn: async () => {
      const res = await fetch(`${appBasename}/api/sources`, { credentials: 'include' });
      if (!res.ok) {
        throw new Error(`Failed to fetch sources: ${res.status}`);
      }
      return res.json();
    },
    refetchInterval: DASHBOARD_POLL_INTERVAL,
  });
}

/**
 * Hook to fetch status for multiple sources in parallel
 *
 * @param sourceIds - Array of source IDs to fetch status for
 * @returns Map from source ID to SourceStatus (or null on error)
 */
export function useSourceStatuses(sourceIds: string[]): Map<string, SourceStatus | null> {
  const { authStatus } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;
  const results = useQueries({
    queries: sourceIds.map((id) => ({
      queryKey: ['dashboard', 'status', id, isAuthenticated],
      queryFn: () => fetchJson<SourceStatus>(`${appBasename}/api/sources/${id}/status`),
      refetchInterval: DASHBOARD_POLL_INTERVAL,
      retry: false,
    })),
  });

  const map = new Map<string, SourceStatus | null>();
  sourceIds.forEach((id, index) => {
    map.set(id, results[index]?.data ?? null);
  });
  return map;
}

/**
 * Return type for useDashboardSourceData
 */
export interface DashboardSourceData {
  nodes: unknown[];
  traceroutes: unknown[];
  neighborInfo: unknown[];
  channels: unknown[];
  status: SourceStatus | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Hook to fetch all data for a selected source
 *
 * Fetches nodes, traceroutes, neighbor-info, status, and channels in parallel.
 * When sourceId is null all queries are disabled and empty defaults are returned.
 *
 * @param sourceId - The selected source ID, or null for no selection
 * @returns Combined data object with loading/error state
 */
export function useDashboardSourceData(sourceId: string | null): DashboardSourceData {
  const { authStatus } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;
  const enabled = sourceId !== null;

  const nodesQuery = useQuery({
    queryKey: ['dashboard', 'nodes', sourceId, isAuthenticated],
    queryFn: () => fetchJson<unknown[]>(`${appBasename}/api/sources/${sourceId}/nodes`),
    enabled,
    retry: false,
    refetchInterval: DASHBOARD_POLL_INTERVAL,
  });

  const traceroutesQuery = useQuery({
    queryKey: ['dashboard', 'traceroutes', sourceId, isAuthenticated],
    queryFn: () => fetchJson<unknown[]>(`${appBasename}/api/sources/${sourceId}/traceroutes`),
    enabled,
    retry: false,
    refetchInterval: DASHBOARD_POLL_INTERVAL,
  });

  const neighborInfoQuery = useQuery({
    queryKey: ['dashboard', 'neighborInfo', sourceId, isAuthenticated],
    queryFn: () => fetchJson<unknown[]>(`${appBasename}/api/sources/${sourceId}/neighbor-info`),
    enabled,
    retry: false,
    refetchInterval: DASHBOARD_POLL_INTERVAL,
  });

  const statusQuery = useQuery({
    queryKey: ['dashboard', 'status', sourceId, isAuthenticated],
    queryFn: () => fetchJson<SourceStatus>(`${appBasename}/api/sources/${sourceId}/status`),
    enabled,
    retry: false,
    refetchInterval: DASHBOARD_POLL_INTERVAL,
  });

  const channelsQuery = useQuery({
    queryKey: ['dashboard', 'channels', sourceId, isAuthenticated],
    queryFn: () => fetchJson<unknown[]>(`${appBasename}/api/sources/${sourceId}/channels`),
    enabled,
    retry: false,
    refetchInterval: DASHBOARD_POLL_INTERVAL,
  });

  if (!enabled) {
    return {
      nodes: [],
      traceroutes: [],
      neighborInfo: [],
      channels: [],
      status: null,
      isLoading: false,
      isError: false,
    };
  }

  const isLoading =
    nodesQuery.isLoading ||
    traceroutesQuery.isLoading ||
    neighborInfoQuery.isLoading ||
    statusQuery.isLoading ||
    channelsQuery.isLoading;

  const isError =
    nodesQuery.isError ||
    traceroutesQuery.isError ||
    neighborInfoQuery.isError ||
    statusQuery.isError ||
    channelsQuery.isError;

  return {
    nodes: nodesQuery.data ?? [],
    traceroutes: traceroutesQuery.data ?? [],
    neighborInfo: neighborInfoQuery.data ?? [],
    channels: channelsQuery.data ?? [],
    status: statusQuery.data ?? null,
    isLoading,
    isError,
  };
}
