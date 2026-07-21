/**
 * Hooks for fetching dashboard data using TanStack Query
 *
 * Provides source lists, per-source statuses, and per-source node/traceroute/neighbor data
 * with automatic polling every 15 seconds.
 */

import { useQuery, useQueries } from '@tanstack/react-query';
import { appBasename } from '../init';
import { useAuth } from '../contexts/AuthContext';
import { isBogusPosition, shouldDiscardPosition } from '../utils/nullIsland';
import { getDiscardInvalidPositions } from '../utils/positionDisplayConfig';
import { getNodeTransportClasses, type NodeTransportClass } from '../utils/nodeTransport';
import { unifiedNodeKey } from '../utils/nodeIdentity';
import type { SourceRadioSummary } from '../types/elevation';

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
  /**
   * Public, non-secret per-source radio summary (#4111 P3 WP-1) — center
   * frequency / region, used by the Link Profile tool's per-source
   * auto-frequency detection. `null` for sources with no local radio (MQTT)
   * or when the manager isn't reachable; absent on older cached responses.
   */
  radio?: SourceRadioSummary | null;
}

/**
 * Connection/status information for a source
 */
export interface SourceStatus {
  sourceId: string;
  sourceName?: string;
  sourceType?: string;
  connected: boolean;
  /**
   * The source's own (local) node number, surfaced by the manager's
   * `getStatus()`. Used to center the polar grid overlay on the local node
   * across the multi-source Map Analysis / Unified maps (#3971). Absent for
   * MeshCore sources (no meshtastic nodeNum) and while disconnected.
   */
  nodeNum?: number;
  /** Total nodes heard by this source — populated by GET /api/sources/:id/status. */
  nodeCount?: number;
  /**
   * Nodes heard by this source within the last ~2h. Powers the sidebar's
   * mesh-activity badge alongside the link-state badge (issue #2883).
   */
  activeNodeCount?: number;
  [key: string]: unknown;
}

/**
 * One source's bundled dashboard datasets, as returned by the aggregate
 * endpoints GET /api/sources/:id/dashboard and GET /api/unified/dashboard.
 * Bundling these four reads into one request (instead of one GET each, per
 * source, per 15s poll) is what keeps source-heavy dashboards from exhausting
 * the API rate limiter / hammering low-powered servers (#3735).
 */
