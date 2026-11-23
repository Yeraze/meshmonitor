/**
 * Telemetry data fetching hooks using TanStack Query
 *
 * Provides hooks for fetching telemetry and solar irradiance data
 * with automatic caching, deduplication, and periodic refetching.
 * Replaces manual setInterval polling with TanStack Query's built-in
 * refetch capabilities.
 */

import { useQuery, useQueries, keepPreviousData } from '@tanstack/react-query';
import { useResolvedSourceId } from './useResolvedSourceId';

/**
 * Telemetry data point from the backend
 */
export interface TelemetryData {
  /** Unique identifier for this telemetry record */
  id?: number;
  /** Node ID in format !xxxxxxxx */
  nodeId: string;
  /** Numeric node identifier */
  nodeNum: number;
  /** Type of telemetry (e.g., 'batteryLevel', 'temperature', 'voltage') */
  telemetryType: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Telemetry value */
  value: number;
  /** Unit of measurement (optional) */
  unit?: string;
  /** Record creation timestamp */
  createdAt: number;
}

/**
 * One hourly Open-Meteo point from /api/solar/irradiance (#6523)
 */
interface SolarIrradiancePoint {
  /** Unix timestamp in seconds */
  timestamp: number;
  /** Shortwave radiation in W/m² */
  shortwaveRadiation: number | null;
  /** Cloud cover in % */
  cloudCover: number | null;
}

interface SolarIrradianceResponse {
  success?: boolean;
  data?: { enabled: boolean; points: SolarIrradiancePoint[] };
}

/**
 * Options for useTelemetry hook
 */
interface UseTelemetryOptions {
  /** Node ID to fetch telemetry for */
  nodeId: string;
  /** Number of hours of historical data to fetch (default: 24) */
  hours?: number;
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Source ID for multi-source deployments */
  sourceId?: string | null;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
}

/**
 * Hook to fetch telemetry data for a specific node
 *
 * Uses TanStack Query for:
 * - Automatic request deduplication (prevents duplicate in-flight requests)
 * - Caching with configurable stale time
 * - Automatic background refetching every 30 seconds
 * - Loading and error states
 *
 * @param options - Configuration options
 * @returns TanStack Query result with telemetry data
 *
 * @example
 * ```tsx
 * const { data, isLoading, error } = useTelemetry({
 *   nodeId: '!abcd1234',
 *   hours: 24
 * });
 * ```
 */
