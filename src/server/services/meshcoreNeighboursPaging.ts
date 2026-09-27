/**
 * Paged MeshCore neighbour-table fetch (#5413).
 *
 * A repeater answers REQ_TYPE_GET_NEIGHBOURS (firmware
 * examples/simple_repeater/MyMesh.cpp) by packing entries into a 130-byte
 * results buffer. Each entry is prefix_len + 4 (heard age) + 1 (SNR) bytes,
 * and the loop stops when the buffer is full. With our 8-byte prefix that is
 * 13 bytes an entry, so ONE reply carries at most 10 entries whatever `count`
 * we ask for. The reply also carries the full table size (`total`), so the
 * only way to read a larger table is to walk it with `offset`.
 *
 * Every page is a request/reply pair on the air, so each one waits the
 * shared per-source 60 s mesh-TX floor (`MeshCoreManager.lastMeshTxAt`,
 * #4618) and stamps it before it sends. A full manual fetch of a 50-entry
 * table (MAX_NEIGHBOURS) is five pages and takes four to five minutes.
 *
 * The repeater rebuilds its sort for each request, so an entry can move
 * between pages (a neighbour heard again jumps to the front of "newest").
 * Pages are therefore merged by prefix, first sighting wins.
 *
 * The session: a repeater keeps a logged-in client in its ACL until the
 * table fills and it evicts the least-recently-active non-admin entry
 * (helpers/ClientACL.cpp putClient); there is no idle timeout. So one login
 * before page 1 covers the whole fetch, and later pages skip it.
 */

/**
 * The shared per-source mesh-TX floor (#4618). The neighbours scheduler's
 * MIN_INTERVAL_BETWEEN_REQUESTS_MS is this same value.
 */
export const MESH_TX_FLOOR_MS = 60_000;

/** Most entries one reply can hold with the 8-byte prefix (130 / 13). */
export const NEIGHBOURS_PAGE_SIZE = 10;

/** Page cap for a user-initiated fetch: the firmware's 50-entry table. */
export const MANUAL_NEIGHBOURS_MAX_PAGES = 5;

/** Page cap for automated fetches (autopoll scheduler, auto-pathfinding). */
export const AUTOMATED_NEIGHBOURS_MAX_PAGES = 1;

/** order_by values the firmware understands. */
export const NEIGHBOURS_ORDER_NEWEST = 0;
export const NEIGHBOURS_ORDER_STRONGEST = 2;

export interface RawNeighbour {
  publicKeyPrefix: string;
  heardSecondsAgo: number;
  snr: number;
}

export interface NeighbourPage {
  total: number;
  neighbours: RawNeighbour[];
}

/** The slice of MeshCoreManager the pager needs (kept thin for tests). */
export interface NeighbourPagingManager {
  getLastMeshTxAt(): number;
  recordMeshTx(when?: number): void;
  getNeighbours(
    publicKey: string,
    opts: { count: number; offset: number; orderBy: number; skipLogin?: boolean },
  ): Promise<NeighbourPage | null>;
}

export type NeighbourFetchProgressEvent =
  | { phase: 'waiting'; page: number; plannedPages: number; waitMs: number }
  | { phase: 'requesting'; page: number; plannedPages: number }
  | { phase: 'page'; page: number; plannedPages: number; total: number; neighbours: RawNeighbour[] };

/**
 * How a fetch ended.
 *  - complete: we hold the whole table (collected >= total, or an empty page).
 *  - capped:   the page cap stopped us before the end of the table.
 *  - cancelled: the user stopped it.
 *  - failed:   a page got no reply (or threw).
 */
export type NeighbourFetchOutcome = 'complete' | 'capped' | 'cancelled' | 'failed';

export interface NeighbourFetchResult {
  outcome: NeighbourFetchOutcome;
  /** Table size the repeater last reported; null when no page arrived. */
  total: number | null;
  /** Merged, de-duplicated entries in the order first seen. */
  neighbours: RawNeighbour[];
  pagesFetched: number;
  error?: string;
}

export interface FetchNeighbourPagesOptions {
  maxPages: number;
  orderBy: number;
  /** Floor between any two mesh transmissions on this source (ms). */
  minIntervalMs: number;
  /**
   * The caller already stamped `lastMeshTxAt` for page 1 (the scheduler
   * does this before it calls in), so page 1 must not wait the floor again.
   */
  firstSlotReserved?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: NeighbourFetchProgressEvent) => void;
  now?: () => number;
  /** Abortable sleep; resolves false when aborted. Injected by tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Pages needed for a table of `total`, within the cap (at least 1). */
export function plannedPageCount(total: number | null, maxPages: number): number {
  if (total === null || total <= 0) return maxPages;
  return Math.max(1, Math.min(maxPages, Math.ceil(total / NEIGHBOURS_PAGE_SIZE)));
}

