/**
 * useAssetTracking — TanStack Query hooks for the Asset Tracking routes
 * (#5354, Phase 1). All IO goes through `ApiService`, which returns the raw
 * JSON body, so each fetcher unwraps the `ok()` envelope's `data` itself.
 *
 * Saving or clearing a flag invalidates the node queries (poll + dashboard),
 * because the flag is an overlay on the node payload (`asset`, `isMobile`).
 */
import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import apiService from '../services/api';
import { POLL_QUERY_KEY } from './usePoll';

export interface AssetEstimate {
  nodeNum: number;
  rowsLast24h: number;
  retentionDays: number | null;
  estimatedRows: number | null;
}

export interface AssetRow {
  nodeNum: number;
  retentionDays: number;
  updatedBy: number | null;
  updatedAt: number;
}

interface Envelope<T> {
  success: boolean;
  data: T;
}

export const ASSETS_QUERY_KEY = ['assets'] as const;

export function assetEstimateQueryKey(nodeNum: number, retentionDays: number) {
  return [...ASSETS_QUERY_KEY, 'estimate', nodeNum, retentionDays] as const;
}

export async function fetchAssetEstimate(nodeNum: number, retentionDays: number): Promise<AssetEstimate> {
  const body = await apiService.get<Envelope<AssetEstimate>>(
    `/api/assets/${nodeNum >>> 0}/estimate?retentionDays=${retentionDays}`,
  );
  return body.data;
}

export async function putAsset(nodeNum: number, retentionDays: number): Promise<AssetRow> {
  const body = await apiService.put<Envelope<AssetRow>>(`/api/assets/${nodeNum >>> 0}`, { retentionDays });
  return body.data;
}

export async function deleteAsset(nodeNum: number): Promise<void> {
  await apiService.delete<Envelope<undefined>>(`/api/assets/${nodeNum >>> 0}`);
}

/** Estimated rows kept for `retentionDays`. Disabled while the input is invalid. */
export function useAssetEstimate(
  nodeNum: number | null,
  retentionDays: number | null,
): UseQueryResult<AssetEstimate> {
  return useQuery({
    queryKey: assetEstimateQueryKey(nodeNum ?? 0, retentionDays ?? 0),
    queryFn: () => fetchAssetEstimate(nodeNum as number, retentionDays as number),
    enabled: nodeNum != null && retentionDays != null,
    staleTime: 5 * 60 * 1000,
  });
}

function useInvalidateNodes() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: POLL_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ASSETS_QUERY_KEY });
  };
}

export function useSetAsset(): UseMutationResult<AssetRow, unknown, { nodeNum: number; retentionDays: number }> {
  const invalidate = useInvalidateNodes();
  return useMutation({
    mutationFn: ({ nodeNum, retentionDays }) => putAsset(nodeNum, retentionDays),
    onSuccess: invalidate,
  });
}

export function useClearAsset(): UseMutationResult<void, unknown, number> {
  const invalidate = useInvalidateNodes();
  return useMutation({
    mutationFn: (nodeNum: number) => deleteAsset(nodeNum),
    onSuccess: invalidate,
  });
}
