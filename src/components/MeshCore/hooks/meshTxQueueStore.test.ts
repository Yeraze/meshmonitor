import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getMeshTxEntry,
  makeSlot,
  parseRetrySeconds,
  resetMeshTxQueueStoreForTests,
  runMeshTxAction,
  MESH_TX_SUPERSEDED_SHOW_MS,
} from './meshTxQueueStore';

const PRE = '/api/sources/s1/meshcore';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  json: async () => body,
});

/** A POST that stays open until `settle` is called; GETs answer from `queueAnswer`. */
function makeFetcher() {
  const posts: Array<{ url: string; body: Record<string, unknown>; settle: (r: unknown) => void }> = [];
  let queueAnswer: () => unknown = () => json(404, { success: false, code: 'MESH_TX_REQUEST_NOT_FOUND' });
  const gets: string[] = [];
  const fetcher = vi.fn((url: string, opts?: RequestInit) => {
    if (opts?.method === 'POST') {
      return new Promise((resolve) => {
        posts.push({ url, body: JSON.parse(String(opts.body)), settle: resolve });
      });
    }
    gets.push(url);
    return Promise.resolve(queueAnswer());
  });
  return {
    fetcher: fetcher as unknown as (u: string, o?: RequestInit) => Promise<Response>,
    posts,
    gets,
    setQueue: (fn: () => unknown) => {
      queueAnswer = fn;
    },
  };
}

const base = (f: ReturnType<typeof makeFetcher>, over: Record<string, unknown> = {}) => ({
  fetcher: f.fetcher,
  sourceId: 's1',
  action: 'telemetry' as const,
  publicKey: 'a'.repeat(64),
  label: 'Poll Status',
  mcPrefix: PRE,
  path: 'nodes/x/telemetry/poll',
  ...over,
});

