/**
 * TanStack Query hooks for Coverage Report imports (#5891 P3, spec §3.10).
 * Keys live under `['analysis', 'coverageReport', ...]`, so one invalidation of
 * that prefix refreshes the receptions, senders and receivers a change touches.
 */
import { useMemo } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useCsrfFetch } from './useCsrfFetch';
import { useWalkaboutSources, type WalkaboutSourceRow } from './useWalkabout';
import type { HasSourcePermission } from './useWalkaboutSources';
import {
  deleteCoverageImport,
  fetchCoverageImports,
  uploadCoverageImport,
} from '../services/coverageImportApi';
import {
  COVERAGE_IMPORT_READ_GRANT,
  COVERAGE_IMPORT_WRITE_GRANT,
  coverageImportProtocolFor,
} from '../utils/coverageImport';
import type { CoverageImportDto, CoverageImportResult } from '../types/coverageImport';

export const coverageImportsKey = (sourceId: string) =>
  ['analysis', 'coverageReport', 'imports', sourceId] as const;

const REPORT_PREFIX = ['analysis', 'coverageReport'] as const;

/** Import-capable sources (Meshtastic TCP, MeshCore) the viewer holds the grant on. */
export function useCoverageImportSources(
  hasPermission: HasSourcePermission,
  mode: 'read' | 'write',
): WalkaboutSourceRow[] {
  const sourcesQ = useWalkaboutSources();
  return useMemo(() => {
    const grant = mode === 'write' ? COVERAGE_IMPORT_WRITE_GRANT : COVERAGE_IMPORT_READ_GRANT;
    return (sourcesQ.data ?? []).filter(
      (s) =>
        coverageImportProtocolFor(s.type ?? '') != null &&
        hasPermission(grant.resource, grant.action, { sourceId: s.id }),
    );
  }, [sourcesQ.data, hasPermission, mode]);
}

export interface SourcedCoverageImport extends CoverageImportDto {
  sourceName: string;
}

/** Imports of every given source, newest first. A source that errors lists nothing. */
export function useCoverageImports(sources: WalkaboutSourceRow[]): {
  imports: SourcedCoverageImport[];
  isLoading: boolean;
} {
  const results = useQueries({
    queries: sources.map((s) => ({
      queryKey: coverageImportsKey(s.id),
      queryFn: () => fetchCoverageImports(s.id),
    })),
  });
  const dataKey = results.map((r) => r.dataUpdatedAt).join(',');
  const imports = useMemo(() => {
    const rows: SourcedCoverageImport[] = [];
    results.forEach((r, i) => {
      for (const imp of r.data ?? []) rows.push({ ...imp, sourceName: sources[i]?.name || imp.sourceId });
    });
    return rows.sort((a, b) => b.importedAt - a.importedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #5891 results is a fresh array every render; dataKey tracks its content
  }, [dataKey, sources]);
  return { imports, isLoading: results.some((r) => r.isLoading) };
}

export function useImportCoverageFile() {
  const csrfFetch = useCsrfFetch();
  const qc = useQueryClient();
  return useMutation<CoverageImportResult, Error, { sourceId: string; file: File }>({
    mutationFn: ({ sourceId, file }) => uploadCoverageImport(csrfFetch, sourceId, file),
    onSuccess: (_r, { sourceId }) => {
      void qc.invalidateQueries({ queryKey: coverageImportsKey(sourceId) });
      void qc.invalidateQueries({ queryKey: REPORT_PREFIX });
    },
  });
}

export function useDeleteCoverageImport() {
  const qc = useQueryClient();
  return useMutation<void, Error, { sourceId: string; importId: string }>({
    mutationFn: ({ sourceId, importId }) => deleteCoverageImport(sourceId, importId),
    onSuccess: (_r, { sourceId }) => {
      void qc.invalidateQueries({ queryKey: coverageImportsKey(sourceId) });
      void qc.invalidateQueries({ queryKey: REPORT_PREFIX });
    },
  });
}
