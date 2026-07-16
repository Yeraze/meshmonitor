/**
 * Fetch the elevation profile for a Link Profile endpoint pair (#4111, Phase
 * 2). The profile is geometry-only — it depends solely on the two
 * coordinates (and sample count), never on link-budget inputs like
 * frequency or antenna height — so it is keyed on rounded coordinates and
 * cached for a long stale time. Budget-input edits recompute client-side via
 * `analyzeLinkProfile`/`computeLinkBudget` without touching this hook.
 */
import { useQuery } from '@tanstack/react-query';
import apiService from '../services/api';
import type { LinkEndpoint } from '../utils/linkProfile';
import type { ElevationProfile } from '../types/elevation';

/** Round to ~6 decimal places (~11cm) so repeated picks of "the same" point share cache. */
function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Disabled until both endpoints are set. `queryKey` is built from rounded
 * coordinates so budget-input edits elsewhere never trigger a refetch.
 */
export function useElevationProfile(a: LinkEndpoint | undefined, b: LinkEndpoint | undefined) {
  const enabled = !!a && !!b;
  return useQuery<ElevationProfile>({
    queryKey: [
      'elevation-profile',
      a ? [round(a.lat), round(a.lng)] : null,
      b ? [round(b.lat), round(b.lng)] : null,
    ],
    queryFn: () =>
      apiService.getElevationProfile({ lat: a!.lat, lng: a!.lng }, { lat: b!.lat, lng: b!.lng }),
    enabled,
    staleTime: 30 * 60_000, // terrain is static
  });
}