export function useTelemetry({ nodeId, hours = 24, baseUrl = '', sourceId, enabled = true }: UseTelemetryOptions) {
  // The endpoint now requires a sourceId; fall back to the primary source when
  // the caller didn't supply one (legacy/single-source views).
  const fallbackSourceId = useResolvedSourceId();
  const effectiveSourceId = sourceId ?? fallbackSourceId;
  return useQuery({
    queryKey: ['telemetry', nodeId, hours, effectiveSourceId],
    queryFn: async (): Promise<TelemetryData[]> => {
      const url = `${baseUrl}/api/telemetry/${nodeId}?hours=${hours}&sourceId=${encodeURIComponent(effectiveSourceId!)}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch telemetry: ${response.status} ${response.statusText}`);
      }

      return response.json();
    },
    // Defer until a sourceId is available (required by the endpoint).
    enabled: enabled && !!nodeId && !!effectiveSourceId,
    // Keep showing the prior result while a new window/node loads so the time
    // range selector and charts don't flash a loading state on every change.
    placeholderData: keepPreviousData,
    refetchInterval: 30000, // Refetch every 30 seconds
    staleTime: 25000, // Data considered fresh for 25 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Options for useSolarIrradiance hook
 */
interface UseSolarIrradianceOptions {
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Source the node belongs to (falls back to the primary source, like useTelemetry) */
  sourceId?: string | null;
  /** Node ID: `!hex` (Meshtastic) or 64-hex public key (MeshCore) */
  nodeId?: string | null;
  /** Start timestamp in Unix seconds */
  startTimestamp?: number;
  /** End timestamp in Unix seconds */
  endTimestamp?: number;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
}

/** Data changes at most hourly, so refetch rarely. */
const SOLAR_IRRADIANCE_REFRESH_MS = 15 * 60 * 1000;
/** The route serves at most 31 days per request. */
const SOLAR_IRRADIANCE_MAX_SPAN_S = 31 * 24 * 3600;

/**
 * Snap a window to whole hours (and to the route's 31-day cap) so a caller
 * whose bounds drift every few seconds keeps one stable query key.
 */
function hourAlignedWindow(start?: number, end?: number): { start?: number; end?: number } {
  if (!start || !end) return {};
  const alignedEnd = Math.ceil(end / 3600) * 3600;
  const alignedStart = Math.max(Math.floor(start / 3600) * 3600, alignedEnd - SOLAR_IRRADIANCE_MAX_SPAN_S);
  return { start: alignedStart, end: alignedEnd };
}

/**
 * Hook to fetch one node's hourly Open-Meteo sunlight curve (#6523).
 *
 * Returns Map<timestamp_ms, W/m²>; hours with no value are skipped. Returns
 * an empty Map when the feature is off, the node has no visible position, or
 * the request fails.
 */
export function useSolarIrradiance({
  baseUrl = '',
  sourceId,
  nodeId,
  startTimestamp,
  endTimestamp,
  enabled = true,
}: UseSolarIrradianceOptions) {
  const fallbackSourceId = useResolvedSourceId();
  const effectiveSourceId = sourceId ?? fallbackSourceId;
  const { start, end } = hourAlignedWindow(startTimestamp, endTimestamp);
  return useQuery({
    queryKey: ['solarIrradiance', effectiveSourceId, nodeId, start, end],
    queryFn: async (): Promise<Map<number, number>> => {
      const params = new URLSearchParams({
        sourceId: String(effectiveSourceId),
        nodeId: String(nodeId),
        start: String(start),
        end: String(end),
      });
      const response = await fetch(`${baseUrl}/api/solar/irradiance?${params.toString()}`);
      if (!response.ok) return new Map();

      const body: SolarIrradianceResponse = await response.json();
      const points = new Map<number, number>();
      for (const p of body.data?.points ?? []) {
        if (typeof p.shortwaveRadiation !== 'number') continue;
        // Unix seconds -> ms, to match telemetry timestamps
        points.set(p.timestamp * 1000, p.shortwaveRadiation);
      }
      return points;
    },
    enabled: enabled && !!effectiveSourceId && !!nodeId && !!start && !!end,
    refetchInterval: SOLAR_IRRADIANCE_REFRESH_MS,
    staleTime: SOLAR_IRRADIANCE_REFRESH_MS,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Options for useNodeVoltages hook
 */
interface UseNodeVoltagesOptions {
  /** Node IDs that need fallback voltage data */
  nodeIds: string[];
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
}

/**
 * Hook to fetch latest voltage telemetry for multiple nodes
 *
 * Uses useQueries to leverage TanStack Query caching and deduplication
 * per node, avoiding redundant fetches on re-renders.
 *
 * @param options - Configuration options
 * @returns Map of nodeId to latest voltage value
 */
export function useNodeVoltages({ nodeIds, baseUrl = '' }: UseNodeVoltagesOptions): Map<string, number> {
  const results = useQueries({
    queries: nodeIds.map(nodeId => ({
      queryKey: ['nodeVoltage', nodeId],
      queryFn: async (): Promise<{ nodeId: string; value: number } | null> => {
        try {
          const response = await fetch(`${baseUrl}/api/telemetry/${encodeURIComponent(nodeId)}?hours=720`);
          if (!response.ok) return null;
          const data = await response.json();

          const telemetryRows: TelemetryData[] = Array.isArray(data) ? data : [];
          const voltageRows = telemetryRows.filter(row => row.telemetryType === 'voltage');
          if (voltageRows.length === 0) return null;

          const latest = voltageRows.reduce((prev, current) =>
            current.timestamp > prev.timestamp ? current : prev
          );
          const value = Number(latest.value);
          if (Number.isNaN(value)) return null;

          return { nodeId, value };
        } catch {
          return null;
        }
      },
      staleTime: 5 * 60 * 1000, // Fresh for 5 minutes
      gcTime: 10 * 60 * 1000, // Cache for 10 minutes
      refetchInterval: 5 * 60 * 1000, // Refetch every 5 minutes
      refetchOnWindowFocus: false,
    })),
  });

  const voltageMap = new Map<string, number>();
  results.forEach(result => {
    if (result.data) {
      voltageMap.set(result.data.nodeId, result.data.value);
    }
  });

  return voltageMap;
}
