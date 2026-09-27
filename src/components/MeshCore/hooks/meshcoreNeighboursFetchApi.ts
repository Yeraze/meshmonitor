/**
 * Client calls for the paged neighbour fetch (#5413):
 *   POST /nodes/:publicKey/neighbours/fetch                      start
 *   GET  /nodes/:publicKey/neighbours/fetch/:requestId           progress
 *   POST /nodes/:publicKey/neighbours/fetch/:requestId/cancel    cancel
 *
 * Shared by useMeshCore (Contact Details) and MeshCoreNodeNeighboursConfig
 * (Poll Neighbours), which builds its own URLs from `baseUrl` + `sourceId`.
 */

import { parseJsonResponse } from '../../../utils/parseJsonResponse';
import { isTxDisabledBody } from '../../../utils/txDisabled';

export interface MeshCoreResolvedNeighbour {
  publicKeyPrefix: string;
  heardSecondsAgo: number;
  snr: number;
  name: string | null;
  fullPublicKey: string | null;
}

export type MeshCoreNeighboursFetchOutcome = 'complete' | 'capped' | 'cancelled' | 'failed';

/** Mirrors the server's NeighboursFetchSnapshot. */
export interface MeshCoreNeighboursFetchSnapshot {
  requestId: string;
  publicKey: string;
  phase: 'starting' | 'waiting' | 'requesting' | 'done';
  page: number;
  plannedPages: number;
  maxPages: number;
  total: number | null;
  pagesFetched: number;
  neighbours: MeshCoreResolvedNeighbour[];
  waitMs: number | null;
  waitRemainingMs: number | null;
  cancelRequested: boolean;
  outcome: MeshCoreNeighboursFetchOutcome | null;
  stored: 'replaced' | 'merged' | 'none' | null;
  written: number | null;
  error: string | null;
}

export type StartNeighboursFetchResponse =
  | { ok: true; requestId: string }
  | {
    ok: false;
    status: number;
    code?: string;
    error: string;
    /** Set when the caller's own fetch is already running on this source. */
    activeRequestId?: string | null;
    activePublicKey?: string | null;
    txDisabled?: boolean;
  };

export interface MeshCoreNeighboursFetchActions {
  startNeighboursFetch: (publicKey: string, requestId: string) => Promise<StartNeighboursFetchResponse>;
  getNeighboursFetchProgress: (publicKey: string, requestId: string) => Promise<MeshCoreNeighboursFetchSnapshot | null>;
  cancelNeighboursFetch: (publicKey: string, requestId: string) => Promise<boolean>;
}

type CsrfFetch = (url: string, options?: RequestInit) => Promise<Response>;

/** Build the three calls against `${base}/api/sources/:id/meshcore`. */
export function createNeighboursFetchActions(csrfFetch: CsrfFetch, mcPrefix: string): MeshCoreNeighboursFetchActions {
  const url = (publicKey: string, rest = '') =>
    `${mcPrefix}/nodes/${encodeURIComponent(publicKey)}/neighbours/fetch${rest}`;

  return {
    async startNeighboursFetch(publicKey, requestId) {
      try {
        const response = await csrfFetch(url(publicKey), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId }),
        });
        const data = await parseJsonResponse(response);
        if (response.ok && data.success) return { ok: true, requestId };
        return {
          ok: false,
          status: response.status,
          code: data.code,
          error: data.error || 'Neighbours fetch failed',
          activeRequestId: data.activeRequestId ?? null,
          activePublicKey: data.activePublicKey ?? null,
          txDisabled: isTxDisabledBody(response.status, data),
        };
      } catch (err) {
        return { ok: false, status: 0, error: err instanceof Error ? err.message : 'Network error' };
      }
    },

    async getNeighboursFetchProgress(publicKey, requestId) {
      try {
        const response = await csrfFetch(url(publicKey, `/${encodeURIComponent(requestId)}`));
        if (!response.ok) return null;
        const data = await parseJsonResponse(response);
        return data.success && data.data ? (data.data as MeshCoreNeighboursFetchSnapshot) : null;
      } catch {
        return null;
      }
    },

    async cancelNeighboursFetch(publicKey, requestId) {
      try {
        const response = await csrfFetch(url(publicKey, `/${encodeURIComponent(requestId)}/cancel`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await parseJsonResponse(response);
        return !!data.success;
      } catch {
        return false;
      }
    },
  };
}
