/**
 * Query keys, fetchers, and mutators for the mesh-issues dashboard (#4964
 * report reorganization, WP4, spec §7.4/§9.11). `ApiService.request()`
 * returns the raw envelope and does NOT unwrap `data` (CLAUDE.md gotcha) —
 * every fetcher here reads `body.data` explicitly.
 *
 * Split out of `MeshIssuesReport.tsx` so `IssueTypeSection`/`NodeGroupSection`
 * can build their own per-section query without importing back from the
 * shell (which would be circular: shell -> ByIssueView -> IssueTypeSection).
 */
import apiService from '../../../services/api';
import type {
  MeshIssueBulkScope,
  MeshIssuesBulkResult,
  MeshIssuesFilters,
  MeshIssuesResponse,
  MeshIssuesRunNowResult,
  MeshIssuesStatus,
  MeshIssuesSummary,
} from '../meshIssueTypes';

export const ISSUES_BASE_KEY = 'mesh-issues';
export const SUMMARY_BASE_KEY = 'mesh-issues-summary';
export const STATUS_KEY = ['mesh-issues-status'] as const;

/**
 * The shared §4.1 filter params, as a plain string map — used both as the
 * TanStack query-key fragment (so a filter change produces a new key and
 * therefore a refetch) and to build the request query string.
 *
 * Deliberately excludes `issueTypes`/`nodeNum`: neither is ever sent by this
 * module. `/summary` ignores them server-side (spec §4.3); the per-type and
 * per-node fetchers below set their own single `issueType`/`nodeNum` param
 * directly rather than deriving it from `filters.issueTypes` (which is only
 * a UI cursor — which tile/section is "active" — not a server filter here).
 */
export function serverFilterParams(filters: MeshIssuesFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.severities.length > 0) params.severity = filters.severities.join(',');
  if (filters.tiers.length > 0) params.tier = filters.tiers.join(',');
  if (filters.sources.length > 0) params.sources = filters.sources.join(',');
  const q = filters.q.trim();
  if (q.length > 0) params.q = q;
  if (filters.includeClosed) params.includeClosed = 'true';
  if (filters.includeDismissed) params.includeDismissed = 'true';
  return params;
}

export function summaryKey(filters: MeshIssuesFilters) {
  return [SUMMARY_BASE_KEY, serverFilterParams(filters)] as const;
}

export function typeIssuesKey(issueType: string, filters: MeshIssuesFilters) {
  return [ISSUES_BASE_KEY, { issueType, ...serverFilterParams(filters) }] as const;
}

export function nodeIssuesKey(nodeNum: number | null, filters: MeshIssuesFilters) {
  return [ISSUES_BASE_KEY, { nodeNum, ...serverFilterParams(filters) }] as const;
}

async function fetchIssuesRaw(params: URLSearchParams): Promise<MeshIssuesResponse> {
  const body = await apiService.get<{ success: boolean; data: MeshIssuesResponse }>(
    `/api/analysis/mesh-issues?${params.toString()}`,
  );
  return body.data;
}

/**
 * One By-issue section's ENTIRE group in a single request (spec §6.2):
 * `limit=2000` covers the worst real-world type count (582), so the section
 * sorts client-side without a second round trip.
 */
export async function fetchIssuesForType(
  issueType: string,
  filters: MeshIssuesFilters,
): Promise<MeshIssuesResponse> {
  const params = new URLSearchParams(serverFilterParams(filters));
  params.set('issueType', issueType);
  params.set('limit', '2000');
  params.set('offset', '0');
  return fetchIssuesRaw(params);
}

/** One By-node group (spec §6.3) — `nodeNum: null` fetches the Mesh-wide
 *  pseudo-group via the wire's `nodeNum=none` literal. */
export async function fetchIssuesForNode(
  nodeNum: number | null,
  filters: MeshIssuesFilters,
): Promise<MeshIssuesResponse> {
  const params = new URLSearchParams(serverFilterParams(filters));
  params.set('nodeNum', nodeNum === null ? 'none' : String(nodeNum));
  params.set('limit', '2000');
  params.set('offset', '0');
  return fetchIssuesRaw(params);
}

export async function fetchSummary(filters: MeshIssuesFilters): Promise<MeshIssuesSummary> {
  const params = new URLSearchParams(serverFilterParams(filters));
  const body = await apiService.get<{ success: boolean; data: MeshIssuesSummary }>(
    `/api/analysis/mesh-issues/summary?${params.toString()}`,
  );
  return body.data;
}

export async function fetchStatus(): Promise<MeshIssuesStatus> {
  const body = await apiService.get<{ success: boolean; data: MeshIssuesStatus }>(
    '/api/analysis/mesh-issues/status',
  );
  return body.data;
}

export async function postRunNow(): Promise<MeshIssuesRunNowResult> {
  const body = await apiService.post<{ success: boolean; data: MeshIssuesRunNowResult }>(
    '/api/analysis/mesh-issues/run-now',
  );
  return body.data;
}

export async function postDismiss(id: number): Promise<void> {
  await apiService.post(`/api/analysis/mesh-issues/${id}/dismiss`);
}

export async function postRestore(id: number): Promise<void> {
  await apiService.post(`/api/analysis/mesh-issues/${id}/restore`);
}

/**
 * Bulk dismiss/restore (#4964 report reorganization, WP5, spec §4.4) — a
 * declarative `MeshIssueBulkScope`, NOT an id array (see the wire type's own
 * doc comment for why). Response carries only `affected`, deliberately no
 * `skipped` count (the #3745 leak class).
 */
export async function postBulkDismiss(scope: MeshIssueBulkScope): Promise<MeshIssuesBulkResult> {
  const body = await apiService.post<{ success: boolean; data: MeshIssuesBulkResult }>(
    '/api/analysis/mesh-issues/bulk/dismiss',
    scope,
  );
  return body.data;
}

export async function postBulkRestore(scope: MeshIssueBulkScope): Promise<MeshIssuesBulkResult> {
  const body = await apiService.post<{ success: boolean; data: MeshIssuesBulkResult }>(
    '/api/analysis/mesh-issues/bulk/restore',
    scope,
  );
  return body.data;
}
