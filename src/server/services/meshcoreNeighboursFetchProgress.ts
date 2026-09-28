/**
 * In-flight paged neighbour fetches (#5413).
 *
 * A user-initiated neighbour fetch reads up to five pages, each spaced by the
 * shared 60 s mesh-TX floor, so it runs for minutes. The start route answers
 * at once; the fetch runs in the background and the UI polls this registry
 * for "page 2 of 4, 20 of 37 neighbours, next page in 42 s", the neighbours
 * gathered so far, and the final outcome. Cancel stops further pages.
 *
 * Mirrors the #5400 login-progress registry (meshcoreLoginProgress.ts): the
 * client picks the `requestId`, entries are bound to the user and source that
 * started them (anyone else gets "not found"), and state lives in memory only
 * because a fetch cannot outlive the process.
 *
 * One fetch per source at a time: pages from two fetches on one source would
 * only queue behind each other on the TX floor, doubling the wait for both.
 */

import type { NeighbourFetchOutcome } from './meshcoreNeighboursPaging.js';

export { isValidLoginRequestId as isValidNeighboursRequestId } from './meshcoreLoginProgress.js';

/** How long a finished fetch stays readable, so a remounted panel still sees it. */
export const NEIGHBOURS_FETCH_RETAIN_MS = 5 * 60_000;

/** Upper bound on tracked fetches. */
export const NEIGHBOURS_FETCH_MAX_ENTRIES = 200;

export interface ResolvedNeighbour {
  publicKeyPrefix: string;
  heardSecondsAgo: number;
  snr: number;
  name: string | null;
  fullPublicKey: string | null;
}

export type NeighboursFetchPhase = 'starting' | 'waiting' | 'requesting' | 'done';

/** What happened to the stored set when the fetch ended. */
export type NeighboursStoreAction = 'replaced' | 'merged' | 'none';

export type NeighboursFetchEvent =
  | { phase: 'waiting'; page: number; plannedPages: number; waitMs: number }
  | { phase: 'requesting'; page: number; plannedPages: number }
  | { phase: 'page'; page: number; plannedPages: number; total: number; neighbours: ResolvedNeighbour[] };

export interface NeighboursFetchSummary {
  outcome: NeighbourFetchOutcome;
  total: number | null;
  neighbours: ResolvedNeighbour[];
  pagesFetched: number;
  written: number;
  stored: NeighboursStoreAction;
  error?: string;
}

export interface NeighboursFetchSnapshot {
  requestId: string;
  publicKey: string;
  phase: NeighboursFetchPhase;
  /** Page being waited for or requested (1-based); 0 before the first. */
  page: number;
  /** Pages this fetch expects to read: the cap until the table size is known. */
  plannedPages: number;
  maxPages: number;
  /** Table size the repeater reported; null until the first page arrives. */
  total: number | null;
  pagesFetched: number;
  neighbours: ResolvedNeighbour[];
  waitMs: number | null;
  /** Time left in the current wait, computed server-side (no clock skew). */
  waitRemainingMs: number | null;
  cancelRequested: boolean;
  outcome: NeighbourFetchOutcome | null;
  stored: NeighboursStoreAction | null;
  written: number | null;
  error: string | null;
}

interface Entry {
  requestId: string;
  userId: number;
  sourceId: string;
  publicKey: string;
  phase: NeighboursFetchPhase;
  page: number;
  plannedPages: number;
  maxPages: number;
  total: number | null;
  pagesFetched: number;
  neighbours: ResolvedNeighbour[];
  waitMs: number | null;
  waitStartedAt: number | null;
  outcome: NeighbourFetchOutcome | null;
  stored: NeighboursStoreAction | null;
  written: number | null;
  error: string | null;
  controller: AbortController;
  expiry: ReturnType<typeof setTimeout> | null;
}

export interface NeighboursFetchHandle {
  signal: AbortSignal;
  onProgress: (event: NeighboursFetchEvent) => void;
  finish: (summary: NeighboursFetchSummary) => void;
}

export type StartNeighboursFetchResult =
  | { ok: true; handle: NeighboursFetchHandle }
  | { ok: false; reason: 'id-in-use' | 'busy' | 'full'; active?: { requestId: string; publicKey: string; mine: boolean } };

export class MeshCoreNeighboursFetchRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** The running (not finished) fetch on a source, if any. */
  activeForSource(sourceId: string): Entry | null {
    for (const entry of this.entries.values()) {
      if (entry.sourceId === sourceId && entry.phase !== 'done') return entry;
    }
    return null;
  }

  /**
   * Start tracking a fetch. Refuses when the id is taken, another fetch is
   * running on this source (`active` says whose, so the owner can re-attach),
   * or the registry is full of live fetches.
   */
  start(
    requestId: string,
    userId: number,
    sourceId: string,
    publicKey: string,
    maxPages: number,
  ): StartNeighboursFetchResult {
    if (this.entries.has(requestId)) return { ok: false, reason: 'id-in-use' };
    const active = this.activeForSource(sourceId);
    if (active) {
      const mine = active.userId === userId;
      return {
        ok: false,
        reason: 'busy',
        // Only the owner learns the id: it is the key to read and cancel.
        active: { requestId: mine ? active.requestId : '', publicKey: active.publicKey, mine },
      };
    }
    if (this.entries.size >= NEIGHBOURS_FETCH_MAX_ENTRIES && !this.evictOneFinished()) {
      return { ok: false, reason: 'full' };
    }

    const entry: Entry = {
      requestId,
      userId,
      sourceId,
      publicKey,
      phase: 'starting',
      page: 0,
      plannedPages: maxPages,
      maxPages,
      total: null,
      pagesFetched: 0,
      neighbours: [],
      waitMs: null,
      waitStartedAt: null,
      outcome: null,
      stored: null,
      written: null,
      error: null,
      controller: new AbortController(),
      expiry: null,
    };
    this.entries.set(requestId, entry);

    return {
      ok: true,
      handle: {
        signal: entry.controller.signal,
        onProgress: (event) => {
          if (entry.phase === 'done') return;
          entry.page = event.page;
          entry.plannedPages = event.plannedPages;
          if (event.phase === 'waiting') {
            entry.phase = 'waiting';
            entry.waitMs = event.waitMs;
            entry.waitStartedAt = this.now();
          } else if (event.phase === 'requesting') {
            entry.phase = 'requesting';
            entry.waitMs = null;
            entry.waitStartedAt = null;
          } else {
            entry.total = event.total;
            entry.pagesFetched = event.page;
            entry.neighbours = event.neighbours;
          }
        },
        finish: (summary) => {
          if (entry.phase === 'done') return;
          entry.phase = 'done';
          entry.outcome = summary.outcome;
          entry.total = summary.total;
          entry.pagesFetched = summary.pagesFetched;
          entry.neighbours = summary.neighbours;
          entry.stored = summary.stored;
          entry.written = summary.written;
          entry.error = summary.error ?? null;
          entry.waitMs = null;
          entry.waitStartedAt = null;
          entry.expiry = setTimeout(() => {
            if (this.entries.get(requestId) === entry) this.entries.delete(requestId);
          }, NEIGHBOURS_FETCH_RETAIN_MS);
          entry.expiry.unref?.();
        },
      },
    };
  }

  /** Snapshot for its owner, or null (unknown id, other user, other source). */
  get(requestId: string, userId: number, sourceId: string): NeighboursFetchSnapshot | null {
    const entry = this.ownedEntry(requestId, userId, sourceId);
    if (!entry) return null;
    let waitRemainingMs: number | null = null;
    if (entry.waitMs !== null && entry.waitStartedAt !== null) {
      waitRemainingMs = Math.max(0, entry.waitMs - (this.now() - entry.waitStartedAt));
    }
    return {
      requestId: entry.requestId,
      publicKey: entry.publicKey,
      phase: entry.phase,
      page: entry.page,
      plannedPages: entry.plannedPages,
      maxPages: entry.maxPages,
      total: entry.total,
      pagesFetched: entry.pagesFetched,
      neighbours: entry.neighbours,
      waitMs: entry.waitMs,
      waitRemainingMs,
      cancelRequested: entry.controller.signal.aborted,
      outcome: entry.outcome,
      stored: entry.stored,
      written: entry.written,
      error: entry.error,
    };
  }

  /** Ask a fetch to stop after the page in flight. True when the caller owns it. */
  cancel(requestId: string, userId: number, sourceId: string): boolean {
    const entry = this.ownedEntry(requestId, userId, sourceId);
    if (!entry) return false;
    if (entry.phase !== 'done') entry.controller.abort();
    return true;
  }

  /** Test hook: forget everything and stop expiry timers. */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.expiry) clearTimeout(entry.expiry);
      if (entry.phase !== 'done') entry.controller.abort();
    }
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private ownedEntry(requestId: string, userId: number, sourceId: string): Entry | null {
    const entry = this.entries.get(requestId);
    if (!entry || entry.userId !== userId || entry.sourceId !== sourceId) return null;
    return entry;
  }

  private evictOneFinished(): boolean {
    for (const [id, entry] of this.entries) {
      if (entry.phase === 'done') {
        if (entry.expiry) clearTimeout(entry.expiry);
        this.entries.delete(id);
        return true;
      }
    }
    return false;
  }
}

let singleton: MeshCoreNeighboursFetchRegistry | null = null;

export function getMeshCoreNeighboursFetchRegistry(): MeshCoreNeighboursFetchRegistry {
  if (!singleton) singleton = new MeshCoreNeighboursFetchRegistry();
  return singleton;
}
