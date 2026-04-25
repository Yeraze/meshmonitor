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
  /** Total nodes heard by this source — populated by GET /api/sources/:id/status. */
  nodeCount?: number;
  [key: string]: unknown;
}

/** Default poll interval for dashboard data (15 seconds) */
export const DASHBOARD_POLL_INTERVAL = 15_000;

/**
 * Sentinel ID for the synthetic "Unified" source that aggregates nodes/links
 * across every configured source. Not a real DB row — recognized by the
 * sidebar and DashboardPage to switch into aggregated rendering.
 */
export const UNIFIED_SOURCE_ID = '__unified__';

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

/**
 * Merge a set of records describing the same node (heard by multiple sources)
 * into a single composite. Whole-record "newest wins" loses information when
 * the most-recently-heard packet lacks fields that older packets had — a
 * source that just heard a routing packet (no position/user info) would
 * eclipse another source's older but data-rich record. Instead:
 *
 * - Every scalar field is taken from the newest record that has a non-null
 *   value for that field — so position survives even when the freshest
 *   record didn't carry one.
 * - `lastHeard` = max across sources.
 * - `isFavorite` = OR across sources (favorited anywhere ⇒ favorited).
 * - `isIgnored` = AND across sources (ignored only if every source has it
 *   ignored). This matches Unified's "union of visible nodes" semantics:
 *   if you can see this node on any individual source, you see it here.
 * - `position` is special-cased to require BOTH lat and lng to be non-null
 *   on the same source record — otherwise we'd splice a stale lat onto a
 *   fresh lng and end up at (0, 0) or worse.
 */
function mergeNodeRecords(records: any[]): any {
  const sortedNewestFirst = [...records].sort(
    (a, b) => (b.lastHeard ?? -1) - (a.lastHeard ?? -1),
  );

  const merged: any = {};
  for (const r of sortedNewestFirst) {
    for (const [k, v] of Object.entries(r)) {
      if (k === 'position' || k === 'isFavorite' || k === 'isIgnored' || k === 'lastHeard') continue;
      if ((merged[k] === undefined || merged[k] === null) && v !== undefined && v !== null) {
        merged[k] = v;
      }
    }
  }

  // Position: take the newest record that has both lat and lng (don't mix
  // halves from different sources).
  const withPosition = sortedNewestFirst.find(
    (r) => r?.position?.latitude != null && r?.position?.longitude != null,
  );
  if (withPosition) merged.position = withPosition.position;

  merged.lastHeard = sortedNewestFirst.reduce(
    (acc: number | null, r) => {
      const v = r.lastHeard;
      if (typeof v !== 'number') return acc;
      return acc == null || v > acc ? v : acc;
    },
    null,
  );
  merged.isFavorite = sortedNewestFirst.some((r) => r.isFavorite === true);
  merged.isIgnored = sortedNewestFirst.length > 0 && sortedNewestFirst.every((r) => r.isIgnored === true);

  return merged;
}

/**
 * Merge the same record type fetched from N sources into a single array.
 *
 * - **Nodes**: grouped by nodeNum, then field-level merged via
 *   `mergeNodeRecords` so position/user/role survive across sources.
 * - **NeighborInfo / Traceroutes**: simply concatenated; each row is a
 *   per-source observation and the map renders one polyline per row.
 * - **Channels**: taken from the first source that returned any. The
 *   dashboard map doesn't render channel data; we just need a non-empty
 *   array so other consumers don't break.
 */
export function mergeUnifiedSourceData(
  perSource: Array<{ nodes: unknown[]; traceroutes: unknown[]; neighborInfo: unknown[]; channels: unknown[] }>,
): { nodes: unknown[]; traceroutes: unknown[]; neighborInfo: unknown[]; channels: unknown[] } {
  const recordsByNum = new Map<number, any[]>();
  const traceroutes: unknown[] = [];
  const neighborInfo: unknown[] = [];
  let channels: unknown[] = [];

  for (const ps of perSource) {
    for (const n of ps.nodes as any[]) {
      if (n == null || typeof n.nodeNum !== 'number') continue;
      const bucket = recordsByNum.get(n.nodeNum);
      if (bucket) bucket.push(n);
      else recordsByNum.set(n.nodeNum, [n]);
    }
    traceroutes.push(...ps.traceroutes);
    neighborInfo.push(...ps.neighborInfo);
    if (channels.length === 0 && ps.channels.length > 0) {
      channels = ps.channels;
    }
  }

  const nodes = Array.from(recordsByNum.values()).map(mergeNodeRecords);

  return {
    nodes,
    traceroutes,
    neighborInfo,
    channels,
  };
}

/**
 * Hook that fetches the same per-source data as useDashboardSourceData but
 * for *every* source in parallel, then merges into a single dataset for the
 * synthetic "Unified" view. Disabled (returns empty) when `enabled` is false
 * so we don't fan out N HTTP requests when the user isn't on the unified
 * tab.
 */
export function useDashboardUnifiedData(
  sourceIds: string[],
  enabled: boolean,
): DashboardSourceData {
  const { authStatus } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;

  const queries = useQueries({
    queries: sourceIds.flatMap((id) => [
      {
        queryKey: ['dashboard', 'nodes', id, isAuthenticated],
        queryFn: () => fetchJson<unknown[]>(`${appBasename}/api/sources/${id}/nodes`),
        enabled,
        retry: false,
        refetchInterval: DASHBOARD_POLL_INTERVAL,
      },
      {
        queryKey: ['dashboard', 'traceroutes', id, isAuthenticated],
        queryFn: () => fetchJson<unknown[]>(`${appBasename}/api/sources/${id}/traceroutes`),
        enabled,
        retry: false,
        refetchInterval: DASHBOARD_POLL_INTERVAL,
      },
      {
        queryKey: ['dashboard', 'neighborInfo', id, isAuthenticated],
        queryFn: () => fetchJson<unknown[]>(`${appBasename}/api/sources/${id}/neighbor-info`),
        enabled,
        retry: false,
        refetchInterval: DASHBOARD_POLL_INTERVAL,
      },
      {
        queryKey: ['dashboard', 'channels', id, isAuthenticated],
        queryFn: () => fetchJson<unknown[]>(`${appBasename}/api/sources/${id}/channels`),
        enabled,
        retry: false,
        refetchInterval: DASHBOARD_POLL_INTERVAL,
      },
    ]),
  });

  if (!enabled || sourceIds.length === 0) {
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

  const isLoading = queries.some((q) => q.isLoading);
  const isError = queries.every((q) => q.isError);

  // Group every 4 sequential queries back into one source's bundle, mirroring
  // the order we registered them in (nodes, traceroutes, neighborInfo, channels).
  const perSource = sourceIds.map((_, i) => ({
    nodes: (queries[i * 4 + 0]?.data as unknown[] | undefined) ?? [],
    traceroutes: (queries[i * 4 + 1]?.data as unknown[] | undefined) ?? [],
    neighborInfo: (queries[i * 4 + 2]?.data as unknown[] | undefined) ?? [],
    channels: (queries[i * 4 + 3]?.data as unknown[] | undefined) ?? [],
  }));

  const merged = mergeUnifiedSourceData(perSource);

  return {
    ...merged,
    status: null,
    isLoading,
    isError,
  };
}
