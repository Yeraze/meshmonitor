/**
 * MeshCore estimated positions (#6260 WP5): one read per source, solved on the
 * server each time (never stored). Off until the map asks for it, and refreshed
 * on a slow cadence because neighbour and trace data change slowly.
 */
import { useQuery } from '@tanstack/react-query';
import api from '../../../services/api';

export interface MeshCoreEstimatedPosition {
  publicKey: string;
  latitude: number;
  longitude: number;
  uncertaintyKm: number;
  uniqueAnchors: number;
  nEff: number;
  radiusMethod: string;
}

const REFRESH_MS = 5 * 60_000;

export function useMeshCoreEstimatedPositions(
  sourceId: string | null,
  enabled: boolean,
): MeshCoreEstimatedPosition[] {
  const query = useQuery({
    queryKey: ['meshcore', 'estimated-positions', sourceId],
    queryFn: async () => {
      const resp = await api.get<{ success: boolean; data?: { items?: MeshCoreEstimatedPosition[] } }>(
        `/api/sources/${encodeURIComponent(sourceId as string)}/meshcore/estimated-positions`,
      );
      return resp?.data?.items ?? [];
    },
    enabled: enabled && Boolean(sourceId),
    refetchInterval: REFRESH_MS,
    staleTime: REFRESH_MS,
    retry: false,
  });
  return query.data ?? [];
}