export interface SourceDashboardBundle {
  sourceId: string;
  nodes: unknown[];
  traceroutes: unknown[];
  neighborInfo: unknown[];
  channels: unknown[];
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
 * Aggregate status returned by GET /api/unified/status — a deduped count of
 * nodes across every readable source plus a flag indicating whether at least
 * one source is currently connected.
 */
export interface UnifiedStatus {
  /** Distinct nodeNum count across every source the user can read. */
  nodeCount: number;
  /**
   * Distinct count of nodes heard within the last ~2h across every readable
   * source. Mirrors the per-source `activeNodeCount` (issue #2883).
   */
  activeNodeCount?: number;
  /** True when any readable source is currently connected. */
  connected: boolean;
}

/**
 * Hook for the deduped Unified node count.
 *
 * The dashboard sidebar uses this so the Unified card displays a stable,
 * accurate count regardless of which individual source is selected. It
 * polls on the same cadence as the per-source status calls.
 */
export function useUnifiedStatus(): UnifiedStatus | null {
  const { authStatus } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;
  const result = useQuery<UnifiedStatus>({
    queryKey: ['dashboard', 'unified-status', isAuthenticated],
    queryFn: () => fetchJson<UnifiedStatus>(`${appBasename}/api/unified/status`),
    refetchInterval: DASHBOARD_POLL_INTERVAL,
    retry: false,
  });
  return result.data ?? null;
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

  // One bundled request for nodes+traceroutes+neighborInfo+channels instead of
  // four separate GETs per poll (#3735). Status stays its own lightweight query
  // (cheap COUNT(*)s) and is also polled per-source by the sidebar.
  const dashboardQuery = useQuery({
    queryKey: ['dashboard', 'source-dashboard', sourceId, isAuthenticated],
    queryFn: () => fetchJson<SourceDashboardBundle>(`${appBasename}/api/sources/${sourceId}/dashboard`),
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

  const isLoading = dashboardQuery.isLoading || statusQuery.isLoading;
  const isError = dashboardQuery.isError || statusQuery.isError;

  return {
    nodes: dashboardQuery.data?.nodes ?? [],
    traceroutes: dashboardQuery.data?.traceroutes ?? [],
    neighborInfo: dashboardQuery.data?.neighborInfo ?? [],
    channels: dashboardQuery.data?.channels ?? [],
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
      // Position fields are selected together below so a stale/garbage reading
      // from one source can't splice onto another's — and so a Null-Island
      // reading never wins just for being newest.
      if (
        k === 'position' ||
        k === 'latitude' ||
        k === 'longitude' ||
        k === 'positionPrecisionBits' ||
        k === 'isFavorite' ||
        k === 'isIgnored' ||
        k === 'lastHeard'
      ) {
        continue;
      }
      if ((merged[k] === undefined || merged[k] === null) && v !== undefined && v !== null) {
        merged[k] = v;
      }
    }
  }

  // Position: take the newest record with a REAL fix — both lat and lng present
  // on the same record and NOT at Null Island (#3763; e.g. Jupiter Dad !02ecd5e0
  // reporting the 2^15 garbage default 0.0032768 from an MQTT source while other
  // sources have the true position). Flat (API) and nested position shapes are
  // both supported; lat/lng/nested-position/precision are carried from the SAME
  // record so the marker and its accuracy cell stay consistent.
  const withPosition =
    sortedNewestFirst.find((r) => {
      const lat = r?.latitude ?? r?.position?.latitude;
      const lng = r?.longitude ?? r?.position?.longitude;
      return lat != null && lng != null && !isBogusPosition(lat, lng);
    }) ??
    // #4157: with the "Discard invalid positions" toggle OFF, a real fix above
    // still wins, but fall back to a Null-Island (0,0) fix when that's ALL any
    // source reported — so a node that only ever reports (0,0) is visible on the
    // map instead of positionless. Out-of-range / NaN junk is still rejected.
    (getDiscardInvalidPositions()
      ? undefined
      : sortedNewestFirst.find((r) => {
          const lat = r?.latitude ?? r?.position?.latitude;
          const lng = r?.longitude ?? r?.position?.longitude;
          return lat != null && lng != null && !shouldDiscardPosition(lat, lng, undefined, false);
        }));
  if (withPosition) {
    if (withPosition.latitude != null) merged.latitude = withPosition.latitude;
    if (withPosition.longitude != null) merged.longitude = withPosition.longitude;
    if (withPosition.position != null) merged.position = withPosition.position;
    if (withPosition.positionPrecisionBits != null) {
      merged.positionPrecisionBits = withPosition.positionPrecisionBits;
    }
  }

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
 * Describes one source that reported a node, attached to each merged Unified
 * node so the map popup can list "seen by source X over protocol Y".
 */
export interface NodeSourceRef {
  sourceId: string;
  sourceName: string;
  protocol: 'Meshtastic' | 'MeshCore';
}

/**
 * One source's data bundle plus its identifying metadata. The metadata is
 * optional so legacy callers (and tests) that only pass data still work — when
 * absent, merged nodes simply carry no `sources` array.
 */
export interface UnifiedSourceBundle {
  sourceId?: string;
  sourceName?: string;
  protocol?: 'Meshtastic' | 'MeshCore';
  nodes: unknown[];
  traceroutes: unknown[];
  neighborInfo: unknown[];
  channels: unknown[];
}

/**
 * Merge the same record type fetched from N sources into a single array.
 *
 * - **Nodes**: grouped by nodeNum, then field-level merged via
 *   `mergeNodeRecords` so position/user/role survive across sources. Each
 *   merged node also gets a `sources` array (deduped by sourceId) naming every
 *   source that reported it and its protocol — consumed by the map popup on
 *   the Unified view.
 * - **NeighborInfo / Traceroutes**: simply concatenated; each row is a
 *   per-source observation and the map renders one polyline per row.
 * - **Channels**: taken from the first source that returned any. The
 *   dashboard map doesn't render channel data; we just need a non-empty
 *   array so other consumers don't break.
 */
export function mergeUnifiedSourceData(
  perSource: UnifiedSourceBundle[],
): { nodes: unknown[]; traceroutes: unknown[]; neighborInfo: unknown[]; channels: unknown[] } {
  // Keys are stringified and namespaced (`mt:`/`mc:`) so MeshCore contacts
  // (which carry no meshtastic nodeNum) don't collapse into the nodeNum=0
  // bucket. MeshCore nodes key on publicKey so the same physical node merges
  // across sources (see keying block below). Each bucket entry pairs the raw
  // node record with the source it came from so we can rebuild `sources` after
  // the field-level merge collapses the records.
  const recordsByKey = new Map<string, Array<{ node: any; source: NodeSourceRef | null }>>();
  const traceroutes: unknown[] = [];
  const neighborInfo: unknown[] = [];
  // Tracks canonical (min,max) nodeNum pairs already added to neighborInfo so the
  // same physical link reported by multiple sources renders as a single line.
  const seenNeighborPairs = new Set<string>();
  let channels: unknown[] = [];

  for (const ps of perSource) {
    const source: NodeSourceRef | null = ps.sourceId
      ? {
          sourceId: ps.sourceId,
          sourceName: ps.sourceName ?? ps.sourceId,
          protocol: ps.protocol ?? 'Meshtastic',
        }
      : null;
    for (const n of ps.nodes as any[]) {
      if (n == null) continue;
      // A MeshCore contact's identity is its public key — stable across
      // sources. The server-built `nodeId` embeds the reporting source
      // (`mc:<sourceId>:<pubkeyPrefix>`), so keying on it would put the same
      // physical node into a separate bucket per source and it would always
      // show as "seen by 1 source". Key on publicKey so the same node merges
      // across MeshCore sources; fall back to nodeId only when no key exists.
      // `unifiedNodeKey` is the single source of truth for this bucketing —
      // it must stay in sync with the node-selection feature (#3788), which
      // keys markers/trails identically.
      const key = unifiedNodeKey(n);
      if (key == null) continue;
      const entry = { node: n, source };
      const bucket = recordsByKey.get(key);
      if (bucket) bucket.push(entry);
      else recordsByKey.set(key, [entry]);
    }
    traceroutes.push(...ps.traceroutes);
    for (const link of ps.neighborInfo as any[]) {
      if (link == null) continue;
      // Deduplicate across sources: the same physical pair (A,B) reported by
      // multiple sources should render as a single line. Server-side
      // buildSourceNeighborInfo already collapses bidirectional A↔B pairs within
      // one source; here we also collapse the same pair appearing in a second
      // source's neighborInfo bundle.
      const numA = Number(link.nodeNum ?? 0);
      const numB = Number(link.neighborNodeNum ?? 0);
      if (numA !== 0 || numB !== 0) {
        const pairKey = `${Math.min(numA, numB)}-${Math.max(numA, numB)}`;
        if (seenNeighborPairs.has(pairKey)) continue;
        seenNeighborPairs.add(pairKey);
      }
      neighborInfo.push(link);
    }
    if (channels.length === 0 && ps.channels.length > 0) {
      channels = ps.channels;
    }
  }

  const nodes = Array.from(recordsByKey.values()).map((entries) => {
    const merged = mergeNodeRecords(entries.map((e) => e.node));
    const seen = new Map<string, NodeSourceRef>();
    for (const e of entries) {
      if (e.source && !seen.has(e.source.sourceId)) seen.set(e.source.sourceId, e.source);
    }
    if (seen.size > 0) merged.sources = Array.from(seen.values());
    // Union of transport classes across every per-source record so the map's
    // RF/UDP/MQTT toggles are additive — a node heard via RF on one source and
    // MQTT on another stays visible under "Show RF" even with "Show MQTT" off.
    // The whole-record merge keeps only the newest transportMechanism, which
    // would otherwise drop the other transports.
    // #4240: merge the per-transport last-seen stamps by taking the MAX across
    // sources, rather than precomputing a class list here. Keeping timestamps
    // (not classes) is what lets the consumer apply the user's active window —
    // a precomputed list would freeze in whatever staleness state it was built
    // with, and Unified nodes would never decay.
    const maxStamp = (key: 'transportLastRf' | 'transportLastMqtt' | 'transportLastUdp') => {
      let best: number | null = null;
      for (const e of entries) {
        const v = (e.node as Record<string, unknown>)[key];
        if (typeof v === 'number' && (best === null || v > best)) best = v;
      }
      return best;
    };
    merged.transportLastRf = maxStamp('transportLastRf');
    merged.transportLastMqtt = maxStamp('transportLastMqtt');
    merged.transportLastUdp = maxStamp('transportLastUdp');

    // Legacy union, still consulted for records that carry no stamps at all
    // (pre-migration-126 rows).
    const classes = new Set<NodeTransportClass>();
    for (const e of entries) {
      for (const c of getNodeTransportClasses(e.node)) classes.add(c);
    }
    merged.transportClasses = Array.from(classes);
    return merged;
  });

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
  sources: Array<string | DashboardSource>,
  enabled: boolean,
): DashboardSourceData {
  const { authStatus } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;
  // Accept either bare source-id strings (MapAnalysis layers, which never use
  // the per-node `sources` field) or full DashboardSource objects (the Unified
  // dashboard map, which needs source names + protocol for the popup).
  const sourceList = sources.map((s) => (typeof s === 'string' ? { id: s } : s));
  const sourceIds = sourceList.map((s) => s.id);

  // ONE request for the whole unified view instead of four GETs per source per
  // poll (#3735). The endpoint returns a per-source bundle array; we re-key it
  // by sourceId and stamp the caller's name/protocol metadata back on so the
  // merge can attribute each node to its source.
  const sourcesKey = sourceIds.join(',');
  const query = useQuery({
    queryKey: ['dashboard', 'unified-dashboard', sourcesKey, isAuthenticated],
    queryFn: () =>
      fetchJson<SourceDashboardBundle[]>(
        `${appBasename}/api/unified/dashboard?sources=${encodeURIComponent(sourcesKey)}`,
      ),
    enabled: enabled && sourceIds.length > 0,
    retry: false,
    refetchInterval: DASHBOARD_POLL_INTERVAL,
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

  const bundlesById = new Map<string, SourceDashboardBundle>(
    (query.data ?? []).map((b: SourceDashboardBundle): [string, SourceDashboardBundle] => [b.sourceId, b]),
  );

  // Re-attach id/name/protocol so the merge can stamp `sources` onto every node
  // (MeshCore source types map to the MeshCore protocol; everything else is
  // Meshtastic). Bare-string callers carry no metadata, so merged nodes get no
  // `sources` field — matching the previous behavior.
  const perSource: UnifiedSourceBundle[] = sourceList.map((s) => {
    const b = bundlesById.get(s.id);
    return {
      sourceId: 'name' in s ? s.id : undefined,
      sourceName: 'name' in s ? s.name : undefined,
      protocol: 'type' in s ? (s.type === 'meshcore' ? 'MeshCore' : 'Meshtastic') : undefined,
      nodes: b?.nodes ?? [],
      traceroutes: b?.traceroutes ?? [],
      neighborInfo: b?.neighborInfo ?? [],
      channels: b?.channels ?? [],
    };
  });

  const merged = mergeUnifiedSourceData(perSource);

  return {
    ...merged,
    status: null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
