/**
 * useCoverageData — TanStack Query hooks for the Coverage Report (#5277,
 * Phase 1 WP4). Thin wrappers over the `src/services/analysisApi.ts`
 * fetchers, which already unwrap `body.data` for the `ok()`-enveloped
 * `/api/analysis/coverage/*` routes.
 *
 * Query keys live under `['analysis', 'coverageReport', ...]` — deliberately
 * NOT `['analysis', 'coverage', ...]`, which `useCoverageGrid` (the
 * unrelated coverage-grid heatmap) already owns (COVERAGE_P1_SPEC.md
 * "Notes carried forward").
 *
 * No polling: callers get a manual `refetch` back from each hook and surface
 * it as a Refresh button (spec §2.11) rather than a `refetchInterval`.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  fetchCoverageReceivers,
  fetchCoverageSenders,
  fetchCoverageReceptionsPage,
} from '../services/analysisApi';
import type {
  CoverageReceiverDto,
  CoverageSenderDto,
  CoverageReceptionDto,
  CoverageHopsMode,
} from '../types/coverage';

/** Client-side page cap for `/receptions` (spec §2.11): 10 pages * 1000 rows/page ≈ 10k rows. */
export const COVERAGE_MAX_PAGES = 10;
export const COVERAGE_PAGE_SIZE = 1000;

export interface CoverageReceiversResult {
  receivers: CoverageReceiverDto[];
  retentionDays: number;
}

export function useCoverageReceivers(
  sources: string[] = [],
): UseQueryResult<CoverageReceiversResult> {
  return useQuery({
    queryKey: ['analysis', 'coverageReport', 'receivers', sources],
    queryFn: ({ signal }) => fetchCoverageReceivers({ sources, signal }),
  });
}

export interface CoverageSendersFilters {
  sources: string[];
  sinceMs: number;
  untilMs: number;
}

export interface CoverageSendersResult {
  senders: CoverageSenderDto[];
  truncated: boolean;
}

export function useCoverageSenders(
  filters: CoverageSendersFilters,
): UseQueryResult<CoverageSendersResult> {
  return useQuery({
    queryKey: ['analysis', 'coverageReport', 'senders', filters],
    queryFn: ({ signal }) => fetchCoverageSenders({ ...filters, signal }),
  });
}

export interface CoverageReceptionsFilters {
  sources: string[];
  sinceMs: number;
  untilMs: number;
  receiverIds?: string[];
  senderId?: string;
  hops?: number;
  hopsMode?: CoverageHopsMode;
}

export interface CoverageReceptionsResult {
  items: CoverageReceptionDto[];
  /** True once the client-side page cap (`COVERAGE_MAX_PAGES`) was hit while
   *  the server still had more rows (`hasMore` was still true). */
  truncated: boolean;
}

/**
 * Pages `/api/analysis/coverage/receptions` via `nextCursor` up to
 * `COVERAGE_MAX_PAGES`, honouring the query's AbortSignal between pages so a
 * filter change cancels an in-flight aggregation rather than racing it.
 */
export function useCoverageReceptions(
  filters: CoverageReceptionsFilters,
  enabled: boolean = true,
): UseQueryResult<CoverageReceptionsResult> {
  return useQuery<CoverageReceptionsResult>({
    queryKey: ['analysis', 'coverageReport', 'receptions', filters],
    enabled,
    queryFn: async ({ signal }) => {
      const items: CoverageReceptionDto[] = [];
      let cursor: string | undefined;
      let truncated = false;

      for (let page = 0; page < COVERAGE_MAX_PAGES; page++) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const result = await fetchCoverageReceptionsPage({
          ...filters,
          pageSize: COVERAGE_PAGE_SIZE,
          cursor,
          signal,
        });
        items.push(...result.items);

        if (!result.hasMore || !result.nextCursor) {
          break;
        }
        cursor = result.nextCursor;
        if (page === COVERAGE_MAX_PAGES - 1) {
          truncated = true;
        }
      }

      return { items, truncated };
    },
  });
}
