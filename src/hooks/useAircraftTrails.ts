/**
 * useAircraftTrails — flight trails for likely aircraft (#5364/#5365 Phase 3).
 *
 * TanStack Query over `ApiService.getAircraftTrails`. Runs only while
 * `enabled` (the Map Features "Flight trails" box is on and the map is
 * mounted) and refetches every 60 s. It reads stored telemetry only, so it
 * sends nothing over the mesh.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import api from '../services/api';
import type { AircraftTrail } from '../components/map/aircraftTrails';

export const AIRCRAFT_TRAILS_REFETCH_MS = 60_000;

export interface UseAircraftTrailsArgs {
  enabled: boolean;
  hours: number;
  /** Narrow to these sources; omit or empty for every source the viewer can read. */
  sourceIds?: string[] | null;
}

export function aircraftTrailsQueryKey(hours: number, sourceIds?: string[] | null) {
  const sorted = sourceIds && sourceIds.length > 0 ? [...sourceIds].sort().join(',') : '*';
  return ['aircraft', 'trails', hours, sorted] as const;
}

export function useAircraftTrails({ enabled, hours, sourceIds }: UseAircraftTrailsArgs): UseQueryResult<AircraftTrail[]> {
  return useQuery({
    queryKey: aircraftTrailsQueryKey(hours, sourceIds),
    queryFn: () => api.getAircraftTrails(hours, sourceIds),
    enabled,
    refetchInterval: enabled ? AIRCRAFT_TRAILS_REFETCH_MS : false,
    staleTime: AIRCRAFT_TRAILS_REFETCH_MS / 2,
  });
}
