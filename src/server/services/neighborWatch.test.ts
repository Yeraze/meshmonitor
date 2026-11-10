/**
 * #6274: confirmed new-neighbour tracker. The pure planner, the adapter over a
 * real repository (so persistence, event emission and "restart" are exercised),
 * and the manager call sites' `complete` flag.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  planNeighborWatch,
  observeNeighbours,
  STALE_MS,
  NO_SIGHTING_MS,
  MAX_CONFIRM_MS,
  PRUNE_MS,
  REFRESH_MS,
  type FreshNeighbour,
} from './neighborWatch.js';
import type { MeshCoreNeighborWatchRow } from '../../db/repositories/meshcore.js';
import { MeshCoreRepository } from '../../db/repositories/meshcore.js';
import { dataEventEmitter, type DataEvent, type NeighborSightingData } from './dataEventEmitter.js';
import { createTestDb } from '../test-helpers/testDb.js';

const H = 3_600_000;
const T0 = 1_800_000_000_000;
const N = (c: string) => c.repeat(64);
const row = (k: string, over: Partial<MeshCoreNeighborWatchRow> = {}): MeshCoreNeighborWatchRow => ({
  neighborPublicKey: k, state: 'pending', firstSeenAt: T0, lastHeardAt: T0, lastSnr: 3, sightings: 1, ...over,
});
const fresh = (k: string, ageS: number | null = 0, snr: number | null = 5): FreshNeighbour => ({ neighborKey: k, heardSecondsAgo: ageS, snr });
const plan = (prev: MeshCoreNeighborWatchRow[], f: FreshNeighbour[], over: Partial<{ pollAtMs: number; complete: boolean; baselined: boolean }> = {}) =>
  planNeighborWatch(prev, f, { pollAtMs: T0, complete: true, baselined: true, ...over });

describe('planNeighborWatch', () => {
  it('first evaluation baselines everything and emits nothing (also with an empty table)', () => {
    const p = plan([], [fresh('a', 10), fresh('b', 20)], { baselined: false });
    expect(p.upserts.map((u) => [u.neighborPublicKey, u.state])).toEqual([['a', 'baseline'], ['b', 'baseline']]);
    expect(p.events).toEqual([]);
    const empty = plan([], [], { baselined: false });
    expect(empty).toEqual({ upserts: [], deletes: [], events: [] });
  });

  it('an unknown key becomes pending, backdated by its reported age, with no event', () => {
    const p = plan([], [fresh('a', 600, 7)]);
    expect(p.upserts).toEqual([row('a', { firstSeenAt: T0 - 600_000, lastHeardAt: T0 - 600_000, lastSnr: 7 })]);
    expect(p.events).toEqual([]);
  });

  it('a new sighting of a pending key emits with prev and new last-heard', () => {
    const prev = row('a', { firstSeenAt: T0 - 71 * H, lastHeardAt: T0 - 71 * H });
    const p = plan([prev], [fresh('a', 0, 9)]);
    expect(p.events).toEqual([
      { neighborPublicKey: 'a', firstSeenAt: T0 - 71 * H, prevLastHeardAt: T0 - 71 * H, lastHeardAt: T0, snr: 9, sightings: 2 },
    ]);
    expect(p.upserts[0]).toMatchObject({ state: 'pending', lastHeardAt: T0, sightings: 2, lastSnr: 9 });
  });

  it('the same observation again (age grows with time) is not a sighting and writes nothing', () => {
    const prev = row('a', { lastHeardAt: T0 - 300_000, firstSeenAt: T0 - 5 * H });
    const p = plan([prev], [fresh('a', 300)]);
    expect(p.events).toEqual([]);
    expect(p.upserts).toEqual([]);
  });

  it('absence from a partial read keeps a pending row; from a complete read discards it', () => {
    const prev = row('a', { lastHeardAt: T0 - H });
    expect(plan([prev], [], { complete: false })).toEqual({ upserts: [], deletes: [], events: [] });
    expect(plan([prev], [], { complete: true }).deletes).toEqual(['a']);
  });

  it('a partial read still discards a pending row with no sighting for 7 days', () => {
    const prev = row('a', { lastHeardAt: T0 - NO_SIGHTING_MS - 1 });
    expect(plan([prev], [], { complete: false }).deletes).toEqual(['a']);
  });

  it('a returned row older than the stale limit drops a pending key and creates nothing', () => {
    const prev = row('a');
    const p = plan([prev], [fresh('a', STALE_MS / 1000 + 1), fresh('new', STALE_MS / 1000 + 1)]);
    expect(p.deletes).toEqual(['a']);
    expect(p.upserts).toEqual([]);
    expect(p.events).toEqual([]);
  });

  it('a forward clock step on the reporter (huge ages) only discards, never alerts', () => {
    const prev = row('a', { firstSeenAt: T0 - 100 * H, lastHeardAt: T0 - 100 * H });
    const p = plan([prev], [fresh('a', 40 * 3600)]);
    expect(p.events).toEqual([]);
    expect(p.deletes).toEqual(['a']);
  });

  it('a gap longer than 7 days restarts the episode instead of confirming across it', () => {
    const prev = row('a', { firstSeenAt: T0 - 20 * 24 * H, lastHeardAt: T0 - NO_SIGHTING_MS - H });
    const p = plan([prev], [fresh('a', 0)]);
    expect(p.events).toEqual([]);
    expect(p.upserts).toEqual([row('a', { firstSeenAt: T0, lastHeardAt: T0, lastSnr: 5, sightings: 1 })]);
  });

  it('14 days of pending becomes confirmed (the crossing sighting still emits), then no more events', () => {
    const prev = row('a', { firstSeenAt: T0 - MAX_CONFIRM_MS, lastHeardAt: T0 - 5 * 60_000 });
    const p1 = plan([prev], [fresh('a', 0)]);
    expect(p1.events).toHaveLength(1);
    expect(p1.upserts[0].state).toBe('confirmed');
    const confirmed = { ...p1.upserts[0] };
    const p2 = plan([confirmed], [fresh('a', 0)], { pollAtMs: T0 + 10 * 60_000 });
    expect(p2.events).toEqual([]);
  });

  it('baseline and confirmed rows refresh at most hourly and never emit', () => {
    const base = row('a', { state: 'baseline', lastHeardAt: T0 - 10 * 60_000 });
    expect(plan([base], [fresh('a', 0)])).toEqual({ upserts: [], deletes: [], events: [] });
    const old = row('a', { state: 'baseline', lastHeardAt: T0 - REFRESH_MS });
    const p = plan([old], [fresh('a', 0)]);
    expect(p.events).toEqual([]);
    expect(p.upserts[0]).toMatchObject({ state: 'baseline', lastHeardAt: T0 });
  });

  it('baseline rows missing from a complete read stay; they prune after 30 days', () => {
    const base = row('a', { state: 'baseline', lastHeardAt: T0 - 5 * 24 * H });
    expect(plan([base], [], { complete: true }).deletes).toEqual([]);
    const gone = row('b', { state: 'confirmed', lastHeardAt: T0 - PRUNE_MS - 1 });
    expect(plan([gone], [], { complete: false }).deletes).toEqual(['b']);
  });

  it('a baseline neighbour returning after the prune window counts as new (pending)', () => {
    const gone = row('a', { state: 'baseline', lastHeardAt: T0 - PRUNE_MS - 1 });
    const p = plan([gone], [fresh('a', 0)]);
    expect(p.upserts[0]).toMatchObject({ neighborPublicKey: 'a', state: 'pending', sightings: 1 });
  });
});

describe('observeNeighbours (persistence + events)', () => {
  let db: ReturnType<typeof createTestDb>['sqlite'];
  let repo: MeshCoreRepository;
  let events: NeighborSightingData[];
  let sources: Array<string | undefined>;
  let listener: (e: DataEvent) => void;
  const R = N('a');
  const X = N('b');

  beforeEach(async () => {
    const t = createTestDb();
    db = t.sqlite;
    repo = new MeshCoreRepository(t.db, 'sqlite');
    await repo.upsertNode({ publicKey: R, name: 'Rep' }, 'src');
    events = [];
    sources = [];
    listener = (e) => {
      if (e.type === 'neighbor:sighting') {
        events.push(e.data as NeighborSightingData);
        sources.push(e.sourceId);
      }
    };
    dataEventEmitter.on('data', listener);
  });
  afterEach(() => {
    dataEventEmitter.off('data', listener);
    db.close();
  });

  it('baselines silently, tracks a newcomer, and emits when it is seen again; state survives a "restart"', async () => {
    await observeNeighbours(repo, 'src', R, [fresh(N('c'), 10)], { complete: true, pollAtMs: T0 });
    expect(await repo.getNeighborWatchBaselinedAt('src', R)).toBe(T0);
    expect(events).toEqual([]);

    // X appears. No event yet.
    await observeNeighbours(repo, 'src', R, [fresh(N('c'), 10), fresh(X, 0)], { complete: true, pollAtMs: T0 + 5 * 60_000 });
    expect((await repo.getNeighborWatch('src', R)).find((r) => r.neighborPublicKey === X)?.state).toBe('pending');
    expect(events).toEqual([]);

    // Later sighting (state read back from the DB, nothing in memory).
    await observeNeighbours(repo, 'src', R, [fresh(N('c'), 10), fresh(X, 0)], { complete: true, pollAtMs: T0 + 73 * H });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reporterPublicKey: R, reporterName: 'Rep', neighborPublicKey: X, sightings: 2 });
    expect(events[0].prevLastHeardAt - events[0].firstSeenAt).toBeLessThan(72 * H);
    expect(events[0].lastHeardAt - events[0].firstSeenAt).toBeGreaterThanOrEqual(72 * H);
    expect(sources).toEqual(['src']);
  });

  it('is source scoped: another source baselines on its own', async () => {
    await repo.upsertNode({ publicKey: R, name: 'Rep' }, 'other');
    await observeNeighbours(repo, 'src', R, [], { complete: true, pollAtMs: T0 });
    expect(await repo.getNeighborWatchBaselinedAt('other', R)).toBeNull();
    await observeNeighbours(repo, 'other', R, [fresh(X, 0)], { complete: true, pollAtMs: T0 });
    expect(events).toEqual([]); // baseline on the other source, not a newcomer
  });

  it('never throws when the repository fails', async () => {
    const broken = { ...repo, getNeighborWatchBaselinedAt: async () => { throw new Error('db down'); } } as never;
    await expect(observeNeighbours(broken, 'src', R, [fresh(X, 0)], { complete: true, pollAtMs: T0 })).resolves.toBeUndefined();
  });
});
