/**
 * useWaypoints — REST + WebSocket-backed waypoints store for a single source.
 *
 * The list is fetched via TanStack Query keyed on `['waypoints', sourceId]`.
 * Mutations call the REST endpoints and rely on the existing
 * `useWebSocket` listener (see `src/hooks/useWebSocket.ts`) to invalidate
 * the cache when a `waypoint:*` event fires.
 */
import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Waypoint, WaypointInput } from '../types/waypoint';
import { appBasename } from '../init';

function waypointsApiBase(sourceId: string): string {
  return `${appBasename}/api/sources/${encodeURIComponent(sourceId)}/waypoints`;
}

async function fetchWaypoints(sourceId: string): Promise<Waypoint[]> {
  const res = await fetch(waypointsApiBase(sourceId), { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to load waypoints (HTTP ${res.status})`);
  const body = await res.json();
  return Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
}

async function postJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const csrfToken = sessionStorage.getItem('csrfToken');
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const text = await res.text();
      if (text) message = text;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/**
 * Plain calls for a surface that picks the source per action (Map Analysis,
 * #5685), where one hook bound to one source will not do. The caller owns the
 * cache: invalidate `['waypoints', sourceId]` after each.
 */
export function createWaypoint(sourceId: string, input: WaypointInput) {
  return postJson<{ data: Waypoint }>(waypointsApiBase(sourceId), 'POST', input);
}

export function updateWaypoint(sourceId: string, waypointId: number, input: Partial<WaypointInput>) {
  return postJson<{ data: Waypoint }>(`${waypointsApiBase(sourceId)}/${waypointId}`, 'PATCH', input);
}

export function deleteWaypoint(sourceId: string, waypointId: number) {
  return postJson<{ success: boolean }>(`${waypointsApiBase(sourceId)}/${waypointId}`, 'DELETE');
}

export function useWaypoints(sourceId: string | null | undefined) {
  const qc = useQueryClient();
  const enabled = Boolean(sourceId);

  const query = useQuery<Waypoint[]>({
    queryKey: ['waypoints', sourceId ?? ''],
    queryFn: () => fetchWaypoints(sourceId as string),
    enabled,
    staleTime: 30_000,
  });

  const create = useMutation({
    mutationFn: async (input: WaypointInput) => {
      if (!sourceId) throw new Error('sourceId required');
      return createWaypoint(sourceId, input);
    },
    onSuccess: () => {
      if (sourceId) void qc.invalidateQueries({ queryKey: ['waypoints', sourceId] });
    },
  });

  const update = useMutation({
    mutationFn: async (args: { waypointId: number; input: Partial<WaypointInput> }) => {
      if (!sourceId) throw new Error('sourceId required');
      return updateWaypoint(sourceId, args.waypointId, args.input);
    },
    onSuccess: () => {
      if (sourceId) void qc.invalidateQueries({ queryKey: ['waypoints', sourceId] });
    },
  });

  const remove = useMutation({
    mutationFn: async (waypointId: number) => {
      if (!sourceId) throw new Error('sourceId required');
      return deleteWaypoint(sourceId, waypointId);
    },
    onSuccess: () => {
      if (sourceId) void qc.invalidateQueries({ queryKey: ['waypoints', sourceId] });
    },
  });

  const refetch = useCallback(() => {
    return query.refetch();
  }, [query]);

  return {
    waypoints: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch,
    create,
    update,
    remove,
  };
}
