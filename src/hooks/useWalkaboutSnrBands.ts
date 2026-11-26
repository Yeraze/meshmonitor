/**
 * Per-source SNR band edges for the walkabout hex map (#6571).
 *
 * Read from the source-scoped `GET /api/settings?sourceId=` (bare map) and
 * saved through `POST /api/settings?sourceId=`, which validates them.
 * Missing, blank or invalid values read as the defaults (0 / -5 / -10 dB).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiService from '../services/api';
import {
  WALKABOUT_SNR_BANDS_SETTING,
  formatWalkaboutSnrBands,
  parseWalkaboutSnrBands,
  type WalkaboutSnrBands,
} from '../utils/walkabout';

export function walkaboutSnrBandsQueryKey(sourceId: string) {
  return ['settings', 'walkabout-snr-bands', sourceId] as const;
}

const settingsUrl = (sourceId: string) => `/api/settings?sourceId=${encodeURIComponent(sourceId)}`;

export function useWalkaboutSnrBands(sourceId: string): WalkaboutSnrBands {
  const { data } = useQuery({
    queryKey: walkaboutSnrBandsQueryKey(sourceId),
    queryFn: () => apiService.get<Record<string, string>>(settingsUrl(sourceId)),
    staleTime: 60_000,
  });
  return parseWalkaboutSnrBands(data?.[WALKABOUT_SNR_BANDS_SETTING]);
}

/** Save new edges, or `null` to reset to the defaults. */
export function useSaveWalkaboutSnrBands(sourceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bands: WalkaboutSnrBands | null) =>
      apiService.post(settingsUrl(sourceId), {
        [WALKABOUT_SNR_BANDS_SETTING]: bands ? formatWalkaboutSnrBands(bands) : '',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: walkaboutSnrBandsQueryKey(sourceId) }),
  });
}
