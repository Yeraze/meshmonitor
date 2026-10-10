/**
 * ReliablePkiTracker state machine and priming decision (#5691).
 *
 * The rule (maintainer comment on #5691): a PKI send moves the node to
 * `pending` only if it set `want_ack` or `want_response`; it becomes
 * `successful` on the reply / ack, `failed` when nothing expected came back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ReliablePkiTracker,
  resolveReliablePkiMode,
  PKI_EXCHANGE_TIMEOUT_MS,
  PRIMING_MIN_INTERVAL_MS,
  PRIMING_GAP_MS,
  PRIMING_MAX_PER_SOURCE_PER_HOUR,
  type PkiStateStore,
  type PrimingHooks,
  type ReliablePkiMode,
} from './reliablePki.js';
import { RoutingError } from '../constants/meshtastic.js';
import type { PkiExchangeStateRow, PkiFailureReason } from '../../db/repositories/pkiExchangeState.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

const SRC = 'src-1';
const LOCAL = 0x0a0a0a0a;
const NODE = 0x12345678;
const OTHER = 0x0badcafe;

function makeStore() {
  const rows = new Map<string, PkiExchangeStateRow>();
  const key = (s: string, n: number) => `${s}|${n}`;
  const base = (s: string, n: number, now: number): PkiExchangeStateRow => ({
    sourceId: s, nodeNum: n, state: 'pending', stateChangedAt: now, lastSuccessAt: null,
    failingSince: null, lastFailureReason: null, lastPrimedAt: null, updatedAt: now,
  });
  const store: PkiStateStore = {
    getState: vi.fn(async (s, n) => rows.get(key(s, n)) ?? null),
    markPending: vi.fn(async (s, n, now = 0) => {
      const r = { ...(rows.get(key(s, n)) ?? base(s, n, now)), state: 'pending' as const, stateChangedAt: now };
      rows.set(key(s, n), r); return r;
    }),
    markSuccessful: vi.fn(async (s, n, now = 0) => {
      const r = { ...(rows.get(key(s, n)) ?? base(s, n, now)), state: 'successful' as const, lastSuccessAt: now, failingSince: null, lastFailureReason: null };
      rows.set(key(s, n), r); return r;
    }),
    markFailed: vi.fn(async (s, n, reason: PkiFailureReason, now = 0) => {
      const prev = rows.get(key(s, n)) ?? base(s, n, now);
      const r = { ...prev, state: 'failed' as const, failingSince: prev.failingSince ?? now, lastFailureReason: reason };
      rows.set(key(s, n), r); return r;
    }),
    countPrimedSince: vi.fn(async (s: string, since: number) =>
      [...rows.values()].filter((r) => r.sourceId === s && r.lastPrimedAt != null && r.lastPrimedAt > since).length),
    recordPriming: vi.fn(async (s, n, now = 0) => {
      const r = { ...(rows.get(key(s, n)) ?? { ...base(s, n, now), state: 'failed' as const }), lastPrimedAt: now };
      rows.set(key(s, n), r); return r;
    }),
  };
  return { store, rows, get: (n = NODE, s = SRC) => rows.get(key(s, n)) };
}

function makeTracker(opts: { mode?: ReliablePkiMode } = {}) {
  let now = 1_000_000;
  const s = makeStore();
  let mode: ReliablePkiMode = opts.mode ?? 'asNeeded';
  const sleep = vi.fn().mockResolvedValue(undefined);
  const tracker = new ReliablePkiTracker({
    sourceId: SRC, store: s.store, getMode: async () => mode, now: () => now, sleep,
  });
  return {
    tracker, ...s, sleep,
    advance: (ms: number) => { now += ms; },
    nowValue: () => now,
    setMode: (m: ReliablePkiMode) => { mode = m; },
  };
}

function hooks(over: Partial<PrimingHooks> = {}): PrimingHooks & { sendNodeInfo: ReturnType<typeof vi.fn> } {
  return {
    isEligibleTarget: vi.fn().mockResolvedValue(true),
    txBlockedReason: vi.fn().mockResolvedValue(null),
    sendNodeInfo: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as PrimingHooks & { sendNodeInfo: ReturnType<typeof vi.fn> };
}

describe('ReliablePkiTracker — state transitions', () => {
  let t: ReturnType<typeof makeTracker>;
  beforeEach(() => { t = makeTracker(); });

  it('a send with neither want_ack nor want_response leaves the state untouched', async () => {
    await t.tracker.track(1, NODE, { wantAck: false, wantResponse: false });
    expect(t.store.markPending).not.toHaveBeenCalled();
    expect(t.tracker.trackedCount).toBe(0);
    t.tracker.stop();
  });

  it('want_response request → pending → successful on the reply from the node', async () => {
    await t.tracker.track(10, NODE, { wantAck: true, wantResponse: true });
    expect(t.get()?.state).toBe('pending');
    await t.tracker.observeReply(NODE, 10);
    expect(t.get()?.state).toBe('successful');
    expect(t.tracker.trackedCount).toBe(0);
    t.tracker.stop();
  });

  it('a reply from a different node with the same request id does not count', async () => {
    await t.tracker.track(10, NODE, { wantAck: false, wantResponse: true });
    await t.tracker.observeReply(OTHER, 10);
    expect(t.get()?.state).toBe('pending');
    t.tracker.stop();
  });

  it('want_ack DM → successful on the ack from the target', async () => {
    await t.tracker.track(20, NODE, { wantAck: true, wantResponse: false });
    await t.tracker.observeRouting(NODE, 20, RoutingError.NONE, LOCAL);
    expect(t.get()?.state).toBe('successful');
    t.tracker.stop();
  });

  it('an implicit ack (NONE from our own radio) is not an answer', async () => {
    await t.tracker.track(21, NODE, { wantAck: true, wantResponse: false });
    await t.tracker.observeRouting(LOCAL, 21, RoutingError.NONE, LOCAL);
    expect(t.get()?.state).toBe('pending');
    t.tracker.stop();
  });

  it('a routing reply that proves the node decrypted it (NO_RESPONSE) counts as success', async () => {
    await t.tracker.track(22, NODE, { wantAck: true, wantResponse: true });
    await t.tracker.observeRouting(NODE, 22, RoutingError.NO_RESPONSE, LOCAL);
    expect(t.get()?.state).toBe('successful');
    t.tracker.stop();
  });

  it('explicit PKI_UNKNOWN_PUBKEY from the node → failed at once, and counts as a priming', async () => {
    await t.tracker.track(30, NODE, { wantAck: true, wantResponse: false });
    await t.tracker.observeRouting(NODE, 30, RoutingError.PKI_UNKNOWN_PUBKEY, LOCAL);
    expect(t.get()?.state).toBe('failed');
    expect(t.get()?.lastFailureReason).toBe('pki_unknown_pubkey');
    expect(t.get()?.lastPrimedAt).toBe(t.nowValue());
    t.tracker.stop();
  });

  it('NO_CHANNEL from the node → failed', async () => {
    await t.tracker.track(31, NODE, { wantAck: true, wantResponse: false });
    await t.tracker.observeRouting(NODE, 31, RoutingError.NO_CHANNEL, LOCAL);
    expect(t.get()?.lastFailureReason).toBe('no_channel');
    expect(t.get()?.lastPrimedAt).toBeNull();
    t.tracker.stop();
  });

  it('MAX_RETRANSMIT from our radio (the firmware\'s own timeout) → failed', async () => {
    await t.tracker.track(32, NODE, { wantAck: true, wantResponse: false });
    await t.tracker.observeRouting(LOCAL, 32, RoutingError.MAX_RETRANSMIT, LOCAL);
    expect(t.get()?.lastFailureReason).toBe('max_retransmit');
    t.tracker.stop();
  });

  it('our radio refusing to encrypt (PKI_SEND_FAIL_PUBLIC_KEY) → failed', async () => {
    await t.tracker.track(33, NODE, { wantAck: true, wantResponse: false });
    await t.tracker.observeRouting(LOCAL, 33, RoutingError.PKI_SEND_FAIL_PUBLIC_KEY, LOCAL);
    expect(t.get()?.lastFailureReason).toBe('radio_refused');
    t.tracker.stop();
  });

  it('errors from an intermediate node are ignored', async () => {
    await t.tracker.track(34, NODE, { wantAck: true, wantResponse: false });
    await t.tracker.observeRouting(OTHER, 34, RoutingError.NO_CHANNEL, LOCAL);
    expect(t.get()?.state).toBe('pending');
    t.tracker.stop();
  });

  it('timeout: one unanswered exchange past the deadline → failed', async () => {
    await t.tracker.track(40, NODE, { wantAck: true, wantResponse: true });
    t.advance(PKI_EXCHANGE_TIMEOUT_MS - 1);
    await t.tracker.sweep();
    expect(t.get()?.state).toBe('pending');
    t.advance(1);
    await t.tracker.sweep();
    expect(t.get()?.state).toBe('failed');
    expect(t.get()?.lastFailureReason).toBe('timeout');
    expect(t.tracker.trackedCount).toBe(0);
    t.tracker.stop();
  });

  it('a late answer after the deadline does nothing (already settled)', async () => {
    await t.tracker.track(41, NODE, { wantAck: true, wantResponse: false });
    t.advance(PKI_EXCHANGE_TIMEOUT_MS);
    await t.tracker.sweep();
    await t.tracker.observeRouting(NODE, 41, RoutingError.NONE, LOCAL);
    expect(t.get()?.state).toBe('failed');
    t.tracker.stop();
  });

  it('an exchange evicted at the tracking cap stays pending, never failed', async () => {
    await t.tracker.track(1, OTHER, { wantAck: true, wantResponse: false });
    for (let i = 0; i < 512; i++) {
      await t.tracker.track(1000 + i, NODE, { wantAck: true, wantResponse: false });
    }
    expect(t.tracker.trackedCount).toBe(512);
    t.advance(PKI_EXCHANGE_TIMEOUT_MS);
    await t.tracker.sweep();
    expect(t.get(OTHER)?.state).toBe('pending');
    expect(t.get(NODE)?.state).toBe('failed');
    t.tracker.stop();
  });

  it('failed → successful clears the streak', async () => {
    await t.tracker.track(42, NODE, { wantAck: true, wantResponse: false });
    await t.tracker.observeRouting(NODE, 42, RoutingError.NO_CHANNEL, LOCAL);
    await t.tracker.track(43, NODE, { wantAck: true, wantResponse: false });
    await t.tracker.observeRouting(NODE, 43, RoutingError.NONE, LOCAL);
    expect(t.get()?.state).toBe('successful');
    expect(t.get()?.failingSince).toBeNull();
    t.tracker.stop();
  });
});

describe('ReliablePkiTracker — priming decision', () => {
  it('Off: never primes', async () => {
    const t = makeTracker({ mode: 'off' });
    await t.store.markFailed(SRC, NODE, 'timeout', 0);
    const h = hooks();
    expect(await t.tracker.primeBeforeSend(NODE, h)).toBe('off');
    expect(h.sendNodeInfo).not.toHaveBeenCalled();
  });

  it('Avoid PKI (#5711): never primes, even a failed node with the window open', async () => {
    const t = makeTracker({ mode: 'avoid' });
    await t.store.markFailed(SRC, NODE, 'timeout', 0);
    const h = hooks();
    expect(await t.tracker.primeBeforeSend(NODE, h)).toBe('off');
    expect(h.sendNodeInfo).not.toHaveBeenCalled();
  });

  it('As needed but not failed (no row / successful / pending): no priming', async () => {
    const t = makeTracker();
    const h = hooks();
    expect(await t.tracker.primeBeforeSend(NODE, h)).toBe('not_failed');
    await t.store.markSuccessful(SRC, NODE, 0);
    expect(await t.tracker.primeBeforeSend(NODE, h)).toBe('not_failed');
    await t.store.markPending(SRC, NODE, 0);
    expect(await t.tracker.primeBeforeSend(NODE, h)).toBe('not_failed');
    expect(h.sendNodeInfo).not.toHaveBeenCalled();
  });

  it('As needed + failed + window open: one NodeInfo, timer stamped, then the gap', async () => {
    const t = makeTracker();
    await t.store.markFailed(SRC, NODE, 'timeout', 0);
    const h = hooks();
    expect(await t.tracker.primeBeforeSend(NODE, h)).toBe('primed');
    expect(h.sendNodeInfo).toHaveBeenCalledTimes(1);
    expect(t.get()?.lastPrimedAt).toBe(t.nowValue());
    expect(t.sleep).toHaveBeenCalledWith(PRIMING_GAP_MS);
  });

  it('the hourly window: closed for an hour after a priming, open after', async () => {
    const t = makeTracker();
    await t.store.markFailed(SRC, NODE, 'timeout', 0);
    const h = hooks();
    await t.tracker.primeBeforeSend(NODE, h);
    t.advance(PRIMING_MIN_INTERVAL_MS - 1);
    expect(await t.tracker.primeBeforeSend(NODE, h)).toBe('window_closed');
    t.advance(1);
    expect(await t.tracker.primeBeforeSend(NODE, h)).toBe('primed');
    expect(h.sendNodeInfo).toHaveBeenCalledTimes(2);
  });

  it('a new tracker over the same store (restart) sees the stamped window', async () => {
    const t = makeTracker();
    await t.store.markFailed(SRC, NODE, 'timeout', 0);
    await t.tracker.primeBeforeSend(NODE, hooks());
    const restarted = new ReliablePkiTracker({
      sourceId: SRC, store: t.store, getMode: async () => 'asNeeded', now: () => t.nowValue() + 1000, sleep: vi.fn(),
    });
    const h = hooks();
    expect(await restarted.primeBeforeSend(NODE, h)).toBe('window_closed');
    expect(h.sendNodeInfo).not.toHaveBeenCalled();
  });

  it('ineligible target (ignored / local / no key): no priming', async () => {
    const t = makeTracker();
    await t.store.markFailed(SRC, NODE, 'timeout', 0);
    const h = hooks({ isEligibleTarget: vi.fn().mockResolvedValue(false) });
    expect(await t.tracker.primeBeforeSend(NODE, h)).toBe('ineligible');
    expect(h.sendNodeInfo).not.toHaveBeenCalled();
    expect(t.store.recordPriming).not.toHaveBeenCalled();
  });

  it('TX blocked: no priming and the window stays open', async () => {
    const t = makeTracker();
    await t.store.markFailed(SRC, NODE, 'timeout', 0);
    const h = hooks({ txBlockedReason: vi.fn().mockResolvedValue('airtime cutoff') });
    expect(await t.tracker.primeBeforeSend(NODE, h)).toBe('tx_blocked');
    expect(t.store.recordPriming).not.toHaveBeenCalled();
  });

  it('a failed NodeInfo send returns send_failed and never throws', async () => {
    const t = makeTracker();
    await t.store.markFailed(SRC, NODE, 'timeout', 0);
    const h = hooks({ sendNodeInfo: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(t.tracker.primeBeforeSend(NODE, h)).resolves.toBe('send_failed');
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('two concurrent sends to one node prime at most once', async () => {
    const t = makeTracker();
    await t.store.markFailed(SRC, NODE, 'timeout', 0);
    const h = hooks();
    const [a, b] = await Promise.all([t.tracker.primeBeforeSend(NODE, h), t.tracker.primeBeforeSend(NODE, h)]);
    expect([a, b].sort()).toEqual(['in_progress', 'primed']);
    expect(h.sendNodeInfo).toHaveBeenCalledTimes(1);
  });

  it('per-source isolation: a failure on another source does not prime this one', async () => {
    const t = makeTracker();
    await t.store.markFailed('src-other', NODE, 'timeout', 0);
    const h = hooks();
    expect(await t.tracker.primeBeforeSend(NODE, h)).toBe('not_failed');
  });
});

describe('ReliablePkiTracker — per-source hourly cap', () => {
  const failNodes = async (t: ReturnType<typeof makeTracker>, n: number, sourceId = SRC) => {
    for (let i = 1; i <= n; i++) await t.store.markFailed(sourceId, 0x1000 + i, 'timeout', 0);
  };

  it(`the ${PRIMING_MAX_PER_SOURCE_PER_HOUR + 1}th failing node in an hour is not primed`, async () => {
    expect(PRIMING_MAX_PER_SOURCE_PER_HOUR).toBe(10);
    const t = makeTracker();
    await failNodes(t, 11);
    const h = hooks();
    for (let i = 1; i <= 10; i++) {
      expect(await t.tracker.primeBeforeSend(0x1000 + i, h)).toBe('primed');
      t.advance(1000);
    }
    expect(await t.tracker.primeBeforeSend(0x1000 + 11, h)).toBe('source_cap');
    expect(h.sendNodeInfo).toHaveBeenCalledTimes(10);
    expect(t.get(0x1000 + 11)?.lastPrimedAt).toBeNull();
  });

  it('the cap is a rolling hour: the slot frees when the oldest priming is an hour old', async () => {
    const t = makeTracker();
    await failNodes(t, 11);
    const h = hooks();
    for (let i = 1; i <= 10; i++) { await t.tracker.primeBeforeSend(0x1000 + i, h); t.advance(1000); }
    t.advance(PRIMING_MIN_INTERVAL_MS - 10_000);
    expect(await t.tracker.primeBeforeSend(0x1000 + 11, h)).toBe('primed');
  });

  it('the cap survives a restart (a new tracker over the same store)', async () => {
    const t = makeTracker();
    await failNodes(t, 11);
    for (let i = 1; i <= 10; i++) await t.tracker.primeBeforeSend(0x1000 + i, hooks());
    const restarted = new ReliablePkiTracker({
      sourceId: SRC, store: t.store, getMode: async () => 'asNeeded', now: () => t.nowValue() + 1000, sleep: vi.fn(),
    });
    const h = hooks();
    expect(await restarted.primeBeforeSend(0x1000 + 11, h)).toBe('source_cap');
    expect(h.sendNodeInfo).not.toHaveBeenCalled();
  });

  it("the cap is per source: another source's primings do not count", async () => {
    const t = makeTracker();
    for (let i = 1; i <= 10; i++) {
      await t.store.markFailed('src-other', 0x2000 + i, 'timeout', 0);
      await t.store.recordPriming('src-other', 0x2000 + i, t.nowValue());
    }
    await t.store.markFailed(SRC, NODE, 'timeout', 0);
    expect(await t.tracker.primeBeforeSend(NODE, hooks())).toBe('primed');
  });

  it('concurrent primings to different nodes never exceed the cap', async () => {
    const t = makeTracker();
    await failNodes(t, 15);
    const h = hooks();
    const outcomes = await Promise.all(Array.from({ length: 15 }, (_, i) => t.tracker.primeBeforeSend(0x1000 + i + 1, h)));
    expect(outcomes.filter((o) => o === 'primed')).toHaveLength(10);
    expect(outcomes.filter((o) => o === 'source_cap')).toHaveLength(5);
  });
});

describe('resolveReliablePkiMode', () => {
  const reader = (global: string | null, perSource: Record<string, string>) => ({
    getSetting: vi.fn(async () => global),
    getSettingForSource: vi.fn(async (sourceId: string | null | undefined) => (sourceId ? perSource[sourceId] ?? null : null)),
  });

  it('defaults to off', async () => {
    expect(await resolveReliablePkiMode(reader(null, {}), 's')).toBe('off');
  });
  it('uses the global default when the source inherits', async () => {
    expect(await resolveReliablePkiMode(reader('asNeeded', { s: 'inherit' }), 's')).toBe('asNeeded');
  });
  it('a source override wins, read with the source-scoped key', async () => {
    const r = reader('asNeeded', { s: 'off' });
    expect(await resolveReliablePkiMode(r, 's')).toBe('off');
    expect(r.getSettingForSource).toHaveBeenCalledWith('s', 'reliablePkiSourceMode');
  });
  it('ignores garbage values', async () => {
    expect(await resolveReliablePkiMode(reader('always', { s: 'sometimes' }), 's')).toBe('off');
  });
  it('Avoid PKI (#5711): global and per-source', async () => {
    expect(await resolveReliablePkiMode(reader('avoid', {}), 's')).toBe('avoid');
    expect(await resolveReliablePkiMode(reader('off', { s: 'avoid' }), 's')).toBe('avoid');
    expect(await resolveReliablePkiMode(reader('avoid', { s: 'asNeeded' }), 's')).toBe('asNeeded');
  });
});
