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
import { encodeReceiverFilter, receiverKey, type CoverageReceiverFilterEntry } from '../utils/coverageReceiverFilter';
import type {
  CoverageReceiverDto,
  CoverageSenderDto,
  CoverageReceptionDto,
  CoverageHopsMode,
  CoverageMqttSourceStatusDto,
} from '../types/coverage';

/** Client-side page cap for `/receptions` (spec §2.11): 10 pages * 1000 rows/page ≈ 10k rows. */
export const COVERAGE_MAX_PAGES = 10;
export const COVERAGE_PAGE_SIZE = 1000;

export interface CoverageReceiversResult {
  receivers: CoverageReceiverDto[];
  retentionDays: number;
  mqttSources: CoverageMqttSourceStatusDto[];
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
  /** Source-scoped receiver filter (WP1 wire format), built by the caller
   *  with `buildReceiverQuery` (#5277 P2 §2.5/§2.9). */
  receiverFilter?: CoverageReceiverFilterEntry[];
  /**
   * Set only when `buildReceiverQuery` hit the 1000-id cap and fell back to
   * client-side filtering (a single source with well over 2000 gateways,
   * roughly half selected — spec §2.5). Composite `receiverKey(sourceId,
   * receiverId)` keys of the SELECTED receivers; the server is queried with
   * no receiver filter at all (every permitted/`sources`-scoped row comes
   * back), and rows whose composite key isn't in this set are dropped after
   * each page.
   */
  clientSideFilter?: Set<string>;
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
 *
 * `receiverFilter` is encoded to the wire grammar once per call and that
 * STRING — not the `Set` in `clientSideFilter` — is what goes in the query
 * key (spec §2.9): TanStack Query's default `queryKeyHashFn` does
 * structural (JSON) equality, and `JSON.stringify(new Set(...))` collapses
 * to `{}` for every Set regardless of contents, which would make two
 * genuinely different client-side filters hash identically and serve each
 * other's cached page. The encoded composite-key list below sidesteps that.
 */
export function useCoverageReceptions(
  filters: CoverageReceptionsFilters,
  enabled: boolean = true,
): UseQueryResult<CoverageReceptionsResult> {
  const receiversQuery = encodeReceiverFilter(filters.receiverFilter ?? []);
  const clientSideFilterKey = filters.clientSideFilter
    ? Array.from(filters.clientSideFilter).sort().join(',')
    : undefined;

  return useQuery<CoverageReceptionsResult>({
    queryKey: [
      'analysis',
      'coverageReport',
      'receptions',
      {
        sources: filters.sources,
        sinceMs: filters.sinceMs,
        untilMs: filters.untilMs,
        receiversQuery,
        clientSideFilterKey,
        senderId: filters.senderId,
        hops: filters.hops,
        hopsMode: filters.hopsMode,
      },
    ],
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
          sources: filters.sources,
          sinceMs: filters.sinceMs,
          untilMs: filters.untilMs,
          receiversQuery: receiversQuery || undefined,
          senderId: filters.senderId,
          hops: filters.hops,
          hopsMode: filters.hopsMode,
          pageSize: COVERAGE_PAGE_SIZE,
          cursor,
          signal,
        });
        const pageItems = filters.clientSideFilter
          ? result.items.filter((item) => filters.clientSideFilter!.has(receiverKey(item.sourceId, item.receiverId)))
          : result.items;
        items.push(...pageItems);

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
