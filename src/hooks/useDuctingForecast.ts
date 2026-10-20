/**
 * Tropospheric ducting overlay data (#5734).
 *
 * `useDuctingEnabled` reads the admin's global `ductingOverlayEnabled` switch
 * from GET /api/settings (a bare, non-secret settings map, readable
 * anonymously). The map toggle is hidden unless it reads `'true'`.
 *
 * `useDuctingForecast` fetches ONE forecast step: the one on view. It sends no
 * `bbox`, so the server uses its default area (the nodes this viewer can see)
 * and every viewer with the same nodes shares one server cache entry. Steps
 * already fetched stay in the TanStack cache, so scrubbing back costs nothing.
 * No retry: a NOAA outage shows one inline message, not a request loop.
 */
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import apiService from '../services/api';

export type DuctingClass = 'sub-refractive' | 'normal' | 'super-refractive' | 'ducting';

export interface DuctingGrid {
  /** First (north-west) cell centre, degrees. Rows run north to south. */
  lat1: number;
  lon1: number;
  /** Cell size, degrees (positive). */
  dLat: number;
  dLon: number;
  /** Columns (west to east) and rows (north to south). */
  ni: number;
  nj: number;
}

export interface DuctingForecast {
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  /** GFS run, ISO time. */
  cycle: string;
  forecastHour: number;
  /** When this step is valid, ISO time. */
  validTime: string;
  grid: DuctingGrid;
  /** Row-major, north row first. null where a column could not be indexed. */
  minGradientNPerKm: (number | null)[];
  ductStrengthM: (number | null)[];
  layerBaseM: (number | null)[];
  layerTopM: (number | null)[];
  class: (DuctingClass | null)[];
  summary: Record<DuctingClass, number>;
}

/** The scrubber's range: now to +72 h in 3 h steps (25 steps). */
export const DUCTING_MAX_HOURS_AHEAD = 72;
export const DUCTING_STEP_HOURS = 3;

/** Steps change only when a new GFS cycle lands (every 6 h). */
const FORECAST_STALE_MS = 30 * 60_000;

export function useDuctingEnabled(): boolean {
  const { data } = useQuery({
    queryKey: ['settings', 'ductingOverlayEnabled'],
    queryFn: () => apiService.get<{ ductingOverlayEnabled?: string }>('/api/settings'),
    staleTime: 60_000,
  });
  return data?.ductingOverlayEnabled === 'true';
}

export function ductingForecastQueryKey(hoursAhead: number): readonly unknown[] {
  return ['ducting', 'forecast', hoursAhead] as const;
}

export function useDuctingForecast(hoursAhead: number, enabled: boolean): UseQueryResult<DuctingForecast> {
  return useQuery({
    queryKey: ductingForecastQueryKey(hoursAhead),
    queryFn: async () => {
      const body = await apiService.get<{ success: boolean; data: DuctingForecast }>(
        `/api/ducting/forecast?hoursAhead=${hoursAhead}`,
      );
      return body.data;
    },
    enabled,
    staleTime: FORECAST_STALE_MS,
    gcTime: 6 * 3600_000,
    retry: false,
    refetchOnWindowFocus: false,
    // Keep the last step drawn while the next one loads.
    placeholderData: keepPreviousData,
  });
}
