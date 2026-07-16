/**
 * Availability flag for the Terrain Link Profile tool (#4111, Phase 2).
 * `GET /api/settings` returns a bare settings map (not `{success,data}`
 * enveloped — see `SettingsContext.tsx`), and `elevationEnabled` is
 * non-secret so it is readable anonymously.
 */
import { useQuery } from '@tanstack/react-query';
import apiService from '../services/api';

/** True unless the server explicitly set `elevationEnabled` to `'false'`. */
export function useElevationEnabled(): boolean {
  const { data } = useQuery({
    queryKey: ['settings', 'elevationEnabled'],
    queryFn: () => apiService.get<{ elevationEnabled?: string }>('/api/settings'),
    staleTime: 5 * 60_000,
  });
  return data?.elevationEnabled !== 'false';
}
