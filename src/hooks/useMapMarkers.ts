/**
 * useMapMarkers — local map markers for one source (#5686).
 *
 * TanStack Query keyed on `['mapMarkers', sourceId]`. Markers are REST-only:
 * they are never pushed over the WebSocket, so each mutation invalidates the
 * list itself. A 403 (no `waypoints:read` on the source) reads as an empty
 * list, so a unified map simply shows nothing for that source.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiService from '../services/api';
import type { MapMarker, MapMarkerInput } from '../types/mapMarker';

interface Envelope<T> { success: boolean; data?: T }

function base(sourceId: string): string {
  return `/api/sources/${encodeURIComponent(sourceId)}/markers`;
}

export function useMapMarkers(sourceId: string | null | undefined, enabled = true) {
  const qc = useQueryClient();
  const key = ['mapMarkers', sourceId ?? ''];

  const query = useQuery<MapMarker[]>({
    queryKey: key,
    queryFn: async () => {
      try {
        const body = await apiService.get<Envelope<MapMarker[]>>(base(sourceId as string));
        return Array.isArray(body?.data) ? body.data : [];
      } catch (e) {
        if ((e as { status?: number })?.status === 403) return [];
        throw e;
      }
    },
    enabled: Boolean(sourceId) && enabled,
    staleTime: 30_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const create = useMutation({
    mutationFn: (input: MapMarkerInput) =>
      apiService.post<Envelope<MapMarker>>(base(sourceId as string), input).then((b) => b.data as MapMarker),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: number; input: MapMarkerInput }) =>
      apiService.put<Envelope<MapMarker>>(`${base(sourceId as string)}/${id}`, input).then((b) => b.data as MapMarker),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiService.delete<Envelope<never>>(`${base(sourceId as string)}/${id}`),
    onSuccess: invalidate,
  });

  return {
    markers: query.data ?? [],
    isLoading: query.isLoading,
    create: create.mutateAsync,
    update: update.mutateAsync,
    remove: remove.mutateAsync,
  };
}
