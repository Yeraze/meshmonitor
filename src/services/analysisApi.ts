import api from './api';

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
