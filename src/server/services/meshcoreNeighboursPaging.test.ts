/**
 * Paged neighbour fetch (#5413): a repeater reply holds at most 10 entries
 * with our 8-byte prefix, so a table is read page by page, each page waiting
 * the shared 60 s mesh-TX floor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchNeighbourPages,
  mergeNeighbourRows,
  plannedPageCount,
  NEIGHBOURS_PAGE_SIZE,
  type NeighbourPagingManager,
  type NeighbourFetchProgressEvent,
  type RawNeighbour,
} from './meshcoreNeighboursPaging.js';

const FLOOR = 60_000;
const KEY = 'a'.repeat(64);

function table(n: number): RawNeighbour[] {
  return Array.from({ length: n }, (_, i) => ({
    publicKeyPrefix: `p${String(i).padStart(3, '0')}`,
    heardSecondsAgo: i * 10,
    snr: 10 - i / 10,
  }));
}

interface Call { offset: number; count: number; orderBy: number; skipLogin?: boolean; at: number }

/** A fake manager whose repeater answers from `rows`, 10 per page. */
function fakeManager(rows: RawNeighbour[], opts: { failPage?: number; shiftOnPage?: number } = {}) {
  let lastTx = 0;
  const calls: Call[] = [];
  const stamps: number[] = [];
  const m: NeighbourPagingManager = {
    getLastMeshTxAt: () => lastTx,
    recordMeshTx: (when = Date.now()) => {
      lastTx = when;
      stamps.push(when);
    },
    getNeighbours: vi.fn(async (_pk, o) => {
      calls.push({ ...o, at: Date.now() });
      if (opts.failPage === calls.length) return null;
      let src = rows;
      // Simulate the repeater re-sorting between requests: the last entry is
      // heard again and jumps to the front of "newest first", pushing every
      // other entry down one place.
      if (opts.shiftOnPage !== undefined && calls.length >= opts.shiftOnPage) {
        src = [rows[rows.length - 1], ...rows.slice(0, -1)];
      }
      return { total: rows.length, neighbours: src.slice(o.offset, o.offset + Math.min(o.count, NEIGHBOURS_PAGE_SIZE)) };
    }),
  };
  return { m, calls, stamps, setLastTx: (v: number) => { lastTx = v; } };
}

