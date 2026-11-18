/**
 * Local node name of a MeshCore source, for the composer placeholder
 * (#3045 P2). Reads the cached `/meshcore/status`; that route needs
 * `connection:read`, which a `messages:write` user may lack, so any failure
 * reads as null and the caller falls back to the source name.
 */
import { useQuery } from '@tanstack/react-query';
import apiService from '../services/api';

export const MESHCORE_LOCAL_NAME_STALE_MS = 5 * 60_000;

export function parseMeshCoreLocalNodeName(body: unknown): string | null {
  const name = (body as { data?: { localNode?: { name?: unknown } | null } } | null | undefined)
    ?.data?.localNode?.name;
  return typeof name === 'string' && name.trim() ? name : null;
}

export function useMeshCoreLocalNodeName(sourceId: string | null, enabled: boolean): string | null {
  const { data } = useQuery({
    queryKey: ['unified', 'meshcoreLocalName', sourceId],
    queryFn: async () => {
      try {
        return parseMeshCoreLocalNodeName(
          await apiService.get<unknown>(`/api/sources/${encodeURIComponent(sourceId ?? '')}/meshcore/status`),
        );
      } catch {
        return null;
      }
    },
    enabled: enabled && !!sourceId,
    staleTime: MESHCORE_LOCAL_NAME_STALE_MS,
    retry: false,
  });
  return data ?? null;
}
