/**
 * Traceroute Explorer (#5511) — API client. `ApiService.get()` returns the raw
 * envelope and does NOT unwrap `data` (CLAUDE.md gotcha), so this reads
 * `body.data` explicitly.
 */
import apiService from '../../../services/api';
import type { ExplorerResponse } from './explorerModel';

export const EXPLORER_QUERY_KEY = 'traceroute-explorer';

/** Time-range presets in hours; `null` = everything stored. */
export const RANGE_PRESETS: Array<{ id: string; hours: number | null }> = [
  { id: '6h', hours: 6 },
  { id: '24h', hours: 24 },
  { id: '7d', hours: 168 },
  { id: 'all', hours: null },
];

export async function fetchExplorer(params: { hours: number | null; sourceIds: string[] }): Promise<ExplorerResponse> {
  const query = new URLSearchParams();
  if (params.hours != null) query.set('hours', String(params.hours));
  if (params.sourceIds.length > 0) query.set('sources', params.sourceIds.join(','));
  const qs = query.toString();
  const body = await apiService.get<{ success: boolean; data: ExplorerResponse }>(
    `/api/traceroutes/explorer${qs ? `?${qs}` : ''}`,
  );
  return body.data;
}