describe('fetchNeighbourPages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads a 37-entry table in 4 pages, each waiting the 60 s floor, logging in once', async () => {
    const { m, calls, stamps } = fakeManager(table(37));
    const events: NeighbourFetchProgressEvent[] = [];
    const p = fetchNeighbourPages(m, KEY, { maxPages: 5, orderBy: 0, minIntervalMs: FLOOR, onProgress: (e) => events.push(e) });

    // Page 1 goes at once: nothing has transmitted on this source yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    for (let page = 2; page <= 4; page++) {
      await vi.advanceTimersByTimeAsync(FLOOR - 1);
      expect(calls).toHaveLength(page - 1); // not a millisecond early
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(page);
    }
    const result = await p;

    expect(result.outcome).toBe('complete');
    expect(result.total).toBe(37);
    expect(result.pagesFetched).toBe(4);
    expect(result.neighbours).toHaveLength(37);
    expect(calls.map((c) => c.offset)).toEqual([0, 10, 20, 30]);
    expect(calls.every((c) => c.count === 10 && c.orderBy === 0)).toBe(true);
    expect(calls.map((c) => !!c.skipLogin)).toEqual([false, true, true, true]);
    // Each page stamped the shared floor, 60 s apart.
    expect(stamps.map((s) => s - stamps[0])).toEqual([0, FLOOR, 2 * FLOOR, 3 * FLOOR]);
    // Progress: the plan shrinks from the 5-page cap to 4 once the size is known.
    const pages = events.filter((e) => e.phase === 'page');
    expect(pages.map((e) => (e as { neighbours: unknown[] }).neighbours.length)).toEqual([10, 20, 30, 37]);
    expect(events.find((e) => e.phase === 'waiting')).toMatchObject({ page: 2, plannedPages: 4, waitMs: FLOOR });
  });

  it('waits out a transmission another feature made just before page 1', async () => {
    const { m, calls, setLastTx } = fakeManager(table(5));
    setLastTx(Date.now() - 20_000);
    const p = fetchNeighbourPages(m, KEY, { maxPages: 5, orderBy: 0, minIntervalMs: FLOOR });
    await vi.advanceTimersByTimeAsync(39_999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect((await p).outcome).toBe('complete');
  });

  it('re-waits when another sender claims the slot during the wait', async () => {
    const { m, calls, setLastTx } = fakeManager(table(15));
    const p = fetchNeighbourPages(m, KEY, { maxPages: 5, orderBy: 0, minIntervalMs: FLOOR });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    setLastTx(Date.now()); // e.g. the telemetry scheduler transmitted
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(2);
    expect((await p).neighbours).toHaveLength(15);
  });

  it('dedupes by prefix when the repeater re-sorts between pages', async () => {
    const { m, calls } = fakeManager(table(25), { shiftOnPage: 2 });
    const p = fetchNeighbourPages(m, KEY, { maxPages: 5, orderBy: 0, minIntervalMs: FLOOR });
    await vi.advanceTimersByTimeAsync(5 * FLOOR);
    const result = await p;
    const prefixes = result.neighbours.map((n) => n.publicKeyPrefix);
    // Page 2 repeats page 1's last entry; it is merged, not listed twice.
    expect(new Set(prefixes).size).toBe(prefixes.length);
    // The entry that jumped into already-read territory is missed this time;
    // the walk still ends once the offset passes the table size, instead of
    // spending a fourth exchange on an empty page.
    expect(result.neighbours).toHaveLength(24);
    expect(calls).toHaveLength(3);
    expect(result.outcome).toBe('complete');
  });

  it('automated mode: one page, strongest first, no wait when the caller reserved the slot', async () => {
    const { m, calls, stamps, setLastTx } = fakeManager(table(37));
    setLastTx(Date.now()); // the scheduler stamped just before calling
    const result = await fetchNeighbourPages(m, KEY, { maxPages: 1, orderBy: 2, minIntervalMs: FLOOR, firstSlotReserved: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ offset: 0, orderBy: 2 });
    expect(stamps).toHaveLength(0); // the caller's stamp stands
    expect(result).toMatchObject({ outcome: 'capped', total: 37, pagesFetched: 1 });
    expect(result.neighbours).toHaveLength(10);
  });

  it('stops at the page cap', async () => {
    const { m, calls } = fakeManager(table(80));
    const p = fetchNeighbourPages(m, KEY, { maxPages: 5, orderBy: 0, minIntervalMs: FLOOR });
    await vi.advanceTimersByTimeAsync(10 * FLOOR);
    const result = await p;
    expect(calls).toHaveLength(5);
    expect(result).toMatchObject({ outcome: 'capped', total: 80 });
    expect(result.neighbours).toHaveLength(50);
  });

  it('stops on an empty page', async () => {
    const m: NeighbourPagingManager = {
      getLastMeshTxAt: () => 0,
      recordMeshTx: () => {},
      getNeighbours: vi.fn(async () => ({ total: 12, neighbours: [] })),
    };
    const result = await fetchNeighbourPages(m, KEY, { maxPages: 5, orderBy: 0, minIntervalMs: FLOOR });
    expect(result).toMatchObject({ outcome: 'complete', pagesFetched: 1, total: 12 });
  });

  it('cancel during the wait stops further pages and keeps what arrived', async () => {
    const { m, calls } = fakeManager(table(37));
    const ctrl = new AbortController();
    const p = fetchNeighbourPages(m, KEY, { maxPages: 5, orderBy: 0, minIntervalMs: FLOOR, signal: ctrl.signal });
    await vi.advanceTimersByTimeAsync(FLOOR); // page 2 sent
    await vi.advanceTimersByTimeAsync(10_000);
    ctrl.abort();
    const result = await p;
    await vi.advanceTimersByTimeAsync(10 * FLOOR);
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ outcome: 'cancelled', pagesFetched: 2, total: 37 });
    expect(result.neighbours).toHaveLength(20);
  });

  it('a page with no reply ends the fetch as failed with the earlier pages', async () => {
    const { m, calls } = fakeManager(table(37), { failPage: 3 });
    const p = fetchNeighbourPages(m, KEY, { maxPages: 5, orderBy: 0, minIntervalMs: FLOOR });
    await vi.advanceTimersByTimeAsync(5 * FLOOR);
    const result = await p;
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ outcome: 'failed', pagesFetched: 2, total: 37 });
    expect(result.neighbours).toHaveLength(20);
  });

  it('a page that throws (e.g. receive-only switched on) ends as failed, never throws', async () => {
    const m: NeighbourPagingManager = {
      getLastMeshTxAt: () => 0,
      recordMeshTx: () => {},
      getNeighbours: vi.fn(async () => { throw new Error('tx disabled'); }),
    };
    const result = await fetchNeighbourPages(m, KEY, { maxPages: 5, orderBy: 0, minIntervalMs: FLOOR });
    expect(result).toMatchObject({ outcome: 'failed', error: 'tx disabled', total: null });
  });
});

describe('plannedPageCount', () => {
  it('uses the cap until the size is known, then ceil(total/10) within the cap', () => {
    expect(plannedPageCount(null, 5)).toBe(5);
    expect(plannedPageCount(37, 5)).toBe(4);
    expect(plannedPageCount(3, 5)).toBe(1);
    expect(plannedPageCount(200, 5)).toBe(5);
  });
});

describe('mergeNeighbourRows', () => {
  const now = 1_000_000_000;
  const stored = (k: string, heard: number, ageMs = 60_000) => ({
    neighborPublicKey: k,
    snr: 1,
    lastHeardSecs: heard,
    timestamp: now - ageMs,
  });

  it('keeps stored rows the partial read did not see, aged forward to now', () => {
    const rows = mergeNeighbourRows(
      [{ neighborPublicKey: 'A', snr: 9, lastHeardSecs: 5 }],
      [stored('A', 100), stored('B', 30), stored('C', 10)],
      3,
      1,
      now,
    );
    expect(rows).toEqual([
      { neighborPublicKey: 'A', snr: 9, lastHeardSecs: 5 },
      { neighborPublicKey: 'C', snr: 1, lastHeardSecs: 70 },
      { neighborPublicKey: 'B', snr: 1, lastHeardSecs: 90 },
    ]);
  });

  it('trims carried rows to the table size, most recently heard first', () => {
    const rows = mergeNeighbourRows(
      [{ neighborPublicKey: 'A', snr: 9, lastHeardSecs: 5 }],
      [stored('B', 300), stored('C', 10), stored('D', 50)],
      3, // table holds 3: A + two carried
      1,
      now,
    );
    expect(rows.map((r) => r.neighborPublicKey)).toEqual(['A', 'C', 'D']);
  });

  it('counts unresolved entries against the table size', () => {
    const rows = mergeNeighbourRows(
      [{ neighborPublicKey: 'A', snr: 9, lastHeardSecs: 5 }],
      [stored('B', 10), stored('C', 20)],
      3,
      2, // two entries arrived, one could not be resolved to a contact
      now,
    );
    expect(rows.map((r) => r.neighborPublicKey)).toEqual(['A', 'B']);
  });
});
