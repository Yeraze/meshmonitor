/**
 * A node's display time zone (#6523), resolved by the server: its Timezone
 * Override, else the zone at its position, else the server's zone. The
 * lookup data stays on the server; this only reads the answer.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useResolvedSourceId } from './useResolvedSourceId';
import { useCsrfFetch } from './useCsrfFetch';

/** Where a node's zone came from. Mirrors the server's `NodeTimezoneSource`. */
export type NodeTimezoneSource = 'override' | 'position' | 'server';

export interface NodeTimezone {
  timeZone: string;
  source: NodeTimezoneSource;
}

interface UseNodeTimezoneOptions {
  baseUrl?: string;
  /** Falls back to the resolved primary source, like the telemetry hooks. */
  sourceId?: string | null;
  nodeId: string | null | undefined;
  enabled?: boolean;
}

/** A node's zone changes only when it moves or someone sets an override. */
const NODE_TIMEZONE_STALE_MS = 60 * 60 * 1000;

const nodeTimezoneKey = (sourceId: string | null | undefined, nodeId: string | null | undefined) =>
  ['nodeTimezone', sourceId ?? null, nodeId ?? null] as const;

/**
 * The node's zone, or `undefined` while loading, on an error, or when the
 * caller may not read it. Charts treat `undefined` as "the browser's zone".
 */
export function useNodeTimezone({ baseUrl = '', sourceId, nodeId, enabled = true }: UseNodeTimezoneOptions) {
  const fallbackSourceId = useResolvedSourceId();
  const effectiveSourceId = sourceId ?? fallbackSourceId;
  return useQuery({
    queryKey: nodeTimezoneKey(effectiveSourceId, nodeId),
    queryFn: async (): Promise<NodeTimezone | null> => {
      const params = new URLSearchParams({ sourceId: String(effectiveSourceId), nodeId: String(nodeId) });
      const response = await fetch(`${baseUrl}/api/nodes/timezone?${params.toString()}`);
      if (!response.ok) return null;
      const body = (await response.json()) as { data?: Partial<NodeTimezone> };
      const tz = body.data;
      return tz && typeof tz.timeZone === 'string' && typeof tz.source === 'string'
        ? { timeZone: tz.timeZone, source: tz.source as NodeTimezoneSource }
        : null;
    },
    enabled: enabled && !!effectiveSourceId && !!nodeId,
    staleTime: NODE_TIMEZONE_STALE_MS,
    gcTime: NODE_TIMEZONE_STALE_MS,
    refetchOnWindowFocus: false,
  });
}

interface SetNodeTimezoneVars {
  sourceId: string;
  nodeId: string;
  /** IANA zone, or null for automatic. */
  timeZone: string | null;
}

/** Set or clear a node's Timezone Override, then refresh its zone. */
export function useSetNodeTimezone(baseUrl = '') {
  const csrfFetch = useCsrfFetch();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sourceId, nodeId, timeZone }: SetNodeTimezoneVars): Promise<NodeTimezone> => {
      const response = await csrfFetch(`${baseUrl}/api/nodes/timezone`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId, nodeId, timeZone }),
      });
      const body = (await response.json().catch(() => ({}))) as { data?: NodeTimezone; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error || `HTTP ${response.status}`);
      return body.data;
    },
    onSuccess: (data, { sourceId, nodeId }) => {
      queryClient.setQueryData(nodeTimezoneKey(sourceId, nodeId), data);
      void queryClient.invalidateQueries({ queryKey: nodeTimezoneKey(sourceId, nodeId) });
    },
  });
}

/** Every IANA zone this browser knows, or a short list where it cannot say. */
export function listTimeZones(): string[] {
  try {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
    const zones = intl.supportedValuesOf?.('timeZone');
    if (zones && zones.length > 0) return zones.includes('UTC') ? zones : ['UTC', ...zones];
  } catch {
    // Fall through to the short list.
  }
  return FALLBACK_TIME_ZONES;
}

const FALLBACK_TIME_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Johannesburg',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];
