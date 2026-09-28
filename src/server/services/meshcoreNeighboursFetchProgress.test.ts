/**
 * MeshCoreNeighboursFetchRegistry (#5413): in-memory progress for paged
 * neighbour fetches, private to the user + source that started them, one
 * running fetch per source.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MeshCoreNeighboursFetchRegistry,
  NEIGHBOURS_FETCH_RETAIN_MS,
  type NeighboursFetchHandle,
} from './meshcoreNeighboursFetchProgress.js';

const PK = 'b'.repeat(64);
const n = (i: number) => ({ publicKeyPrefix: `p${i}`, heardSecondsAgo: i, snr: 1, name: null, fullPublicKey: null });

describe('MeshCoreNeighboursFetchRegistry', () => {
  let now = 1_000_000;
  let reg: MeshCoreNeighboursFetchRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    reg = new MeshCoreNeighboursFetchRegistry({ now: () => now });
  });
  afterEach(() => {
    reg.clear();
    vi.useRealTimers();
  });

  function start(id = 'req-aaaaaaaa', user = 1, source = 'src'): NeighboursFetchHandle {
    const r = reg.start(id, user, source, PK, 5);
    if (!r.ok) throw new Error(r.reason);
    return r.handle;
  }

  it('reports each state: starting, waiting with countdown, requesting, pages, done', () => {
    const h = start();
    expect(reg.get('req-aaaaaaaa', 1, 'src')).toMatchObject({ phase: 'starting', page: 0, plannedPages: 5, total: null });

    h.onProgress({ phase: 'requesting', page: 1, plannedPages: 5 });
    h.onProgress({ phase: 'page', page: 1, plannedPages: 4, total: 37, neighbours: [n(1), n(2)] });
    expect(reg.get('req-aaaaaaaa', 1, 'src')).toMatchObject({ phase: 'requesting', total: 37, pagesFetched: 1, plannedPages: 4 });

    h.onProgress({ phase: 'waiting', page: 2, plannedPages: 4, waitMs: 60_000 });
    now += 18_000;
    expect(reg.get('req-aaaaaaaa', 1, 'src')).toMatchObject({ phase: 'waiting', page: 2, waitMs: 60_000, waitRemainingMs: 42_000 });
    expect(reg.get('req-aaaaaaaa', 1, 'src')!.neighbours).toHaveLength(2);

    h.finish({ outcome: 'complete', total: 37, neighbours: [n(1)], pagesFetched: 4, written: 30, stored: 'replaced' });
    expect(reg.get('req-aaaaaaaa', 1, 'src')).toMatchObject({
      phase: 'done', outcome: 'complete', stored: 'replaced', written: 30, waitRemainingMs: null,
    });
  });

  it('is private to the owner and source', () => {
    start();
    expect(reg.get('req-aaaaaaaa', 2, 'src')).toBeNull();
    expect(reg.get('req-aaaaaaaa', 1, 'other')).toBeNull();
    expect(reg.cancel('req-aaaaaaaa', 2, 'src')).toBe(false);
  });

  it('cancel aborts the signal and shows up in the snapshot', () => {
    const h = start();
    expect(reg.cancel('req-aaaaaaaa', 1, 'src')).toBe(true);
    expect(h.signal.aborted).toBe(true);
    expect(reg.get('req-aaaaaaaa', 1, 'src')!.cancelRequested).toBe(true);
  });

  it('allows one running fetch per source; only the owner learns its id', () => {
    start('req-aaaaaaaa', 1, 'src');
    expect(reg.start('req-bbbbbbbb', 1, 'src', PK, 5)).toMatchObject({
      ok: false, reason: 'busy', active: { requestId: 'req-aaaaaaaa', publicKey: PK, mine: true },
    });
    expect(reg.start('req-cccccccc', 2, 'src', PK, 5)).toMatchObject({
      ok: false, reason: 'busy', active: { requestId: '', mine: false },
    });
    // Other sources are independent.
    expect(reg.start('req-dddddddd', 1, 'src2', PK, 5).ok).toBe(true);
    expect(reg.start('req-aaaaaaaa', 1, 'src3', PK, 5)).toMatchObject({ ok: false, reason: 'id-in-use' });
  });

  it('frees the source when a fetch finishes and forgets it after the retain window', () => {
    const h = start();
    h.finish({ outcome: 'cancelled', total: 37, neighbours: [], pagesFetched: 2, written: 0, stored: 'merged' });
    expect(reg.start('req-bbbbbbbb', 1, 'src', PK, 5).ok).toBe(true);
    vi.advanceTimersByTime(NEIGHBOURS_FETCH_RETAIN_MS);
    expect(reg.get('req-aaaaaaaa', 1, 'src')).toBeNull();
  });
});
