/**
 * Client for the MeshCore CLI history routes (#5892). The server answers with
 * the `{ success, data }` envelope; `apiService.get` returns the raw body, so
 * these helpers unwrap `data`.
 */
import apiService from '../../services/api';

export type CliHistoryOutcome = 'ok' | 'blocked' | 'failed' | 'timeout';

export interface CliHistoryEntry {
  id: number;
  sourceId: string;
  timestamp: number;
  targetKind: 'local' | 'remote';
  targetPublicKey: string | null;
  targetName: string | null;
  origin: 'user' | 'vn';
  userId: number | null;
  username: string | null;
  command: string;
  outcome: CliHistoryOutcome;
  reply: string | null;
  error: string | null;
  elapsedMs: number | null;
  ipAddress: string | null;
}

export interface CliHistoryPage {
  entries: CliHistoryEntry[];
  nextBefore: number | null;
  /** Id of the oldest row on the page; send it back as `beforeId`. */
  nextBeforeId: number | null;
  /** Unified route only: the MeshCore sources the caller may read. */
  sources?: Array<{ id: string; name: string }>;
}

export interface CliHistoryFilters {
  limit?: number;
  before?: number | null;
  beforeId?: number | null;
  /** 'local', 'remote', or a 64-hex public key. */
  target?: string;
  user?: string;
  from?: number;
  to?: number;
  source?: string;
}

function queryString(filters: CliHistoryFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function getPage(url: string): Promise<CliHistoryPage> {
  const body = await apiService.get<{ success: boolean; data: CliHistoryPage }>(url);
  return body.data;
}

export function fetchSourceCliHistory(sourceId: string, filters: CliHistoryFilters): Promise<CliHistoryPage> {
  return getPage(`/api/sources/${encodeURIComponent(sourceId)}/meshcore/cli-history${queryString(filters)}`);
}

export function fetchUnifiedCliHistory(filters: CliHistoryFilters): Promise<CliHistoryPage> {
  return getPage(`/api/meshcore/cli-history${queryString(filters)}`);
}

/** Paging cursor: the oldest row seen so far. */
export interface CliHistoryCursor {
  before: number;
  beforeId: number;
}

/** The next page's cursor, or null on the last page. */
export function nextCliHistoryCursor(page: CliHistoryPage): CliHistoryCursor | null {
  return page.nextBefore !== null && page.nextBeforeId !== null
    ? { before: page.nextBefore, beforeId: page.nextBeforeId }
    : null;
}

/** Who sent a command, for display: a username, or a Virtual Node client. */
export function cliActorLabel(entry: CliHistoryEntry, vnLabel: string, unknownLabel: string): string {
  if (entry.origin === 'vn') return entry.ipAddress ? `${vnLabel} (${entry.ipAddress})` : vnLabel;
  return entry.username ?? unknownLabel;
}
