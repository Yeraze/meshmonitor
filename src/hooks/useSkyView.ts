/**
 * Fetch the GNSS sky view (visible satellites + DOP) for one observer point
 * (#4729). The sky view is a pure function of the observer coordinate + the
 * instant + the cached TLE set — no mesh traffic, no per-source scoping — so it
 * is keyed on rounded coordinates and cached for a modest stale time.
 *
 * `timeMs` is deliberately omitted from the request so the backend defaults to
 * "now"; the constellation moves slowly enough that TanStack Query's stale
 * window is the right refresh cadence, and pinning a per-render `Date.now()`
 * into the query key would defeat the cache.
 */
import { useQuery } from '@tanstack/react-query';
import apiService, { type SkyViewResult } from '../services/api';

export interface SkyViewObserver {
  lat: number;
  lon: number;
}

export interface UseSkyViewOptions {
  altKm?: number;
  elevationMaskDeg?: number;
  constellations?: string[];
  /** Defer the fetch (e.g. until a collapsible panel is opened). Default true. */
  enabled?: boolean;
}

export interface UseSkyViewResult {
  satellites: SkyViewResult['satellites'];
  dop: SkyViewResult['dop'];
  /** Theoretical count of satellites above the mask; null until loaded. */
  visibleCount: number | null;
  isLoading: boolean;
  error: Error | null;
}

/** Round to ~5 decimals (~1 m) so repeated observers at "the same" spot share cache. */
function round(n: number): number {
  return Math.round(n * 100_000) / 100_000;
}

export function useSkyView(
  observer: SkyViewObserver | undefined,
  opts: UseSkyViewOptions = {},
): UseSkyViewResult {
  const { altKm, elevationMaskDeg, constellations, enabled = true } = opts;
  const isEnabled = enabled && !!observer;

  const query = useQuery<SkyViewResult>({
    queryKey: [
      'gnss-skyview',
      observer ? [round(observer.lat), round(observer.lon)] : null,
      altKm ?? null,
      elevationMaskDeg ?? null,
      constellations ?? null,
    ],
    queryFn: () =>
      apiService.getSkyView({
        lat: observer!.lat,
        lon: observer!.lon,
        ...(altKm != null ? { altKm } : {}),
        ...(elevationMaskDeg != null ? { elevationMaskDeg } : {}),
        ...(constellations != null ? { constellations } : {}),
      }),
    enabled: isEnabled,
    // The constellation drifts continuously but slowly; a couple of minutes of
    // freshness is plenty for a diagnostic and keeps the compute endpoint quiet.
    staleTime: 2 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  return {
    satellites: query.data?.satellites ?? [],
    dop: query.data?.dop ?? null,
    visibleCount: query.data?.visibleCount ?? null,
    isLoading: query.isLoading && isEnabled,
    error: (query.error as Error | null) ?? null,
  };
}