/**
 * Walk the neighbour table page by page. Never throws: a thrown page becomes
 * `outcome: 'failed'` with whatever arrived before it.
 */
export async function fetchNeighbourPages(
  manager: NeighbourPagingManager,
  publicKey: string,
  opts: FetchNeighbourPagesOptions,
): Promise<NeighbourFetchResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const maxPages = Math.max(1, Math.floor(opts.maxPages));
  const seen = new Map<string, RawNeighbour>();
  let total: number | null = null;
  let offset = 0;
  let pagesFetched = 0;

  const result = (outcome: NeighbourFetchOutcome, error?: string): NeighbourFetchResult => ({
    outcome,
    total,
    neighbours: [...seen.values()],
    pagesFetched,
    ...(error ? { error } : {}),
  });

  for (let page = 1; page <= maxPages; page++) {
    const planned = plannedPageCount(total, maxPages);
    if (opts.signal?.aborted) return result('cancelled');

    // Wait the shared floor, then claim the slot. The check and the stamp run
    // in the same tick, so two waiters on one source cannot both send.
    if (!(page === 1 && opts.firstSlotReserved)) {
      for (;;) {
        const last = manager.getLastMeshTxAt();
        const waitMs = last > 0 ? opts.minIntervalMs - (now() - last) : 0;
        if (waitMs <= 0) break;
        opts.onProgress?.({ phase: 'waiting', page, plannedPages: planned, waitMs });
        if (!(await sleep(waitMs, opts.signal))) return result('cancelled');
      }
      manager.recordMeshTx(now());
    }

    opts.onProgress?.({ phase: 'requesting', page, plannedPages: planned });
    let reply: NeighbourPage | null;
    try {
      reply = await manager.getNeighbours(publicKey, {
        count: NEIGHBOURS_PAGE_SIZE,
        offset,
        orderBy: opts.orderBy,
        // One login per fetch: the ACL entry outlives the fetch (see header).
        skipLogin: page > 1,
      });
    } catch (err) {
      return result('failed', err instanceof Error ? err.message : String(err));
    }
    if (!reply) return result('failed', `no reply to page ${page}`);

    pagesFetched++;
    total = reply.total;
    for (const n of reply.neighbours) {
      if (!seen.has(n.publicKeyPrefix)) seen.set(n.publicKeyPrefix, n);
    }
    offset += reply.neighbours.length;
    opts.onProgress?.({
      phase: 'page',
      page,
      plannedPages: plannedPageCount(total, maxPages),
      total,
      neighbours: [...seen.values()],
    });

    if (reply.neighbours.length === 0 || seen.size >= total || offset >= total) {
      return result('complete');
    }
  }
  return result('capped');
}

// ---------------------------------------------------------------------------
// Storage policy
// ---------------------------------------------------------------------------

export interface StoredNeighbour {
  neighborPublicKey: string;
  snr: number | null;
  lastHeardSecs: number | null;
  /** When we stored it (ms); `lastHeardSecs` is the age as of this time. */
  timestamp: number;
}

export interface NeighbourRow {
  neighborPublicKey: string;
  snr: number | null;
  lastHeardSecs: number | null;
}

/**
 * Rows to write when a fetch did NOT read the whole table (scheduler page,
 * cap, cancel, or failure part-way).
 *
 * A partial read must not wipe a fuller stored set, and the autopoll's one
 * strongest-first page must not undo a manual 5-page fetch. So we merge:
 * fresh rows win, stored rows for other neighbours stay with their heard age
 * moved forward to `nowMs` (the UI adds time since `timestamp` to
 * `lastHeardSecs`, and every row gets a new timestamp on write). The table
 * holds `total` entries and this fetch saw `collectedCount` of them (some may
 * not resolve to a known contact, so `fresh` can be shorter), so at most
 * `total - collectedCount` old rows survive, most recently heard first.
 */
export function mergeNeighbourRows(
  fresh: NeighbourRow[],
  stored: StoredNeighbour[],
  total: number | null,
  collectedCount: number,
  nowMs: number,
): NeighbourRow[] {
  const freshKeys = new Set(fresh.map((r) => r.neighborPublicKey));
  const carried = stored
    .filter((r) => !freshKeys.has(r.neighborPublicKey))
    .map((r) => ({
      neighborPublicKey: r.neighborPublicKey,
      snr: r.snr,
      lastHeardSecs: r.lastHeardSecs === null
        ? null
        : r.lastHeardSecs + Math.max(0, Math.floor((nowMs - r.timestamp) / 1000)),
    }))
    .sort((a, b) => (a.lastHeardSecs ?? Infinity) - (b.lastHeardSecs ?? Infinity));
  const room = total === null ? carried.length : Math.max(0, total - Math.max(collectedCount, fresh.length));
  return [...fresh, ...carried.slice(0, room)];
}
