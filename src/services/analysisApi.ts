import api from './api.js';
import type {
  CoverageHopsMode,
  CoverageReceiverDto,
  CoverageSenderDto,
  CoverageReceptionDto,
  CoveragePage,
  CoverageMqttSourceStatusDto,
  CoverageSurveyDto,
  CreateCoverageSurveyBody,
  UpdateCoverageSurveyBody,
} from '../types/coverage.js';

export interface Paginated<T> {
  items: T[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface FetchArgs {
  sources: string[];
  sinceMs: number;
  pageSize?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

function buildQuery(args: {
  sources: string[];
  sinceMs: number;
  pageSize?: number;
  cursor?: string | null;
}): string {
  const p = new URLSearchParams();
  if (args.sources.length) p.set('sources', args.sources.join(','));
  p.set('since', String(args.sinceMs));
  if (args.pageSize) p.set('pageSize', String(args.pageSize));
  if (args.cursor) p.set('cursor', args.cursor);
  return p.toString();
}

/**
 * Wraps `api.get` while honoring an AbortSignal at the boundaries.
 * `api.get` itself does not pass the signal into fetch, but if the signal
 * is already aborted before the call we throw immediately, and callers in
 * paginating loops check the signal between pages. This is sufficient for
 * cancelling in-flight aggregation without leaking ongoing work into state.
 */
async function authedGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  return api.get<T>(path);
}

export async function fetchPositionsPage(args: FetchArgs): Promise<Paginated<any>> {
  return authedGet<Paginated<any>>(
    `/api/analysis/positions?${buildQuery(args)}`,
    args.signal,
  );
}

export async function fetchTraceroutesPage(args: FetchArgs): Promise<Paginated<any>> {
  return authedGet<Paginated<any>>(
    `/api/analysis/traceroutes?${buildQuery(args)}`,
    args.signal,
  );
}

export async function fetchNeighbors(
  args: Omit<FetchArgs, 'pageSize' | 'cursor'>,
): Promise<{ items: any[] }> {
  return authedGet<{ items: any[] }>(
    `/api/analysis/neighbors?${buildQuery({
      sources: args.sources,
      sinceMs: args.sinceMs,
    })}`,
    args.signal,
  );
}

export async function fetchMeshCoreNeighbors(
  args: { sources: string[]; sinceMs: number; signal?: AbortSignal },
): Promise<{ items: any[] }> {
  const results = await Promise.all(
    args.sources.map((sourceId) =>
      authedGet<{ success: boolean; data: { items: any[] } }>(
        `/api/sources/${sourceId}/meshcore/neighbors?since=${args.sinceMs}`,
        args.signal,
      ).catch(() => ({ success: false, data: { items: [] } })),
    ),
  );
  const items = results.flatMap((r) => (r.success ? r.data.items : []));
  return { items };
}

export async function fetchCoverageGrid(
  args: Omit<FetchArgs, 'pageSize' | 'cursor'> & { zoom: number },
): Promise<{ cells: any[]; binSizeDeg: number }> {
  const p = new URLSearchParams();
  if (args.sources.length) p.set('sources', args.sources.join(','));
  p.set('since', String(args.sinceMs));
  p.set('zoom', String(args.zoom));
  return authedGet<{ cells: any[]; binSizeDeg: number }>(
    `/api/analysis/coverage-grid?${p.toString()}`,
    args.signal,
  );
}

// ── Coverage Report (#5277, Phase 1 WP4) ────────────────────────────────────
//
// `coverageRoutes.ts` uses the `ok()`/`fail()` envelope (`{ success, data }`),
// unlike the other analysis endpoints above (`res.json(result)`, bare
// payload) — `ApiService.request()` does not unwrap `data` for either shape,
// so every fetcher below reads `body.data` explicitly (CLAUDE.md gotcha).

export async function fetchCoverageReceivers(
  args: { sources: string[]; signal?: AbortSignal },
): Promise<{ receivers: CoverageReceiverDto[]; retentionDays: number; mqttSources: CoverageMqttSourceStatusDto[] }> {
  const p = new URLSearchParams();
  if (args.sources.length) p.set('sources', args.sources.join(','));
  const body = await authedGet<{
    success: boolean;
    data: { receivers: CoverageReceiverDto[]; retentionDays: number; mqttSources: CoverageMqttSourceStatusDto[] };
  }>(`/api/analysis/coverage/receivers?${p.toString()}`, args.signal);
  return body.data;
}

export interface FetchCoverageSendersArgs {
  sources: string[];
  sinceMs: number;
  untilMs: number;
  signal?: AbortSignal;
}

export async function fetchCoverageSenders(
  args: FetchCoverageSendersArgs,
): Promise<{ senders: CoverageSenderDto[]; truncated: boolean }> {
  const p = new URLSearchParams();
  if (args.sources.length) p.set('sources', args.sources.join(','));
  p.set('since', String(args.sinceMs));
  p.set('until', String(args.untilMs));
  const body = await authedGet<{
    success: boolean;
    data: { senders: CoverageSenderDto[]; truncated: boolean };
  }>(`/api/analysis/coverage/senders?${p.toString()}`, args.signal);
  return body.data;
}

export interface FetchCoverageReceptionsPageArgs {
  sources: string[];
  sinceMs: number;
  untilMs: number;
  /**
   * Pre-encoded `receivers` wire grammar (`src:+id,id;src:-id,id` — WP1's
   * `encodeReceiverFilter`, `src/utils/coverageReceiverFilter.ts`), NOT a
   * raw id list — P1's flat CSV matched an id on every source, which the
   * server no longer accepts (#5277 P2 §2.5/D8).
   */
  receiversQuery?: string;
  senderId?: string;
  hops?: number;
  hopsMode?: CoverageHopsMode;
  pageSize?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

export async function fetchCoverageReceptionsPage(
  args: FetchCoverageReceptionsPageArgs,
): Promise<CoveragePage<CoverageReceptionDto>> {
  const p = new URLSearchParams();
  if (args.sources.length) p.set('sources', args.sources.join(','));
  p.set('since', String(args.sinceMs));
  p.set('until', String(args.untilMs));
  if (args.receiversQuery) p.set('receivers', args.receiversQuery);
  if (args.senderId) p.set('sender', args.senderId);
  if (args.hops !== undefined) p.set('hops', String(args.hops));
  if (args.hopsMode) p.set('hopsMode', args.hopsMode);
  if (args.pageSize) p.set('pageSize', String(args.pageSize));
  if (args.cursor) p.set('cursor', args.cursor);
  const body = await authedGet<{ success: boolean; data: CoveragePage<CoverageReceptionDto> }>(
    `/api/analysis/coverage/receptions?${p.toString()}`,
    args.signal,
  );
  return body.data;
}

// ── Coverage Report — saved surveys (#5277 P4b WP3, COVERAGE_P4_SPEC.md §2b.7) ──
//
// Same envelope gotcha as above: `coverageSurveyRoutes.ts` (server, built in
// parallel by a different WP) uses `ok()`/`fail()`, so every fetcher here
// reads `body.data`. `ApiService` has no `patch()` method — `request()` is
// public, so PATCH goes through it directly rather than adding one for a
// single caller.

export async function fetchCoverageSurveys(
  args: { signal?: AbortSignal } = {},
): Promise<CoverageSurveyDto[]> {
  const body = await authedGet<{ success: boolean; data: CoverageSurveyDto[] }>(
    '/api/analysis/coverage/surveys',
    args.signal,
  );
  return body.data;
}

export async function createCoverageSurvey(
  body: CreateCoverageSurveyBody,
): Promise<CoverageSurveyDto> {
  const res = await api.post<{ success: boolean; data: CoverageSurveyDto }>(
    '/api/analysis/coverage/surveys',
    body,
  );
  return res.data;
}

export async function updateCoverageSurvey(
  id: string,
  body: UpdateCoverageSurveyBody,
): Promise<CoverageSurveyDto> {
  const res = await api.request<{ success: boolean; data: CoverageSurveyDto }>(
    'PATCH',
    `/api/analysis/coverage/surveys/${encodeURIComponent(id)}`,
    body,
  );
  return res.data;
}

export async function stopCoverageSurvey(id: string): Promise<CoverageSurveyDto> {
  const res = await api.post<{ success: boolean; data: CoverageSurveyDto }>(
    `/api/analysis/coverage/surveys/${encodeURIComponent(id)}/stop`,
  );
  return res.data;
}

export async function deleteCoverageSurvey(id: string): Promise<void> {
  await api.delete<{ success: boolean }>(`/api/analysis/coverage/surveys/${encodeURIComponent(id)}`);
}

export async function fetchHopCounts(args: {
  sources: string[];
  signal?: AbortSignal;
}): Promise<{ entries: any[] }> {
  const p = new URLSearchParams();
  if (args.sources.length) p.set('sources', args.sources.join(','));
  return authedGet<{ entries: any[] }>(
    `/api/analysis/hop-counts?${p.toString()}`,
    args.signal,
  );
}
