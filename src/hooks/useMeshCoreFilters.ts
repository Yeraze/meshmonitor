/**
 * useMeshCoreFilters — TanStack Query hooks for MeshCore Ignore / Block
 * (#5408). All IO goes through `ApiService`, which returns the raw JSON body,
 * so each fetcher unwraps the `ok()` envelope's `data` itself.
 *
 * Every successful write invalidates the lists and fires the
 * `meshcore-filters-changed` window event so open message views reload (the
 * ignored flag is computed by the server at read time).
 */
import { useEffect, useMemo } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import apiService from '../services/api';
import { emitFiltersChanged, subscribeFiltersChanged } from '../components/MeshCore/meshcoreFilterEvents';

export type MeshCoreFilterMode = 'ignore' | 'block';
export type MeshCoreFilterMatchType = 'exact' | 'wildcard' | 'regex';
export type MeshCoreFilterFields = 'name' | 'body' | 'both';

export interface MeshCoreIgnoredNode {
  sourceId: string;
  publicKey: string;
  name: string | null;
  mode: MeshCoreFilterMode;
  createdAt: number;
  createdBy: number | null;
  hitCount: number;
  lastHitAt: number | null;
}

export interface MeshCoreMessageFilter {
  id: string;
  sourceId: string;
  mode: MeshCoreFilterMode;
  matchType: MeshCoreFilterMatchType;
  pattern: string;
  caseSensitive: boolean;
  fields: MeshCoreFilterFields;
  enabled: boolean;
  createdAt: number;
  createdBy: number | null;
  hitCount: number;
  lastHitAt: number | null;
}

export type MeshCoreMessageFilterInput = Pick<
  MeshCoreMessageFilter,
  'mode' | 'matchType' | 'pattern' | 'caseSensitive' | 'fields' | 'enabled'
>;

interface Envelope<T> {
  success: boolean;
  data: T;
}

const prefix = (sourceId: string) => `/api/sources/${encodeURIComponent(sourceId)}/meshcore`;

export const meshcoreIgnoredNodesQueryKey = (sourceId: string) => ['meshcore', 'ignored-nodes', sourceId] as const;
export const meshcoreMessageFiltersQueryKey = (sourceId: string) => ['meshcore', 'message-filters', sourceId] as const;

export async function fetchMeshCoreIgnoredNodes(sourceId: string): Promise<MeshCoreIgnoredNode[]> {
  const body = await apiService.get<Envelope<MeshCoreIgnoredNode[]>>(`${prefix(sourceId)}/ignored-nodes`);
  return body.data ?? [];
}

export async function fetchMeshCoreMessageFilters(sourceId: string): Promise<MeshCoreMessageFilter[]> {
  const body = await apiService.get<Envelope<MeshCoreMessageFilter[]>>(`${prefix(sourceId)}/message-filters`);
  return body.data ?? [];
}

/** Keep a source's lists fresh when another tab or user changes them. */
function useInvalidateOnRemoteChange(sourceId: string | null | undefined): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!sourceId) return;
    return subscribeFiltersChanged((detail) => {
      if (detail.sourceId !== sourceId) return;
      void queryClient.invalidateQueries({ queryKey: meshcoreIgnoredNodesQueryKey(sourceId) });
      void queryClient.invalidateQueries({ queryKey: meshcoreMessageFiltersQueryKey(sourceId) });
    });
  }, [sourceId, queryClient]);
}

export function useMeshCoreIgnoredNodes(
  sourceId: string | null | undefined,
  opts: { enabled?: boolean } = {},
): UseQueryResult<MeshCoreIgnoredNode[]> {
  useInvalidateOnRemoteChange(sourceId);
  return useQuery({
    queryKey: meshcoreIgnoredNodesQueryKey(sourceId ?? ''),
    queryFn: () => fetchMeshCoreIgnoredNodes(sourceId as string),
    enabled: !!sourceId && opts.enabled !== false,
    staleTime: 30_000,
  });
}

export function useMeshCoreMessageFilters(sourceId: string | null | undefined): UseQueryResult<MeshCoreMessageFilter[]> {
  useInvalidateOnRemoteChange(sourceId);
  return useQuery({
    queryKey: meshcoreMessageFiltersQueryKey(sourceId ?? ''),
    queryFn: () => fetchMeshCoreMessageFilters(sourceId as string),
    enabled: !!sourceId,
    staleTime: 30_000,
  });
}

/** Lowercase public keys with an entry (either mode) — the nodes to hide. */
export function useHiddenMeshCoreKeys(entries: MeshCoreIgnoredNode[] | undefined): Set<string> {
  return useMemo(() => new Set((entries ?? []).map((e) => e.publicKey.toLowerCase())), [entries]);
}

function useAfterWrite(sourceId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: meshcoreIgnoredNodesQueryKey(sourceId) });
    void queryClient.invalidateQueries({ queryKey: meshcoreMessageFiltersQueryKey(sourceId) });
    emitFiltersChanged({ sourceId });
  };
}

export function useSetMeshCoreIgnoredNode(
  sourceId: string,
): UseMutationResult<MeshCoreIgnoredNode, unknown, { publicKey: string; mode: MeshCoreFilterMode; name?: string | null }> {
  const after = useAfterWrite(sourceId);
  return useMutation({
    mutationFn: async ({ publicKey, mode, name }) => {
      const body = await apiService.post<Envelope<MeshCoreIgnoredNode>>(`${prefix(sourceId)}/ignored-nodes`, {
        publicKey,
        mode,
        ...(name ? { name } : {}),
      });
      return body.data;
    },
    onSuccess: after,
  });
}

export function useRemoveMeshCoreIgnoredNode(sourceId: string): UseMutationResult<void, unknown, string> {
  const after = useAfterWrite(sourceId);
  return useMutation({
    mutationFn: async (publicKey: string) => {
      await apiService.delete<Envelope<undefined>>(`${prefix(sourceId)}/ignored-nodes/${encodeURIComponent(publicKey)}`);
    },
    onSuccess: after,
  });
}

export function useCreateMeshCoreMessageFilter(
  sourceId: string,
): UseMutationResult<MeshCoreMessageFilter, unknown, MeshCoreMessageFilterInput> {
  const after = useAfterWrite(sourceId);
  return useMutation({
    mutationFn: async (input) => {
      const body = await apiService.post<Envelope<MeshCoreMessageFilter>>(`${prefix(sourceId)}/message-filters`, input);
      return body.data;
    },
    onSuccess: after,
  });
}

export function useUpdateMeshCoreMessageFilter(
  sourceId: string,
): UseMutationResult<MeshCoreMessageFilter, unknown, { id: string; patch: Partial<MeshCoreMessageFilterInput> }> {
  const after = useAfterWrite(sourceId);
  return useMutation({
    mutationFn: async ({ id, patch }) => {
      const body = await apiService.put<Envelope<MeshCoreMessageFilter>>(
        `${prefix(sourceId)}/message-filters/${encodeURIComponent(id)}`,
        patch,
      );
      return body.data;
    },
    onSuccess: after,
  });
}

export function useDeleteMeshCoreMessageFilter(sourceId: string): UseMutationResult<void, unknown, string> {
  const after = useAfterWrite(sourceId);
  return useMutation({
    mutationFn: async (id: string) => {
      await apiService.delete<Envelope<undefined>>(`${prefix(sourceId)}/message-filters/${encodeURIComponent(id)}`);
    },
    onSuccess: after,
  });
}
