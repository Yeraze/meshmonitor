import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ManualMeshTxQueue } from './meshcoreManualTxQueue.js';

const T0 = 1_000_000_000_000;

function makeHost(initialLast = 0) {
  const state = { last: initialLast, stamps: [] as number[] };
  return {
    state,
    host: {
      getLastMeshTxAt: () => state.last,
      recordMeshTx: (when: number = Date.now()) => {
        state.last = when;
        state.stamps.push(when);
      },
    },
  };
}

const req = (over: Partial<Parameters<ManualMeshTxQueue['waitForSlot']>[0]> = {}) => ({
  ownerKey: 'user:1',
  requestId: 'req-1',
  action: 'telemetry',
  publicKey: 'aa',
  signal: new AbortController().signal,
  ...over,
});

describe('ManualMeshTxQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fast path: grants at once and stamps when the floor is open and nothing queued', async () => {
    const { host, state } = makeHost();
    const q = new ManualMeshTxQueue(host);
    const beforeClaim = vi.fn(() => true);
    const r = await q.waitForSlot(req({ beforeClaim }));
    expect(r).toEqual({ kind: 'granted', grantedAt: T0, waitedMs: 0 });
    expect(state.stamps).toEqual([T0]);
    expect(beforeClaim).toHaveBeenCalledTimes(1);
    expect(q.isHeld()).toBe(false);
  });

  it('waits out the floor, then grants and stamps', async () => {
    const { host, state } = makeHost(T0 - 10_000);
    const q = new ManualMeshTxQueue(host);
    const p = q.waitForSlot(req());
    expect(q.isHeld()).toBe(true);
    await vi.advanceTimersByTimeAsync(49_000);
    expect(state.stamps).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await p;
    expect(r.kind).toBe('granted');
    expect(state.stamps).toHaveLength(1);
    expect(state.stamps[0] - (T0 - 10_000)).toBeGreaterThanOrEqual(60_000);
    expect(q.isHeld()).toBe(false);
  });

  it('serves two owners in order with grants at least the floor apart', async () => {
    const { host, state } = makeHost(T0 - 1_000);
    const q = new ManualMeshTxQueue(host);
    const order: string[] = [];
    const a = q.waitForSlot(req({ ownerKey: 'user:a', requestId: 'a' })).then((r) => (order.push('a'), r));
    const b = q.waitForSlot(req({ ownerKey: 'user:b', requestId: 'b' })).then((r) => (order.push('b'), r));
    await vi.advanceTimersByTimeAsync(200_000);
    const [ra, rb] = await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
    expect(ra.kind).toBe('granted');
    expect(rb.kind).toBe('granted');
    expect(state.stamps).toHaveLength(2);
    expect(state.stamps[1] - state.stamps[0]).toBeGreaterThanOrEqual(60_000);
  });

  it('same owner replacement keeps position, resets max wait, and supersedes the old waiter', async () => {
    const { host, state } = makeHost(T0 - 1_000);
    const q = new ManualMeshTxQueue(host, { maxWaitMs: 180_000 });
    const other = q.waitForSlot(req({ ownerKey: 'user:o', requestId: 'o' }));
    const first = q.waitForSlot(req({ ownerKey: 'user:1', requestId: 'r1', action: 'telemetry' }));
    await vi.advanceTimersByTimeAsync(1_000);
    const second = q.waitForSlot(req({ ownerKey: 'user:1', requestId: 'r2', action: 'time-sync', publicKey: 'bb' }));
    const r1 = await first;
    expect(r1).toEqual({ kind: 'superseded', by: { action: 'time-sync', publicKey: 'bb', requestId: 'r2' } });
    // position kept: 2nd of two
    expect(q.status('user:1', 'r2')).toMatchObject({ position: 2, depth: 2, action: 'time-sync' });
    expect(q.status('user:1', 'r1')).toBeNull();
    await vi.advanceTimersByTimeAsync(300_000);
    expect((await other).kind).toBe('granted');
    expect((await second).kind).toBe('granted');
    expect(state.stamps).toHaveLength(2); // the superseded request never sent
  });

  it('replacement resets the max wait', async () => {
    const { host } = makeHost(T0);
    // Floor longer than max wait so only the timeout can end a waiter.
    const q = new ManualMeshTxQueue(host, { floorMs: 10_000_000, maxWaitMs: 100_000, ttlMs: 10_000_000 });
    const first = q.waitForSlot(req({ requestId: 'r1' }));
    await vi.advanceTimersByTimeAsync(90_000);
    const second = q.waitForSlot(req({ requestId: 'r2' }));
    expect((await first).kind).toBe('superseded');
    await vi.advanceTimersByTimeAsync(50_000); // 140 s since first, 50 s since second
    let settled = false;
    void second.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await second).kind).toBe('timeout');
  });

  it('expires an entry whose heartbeat is older than the ttl', async () => {
    const { host } = makeHost(T0);
    const q = new ManualMeshTxQueue(host, { floorMs: 10_000_000, ttlMs: 90_000, maxWaitMs: 10_000_000 });
    // A leaked entry: its waiter sleeps with a never-resolving sleep, so no heartbeat.
    const leaked = new ManualMeshTxQueue(host, {
      floorMs: 10_000_000,
      ttlMs: 90_000,
      maxWaitMs: 10_000_000,
      sleep: () => new Promise<boolean>(() => {}),
    });
    void leaked.waitForSlot(req());
    expect(leaked.isHeld()).toBe(true);
    vi.setSystemTime(T0 + 89_000);
    expect(leaked.isHeld()).toBe(true);
    vi.setSystemTime(T0 + 91_000);
    expect(leaked.isHeld()).toBe(false);
    expect(q.isHeld()).toBe(false);
  });

  it('a live waiter heartbeats and is not pruned', async () => {
    const { host } = makeHost(T0);
    const q = new ManualMeshTxQueue(host, { floorMs: 400_000, ttlMs: 90_000, maxWaitMs: 1_000_000 });
    const p = q.waitForSlot(req());
    await vi.advanceTimersByTimeAsync(300_000);
    expect(q.isHeld()).toBe(true);
    await vi.advanceTimersByTimeAsync(110_000);
    expect((await p).kind).toBe('granted');
  });

  it('abort while waiting never stamps and releases the hold', async () => {
    const { host, state } = makeHost(T0 - 1_000);
    const q = new ManualMeshTxQueue(host);
    const ctrl = new AbortController();
    const p = q.waitForSlot(req({ signal: ctrl.signal }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(q.isHeld()).toBe(true);
    ctrl.abort();
    expect(await p).toEqual({ kind: 'aborted' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.stamps).toEqual([]);
    expect(q.isHeld()).toBe(false);
  });

  it('an already aborted signal returns aborted without stamping', async () => {
    const { host, state } = makeHost();
    const q = new ManualMeshTxQueue(host);
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await q.waitForSlot(req({ signal: ctrl.signal }))).toEqual({ kind: 'aborted' });
    expect(state.stamps).toEqual([]);
  });

  it('beforeClaim false gives unavailable with no stamp (fast path and queued)', async () => {
    const a = makeHost();
    const q1 = new ManualMeshTxQueue(a.host);
    expect(await q1.waitForSlot(req({ beforeClaim: () => false }))).toEqual({ kind: 'unavailable' });
    expect(a.state.stamps).toEqual([]);

    const b = makeHost(T0 - 1_000);
    const q2 = new ManualMeshTxQueue(b.host);
    let ok = true;
    const p = q2.waitForSlot(req({ beforeClaim: () => ok }));
    await vi.advanceTimersByTimeAsync(10_000);
    ok = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toEqual({ kind: 'unavailable' });
    expect(b.state.stamps).toEqual([]);
    expect(q2.isHeld()).toBe(false);
  });

  it('an external stamp during the wait delays the grant', async () => {
    const { host, state } = makeHost(T0 - 10_000);
    const q = new ManualMeshTxQueue(host);
    const p = q.waitForSlot(req());
    await vi.advanceTimersByTimeAsync(30_000);
    host.recordMeshTx(Date.now()); // a trace stamps the floor
    const external = state.last;
    state.stamps.length = 0;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(state.stamps).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await p).kind).toBe('granted');
    expect(state.stamps[0] - external).toBeGreaterThanOrEqual(60_000);
  });

  it('times out past the max wait with a numeric retry', async () => {
    const { host, state } = makeHost(T0);
    const q = new ManualMeshTxQueue(host, { floorMs: 1_000_000, maxWaitMs: 180_000, ttlMs: 10_000_000 });
    const p = q.waitForSlot(req());
    await vi.advanceTimersByTimeAsync(185_000);
    const r = await p;
    expect(r.kind).toBe('timeout');
    expect((r as { retryAfterSecs: number }).retryAfterSecs).toBeGreaterThan(0);
    expect(state.stamps).toEqual([]);
    expect(q.isHeld()).toBe(false);
  });

  it('returns full when the depth cap is reached, and a replacement is still allowed', async () => {
    const { host } = makeHost(T0);
    const q = new ManualMeshTxQueue(host, { floorMs: 1_000_000, maxDepth: 2, ttlMs: 10_000_000, maxWaitMs: 10_000_000 });
    const ctrl = new AbortController();
    const w1 = q.waitForSlot(req({ ownerKey: 'u1', requestId: '1', signal: ctrl.signal }));
    const w2 = q.waitForSlot(req({ ownerKey: 'u2', requestId: '2', signal: ctrl.signal }));
    const full = await q.waitForSlot(req({ ownerKey: 'u3', requestId: '3' }));
    expect(full.kind).toBe('full');
    expect((full as { retryAfterSecs: number }).retryAfterSecs).toBeGreaterThan(0);
    const w2b = q.waitForSlot(req({ ownerKey: 'u2', requestId: '2b', signal: ctrl.signal }));
    expect((await w2).kind).toBe('superseded');
    ctrl.abort();
    expect((await w1).kind).toBe('aborted');
    expect((await w2b).kind).toBe('aborted');
  });

  describe('tryClaim', () => {
    it('stamps when free and the floor is open', () => {
      const { host, state } = makeHost();
      const q = new ManualMeshTxQueue(host);
      expect(q.tryClaim(T0, 60_000)).toBe(true);
      expect(state.stamps).toEqual([T0]);
    });

    it('refuses while the floor is closed, without stamping', () => {
      const { host, state } = makeHost(T0 - 1_000);
      const q = new ManualMeshTxQueue(host);
      expect(q.tryClaim(T0, 60_000)).toBe(false);
      expect(state.stamps).toEqual([]);
    });

    it('refuses while a reservation is held even when the floor is open', async () => {
      const { host, state } = makeHost(T0 - 1_000);
      const q = new ManualMeshTxQueue(host);
      const ctrl = new AbortController();
      const p = q.waitForSlot(req({ signal: ctrl.signal }));
      vi.setSystemTime(T0 + 70_000); // floor open, but the waiter has not looped yet
      expect(q.isHeld()).toBe(true);
      expect(q.tryClaim(Date.now(), 60_000)).toBe(false);
      expect(state.stamps).toEqual([]);
      ctrl.abort();
      await p;
      expect(q.tryClaim(Date.now(), 60_000)).toBe(true);
    });
  });

  it('status reports position, depth and ETA', async () => {
    const { host } = makeHost(T0 - 20_000);
    const q = new ManualMeshTxQueue(host, { maxWaitMs: 10_000_000, ttlMs: 10_000_000 });
    const ctrl = new AbortController();
    void q.waitForSlot(req({ ownerKey: 'a', requestId: 'ra', signal: ctrl.signal }));
    void q.waitForSlot(req({ ownerKey: 'b', requestId: 'rb', action: 'neighbours', signal: ctrl.signal }));
    expect(q.status('a', 'ra')).toEqual({
      position: 1, depth: 2, startsInSecs: 40, action: 'telemetry', publicKey: 'aa',
    });
    expect(q.status('b', 'rb')).toMatchObject({ position: 2, depth: 2, startsInSecs: 100, action: 'neighbours' });
    expect(q.status('a', 'nope')).toBeNull();
    expect(q.status('zzz', 'ra')).toBeNull();
    ctrl.abort();
  });

  it('concurrent waiters never both grant inside the floor', async () => {
    const { host, state } = makeHost(T0 - 59_000);
    const q = new ManualMeshTxQueue(host);
    const ps = ['a', 'b', 'c'].map((o) => q.waitForSlot(req({ ownerKey: o, requestId: o })));
    await vi.advanceTimersByTimeAsync(400_000);
    const rs = await Promise.all(ps);
    expect(rs.every((r) => r.kind === 'granted')).toBe(true);
    expect(state.stamps).toHaveLength(3);
    for (let i = 1; i < state.stamps.length; i++) {
      expect(state.stamps[i] - state.stamps[i - 1]).toBeGreaterThanOrEqual(60_000);
    }
  });

  it('a scheduler claim cannot slip in between a reservation and its grant', async () => {
    const { host, state } = makeHost(T0 - 59_000);
    const q = new ManualMeshTxQueue(host);
    const p = q.waitForSlot(req());
    await vi.advanceTimersByTimeAsync(500);
    // Floor now open on the clock, queue held: the scheduler must lose.
    vi.setSystemTime(T0 + 2_000);
    expect(q.tryClaim(Date.now(), 60_000)).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await p).kind).toBe('granted');
    expect(state.stamps).toHaveLength(1);
  });
});
