/**
 * Availability + tile-support signal for the 3D map (#3826 Phase 2 WP-B).
 *
 * `GET /api/elevation/capabilities` is **enveloped**
 * (`{success,data}` — `src/server/utils/apiResponse.ts`), unlike
 * `useElevationEnabled`'s bare `/api/settings` read — this hook must read
 * `body.data` (the `ApiService.request()` unwrap gotcha).
 *
 * Provider type (`terrarium` | `json`) is derived server-side because
 * `elevationSourceUrl` is a secret setting stripped from `/api/settings`
 * for non-admins; the capabilities endpoint exposes only the derived
 * booleans, never the URL.
 */
import { useQuery } from '@tanstack/react-query';
import apiService from '../services/api';

interface ElevationCapabilitiesData {
  enabled: boolean;
  terrainTiles: boolean;
  provider: 'terrarium' | 'json';
}

export interface TerrainCapabilities {
  enabled: boolean;
  terrainTiles: boolean;
  isLoading: boolean;
}

/** Safe defaults while loading: treat the toggle as unavailable, not available. */
const LOADING_DEFAULTS: Omit<TerrainCapabilities, 'isLoading'> = {
  enabled: false,
  terrainTiles: false,
};

export function useTerrainCapabilities(): TerrainCapabilities {
  const { data, isLoading } = useQuery({
    queryKey: ['elevation', 'capabilities'],
    queryFn: () =>
      apiService.get<{ success: boolean; data: ElevationCapabilitiesData }>(
        '/api/elevation/capabilities',
      ),
    staleTime: 5 * 60_000,
  });

  if (!data) {
    return { ...LOADING_DEFAULTS, isLoading };
  }

  return {
    enabled: data.data.enabled,
    terrainTiles: data.data.terrainTiles,
    isLoading,
  };
}