describe('meshTxQueueStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMeshTxQueueStoreForTests();
  });
  afterEach(() => {
    resetMeshTxQueueStoreForTests();
    vi.useRealTimers();
  });

  it('polls the queue GET every 2 s while the POST is open and counts down locally', async () => {
    const f = makeFetcher();
    f.setQueue(() => json(200, { success: true, data: { position: 2, depth: 2, startsInSecs: 30 } }));
    const p = runMeshTxAction(base(f));
    const slot = makeSlot('telemetry', 'a'.repeat(64), '');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.posts[0].body.requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(f.gets[0]).toBe(`${PRE}/tx-queue/${f.posts[0].body.requestId}`);
    expect(getMeshTxEntry('s1', slot)).toMatchObject({ phase: 'queued', position: 2, secondsLeft: 30 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(getMeshTxEntry('s1', slot)?.secondsLeft).toBe(29);
    expect(f.gets.length).toBe(1); // no new GET inside the 2 s window
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.gets.length).toBe(2);

    f.posts[0].settle(json(200, { success: true, data: { written: 3, waitedSecs: 31 } }));
    const r = await p;
    expect(r).toMatchObject({ ok: true, waitedSecs: 31 });
    expect(getMeshTxEntry('s1', slot)?.phase).toBe('done');
    const getsAfter = f.gets.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.gets.length).toBe(getsAfter); // polling stopped
  });

  it('shows sending when the GET says the request is no longer queued (404)', async () => {
    const f = makeFetcher();
    void runMeshTxAction(base(f));
    await vi.advanceTimersByTimeAsync(1000);
    expect(getMeshTxEntry('s1', makeSlot('telemetry', 'a'.repeat(64), ''))?.phase).toBe('sending');
  });

  it('holds the first GET for 1 s, shows no sending phase meanwhile, and catches a queued 200', async () => {
    const f = makeFetcher();
    f.setQueue(() => json(200, { success: true, data: { position: 1, depth: 1, startsInSecs: 50 } }));
    const slot = makeSlot('telemetry', 'a'.repeat(64), '');
    void runMeshTxAction(base(f));
    await vi.advanceTimersByTimeAsync(999);
    expect(f.gets.length).toBe(0);
    expect(f.posts.length).toBe(1);
    expect(getMeshTxEntry('s1', slot)?.phase).toBe('starting');
    await vi.advanceTimersByTimeAsync(1);
    expect(f.gets.length).toBe(1);
    expect(getMeshTxEntry('s1', slot)).toMatchObject({ phase: 'queued', secondsLeft: 50 });
  });

  it('marks the old queued entry superseded and tells the new one what it replaced', async () => {
    const f = makeFetcher();
    f.setQueue(() => json(200, { success: true, data: { position: 1, depth: 1, startsInSecs: 40 } }));
    const pk2 = 'b'.repeat(64);
    const first = runMeshTxAction(base(f));
    await vi.advanceTimersByTimeAsync(1000);
    void runMeshTxAction(base(f, { nodeLabel: 'Hilltop', action: 'time-sync', publicKey: pk2, label: 'Sync Now', path: 'nodes/y/time-sync' }));
    await vi.advanceTimersByTimeAsync(0);

    const newer = getMeshTxEntry('s1', makeSlot('time-sync', pk2, ''));
    expect(newer?.replaced).toEqual({ action: 'telemetry', label: 'Poll Status', publicKey: 'a'.repeat(64), nodeLabel: null });

    f.posts[0].settle(
      json(409, {
        success: false,
        code: 'MESH_TX_SUPERSEDED',
        error: 'Replaced by your newer request',
        supersededBy: { action: 'time-sync', publicKey: pk2 },
      }),
    );
    await first;
    const old = getMeshTxEntry('s1', makeSlot('telemetry', 'a'.repeat(64), ''));
    expect(old).toMatchObject({ phase: 'superseded', supersededBy: { action: 'time-sync' }, supersededByLabel: 'Sync Now' });
    await vi.advanceTimersByTimeAsync(MESH_TX_SUPERSEDED_SHOW_MS + 10);
    expect(getMeshTxEntry('s1', makeSlot('telemetry', 'a'.repeat(64), ''))).toBeNull();
  });

  it('counts a numeric 429 down, frees the slot, and never resends', async () => {
    const f = makeFetcher();
    const p = runMeshTxAction(base(f));
    await vi.advanceTimersByTimeAsync(0);
    f.posts[0].settle(
      json(429, { success: false, code: 'MESH_TX_QUEUE_TIMEOUT', retryAfterSecs: 5, retryAfterSeconds: 5 }, { 'Retry-After': '5' }),
    );
    await p;
    const slot = makeSlot('telemetry', 'a'.repeat(64), '');
    expect(getMeshTxEntry('s1', slot)).toMatchObject({ phase: 'cooldown', secondsLeft: 5 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(getMeshTxEntry('s1', slot)?.secondsLeft).toBe(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(getMeshTxEntry('s1', slot)).toBeNull();
    expect(f.posts.length).toBe(1);
  });

  it('treats a string retryAfter without a code as a plain error', async () => {
    const f = makeFetcher();
    const p = runMeshTxAction(base(f));
    await vi.advanceTimersByTimeAsync(0);
    f.posts[0].settle(json(429, { success: false, error: 'Too many', retryAfter: '1 minute' }, { 'Retry-After': '60' }));
    const r = await p;
    expect(r?.error).toBe('Too many');
    expect(getMeshTxEntry('s1', makeSlot('telemetry', 'a'.repeat(64), ''))?.phase).toBe('error');
  });

  it('ignores a second run while the same slot is busy', async () => {
    const f = makeFetcher();
    void runMeshTxAction(base(f));
    await vi.advanceTimersByTimeAsync(0);
    expect(await runMeshTxAction(base(f))).toBeNull();
    expect(f.posts.length).toBe(1);
  });

  it('flags a 409 TX_DISABLED answer', async () => {
    const f = makeFetcher();
    const p = runMeshTxAction(base(f));
    await vi.advanceTimersByTimeAsync(0);
    f.posts[0].settle(json(409, { success: false, code: 'TX_DISABLED', error: 'off' }));
    expect((await p)?.txDisabled).toBe(true);
  });

  it('parseRetrySeconds reads body fields, then the header', () => {
    expect(parseRetrySeconds(429, { code: 'RATE_LIMITED', retryAfterSecs: 12.2 })).toBe(13);
    expect(parseRetrySeconds(429, {}, new Headers({ 'Retry-After': '7' }))).toBe(7);
    expect(parseRetrySeconds(429, { retryAfter: '1 minute' })).toBeNull();
    expect(parseRetrySeconds(500, { retryAfterSecs: 5 })).toBeNull();
  });
});
