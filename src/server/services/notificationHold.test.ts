/**
 * The 5 s collect-then-send hold on its own (#5729, decision 2): Apprise and
 * the desktop app wait for every source that hears an event, then send ONE
 * message. The hold must not be extendable or re-armable into a burst.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  NotificationHoldStore,
  NotificationDedupStore,
  NOTIFICATION_COLLECT_HOLD_MS,
  type DedupSource,
} from './notificationDedup.js';

const A: DedupSource = { sourceId: 'src-a', sourceName: 'Hilltop' };
const B: DedupSource = { sourceId: 'src-b', sourceName: 'Valley' };
const C: DedupSource = { sourceId: 'src-c', sourceName: 'Ridge' };

describe('NotificationHoldStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds for 5 s, then sends once with every source that joined', async () => {
    expect(NOTIFICATION_COLLECT_HOLD_MS).toBe(5_000);
    const store = new NotificationHoldStore(NOTIFICATION_COLLECT_HOLD_MS, () => undefined);
    const flush = vi.fn(async () => true);

    store.start('apprise:1', 'k', A, flush);
    expect(store.join('apprise:1', 'k', B)).toBe(true);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(flush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([A, B]);
    expect(store.size).toBe(0);
  });

  it('a stream of copies cannot move the deadline', async () => {
    const store = new NotificationHoldStore(NOTIFICATION_COLLECT_HOLD_MS, () => undefined);
    const flush = vi.fn(async () => true);

    store.start('apprise:1', 'k', A, flush);
    for (const source of [B, C, B, A]) {
      await vi.advanceTimersByTimeAsync(1_000);
      store.join('apprise:1', 'k', source);
    }
    await vi.advanceTimersByTimeAsync(1_000); // t = 5 s from the FIRST copy
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([A, B, C]); // each source once, arrival order
  });

  it('a second start while a hold is live joins it and never arms a second timer', async () => {
    const store = new NotificationHoldStore(NOTIFICATION_COLLECT_HOLD_MS, () => undefined);
    const first = vi.fn(async () => true);
    const second = vi.fn(async () => true);

    store.start('apprise:1', 'k', A, first);
    store.start('apprise:1', 'k', B, second);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_COLLECT_HOLD_MS * 3);

    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith([A, B]);
    expect(second).not.toHaveBeenCalled();
  });

  it('a copy after the send finds no hold: the caller drops it', async () => {
    const store = new NotificationHoldStore(NOTIFICATION_COLLECT_HOLD_MS, () => undefined);
    const flush = vi.fn(async () => true);
    store.start('apprise:1', 'k', A, flush);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_COLLECT_HOLD_MS);
    expect(store.join('apprise:1', 'k', B)).toBe(false);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('recipients and events are separate holds', async () => {
    const store = new NotificationHoldStore(NOTIFICATION_COLLECT_HOLD_MS, () => undefined);
    const u1 = vi.fn(async () => true);
    const u2 = vi.fn(async () => true);
    const other = vi.fn(async () => true);
    store.start('apprise:1', 'k', A, u1);
    store.start('apprise:2', 'k', B, u2);
    store.start('apprise:1', 'k2', A, other);
    store.join('apprise:1', 'k', B);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_COLLECT_HOLD_MS);
    expect(u1).toHaveBeenCalledWith([A, B]);
    expect(u2).toHaveBeenCalledWith([B]);
    expect(other).toHaveBeenCalledWith([A]);
  });

  it('a failed send frees the dedup entry so a later real copy can deliver (no retry)', async () => {
    const dedup = new NotificationDedupStore();
    const store = new NotificationHoldStore(NOTIFICATION_COLLECT_HOLD_MS, (r, k) => dedup.forget(r, k));
    const flush = vi.fn(async () => false);

    dedup.claim('apprise:1', 'k', A);
    dedup.claim('apprise:1', 'k', B);
    store.start('apprise:1', 'k', A, flush);
    store.join('apprise:1', 'k', B);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_COLLECT_HOLD_MS);

    expect(flush).toHaveBeenCalledTimes(1);
    // Nothing re-sends on its own...
    await vi.advanceTimersByTimeAsync(NOTIFICATION_COLLECT_HOLD_MS * 10);
    expect(flush).toHaveBeenCalledTimes(1);
    // ...but the next real copy is a first copy again.
    expect(dedup.claim('apprise:1', 'k', C).outcome).toBe('first');
  });

  it('a throwing send counts as failed and does not escape', async () => {
    const onFailed = vi.fn();
    const store = new NotificationHoldStore(NOTIFICATION_COLLECT_HOLD_MS, onFailed);
    store.start('desktop', 'k', A, async () => { throw new Error('boom'); });
    await vi.advanceTimersByTimeAsync(NOTIFICATION_COLLECT_HOLD_MS);
    expect(onFailed).toHaveBeenCalledWith('desktop', 'k');
  });

  it('flushAll sends every pending hold now (graceful shutdown), and only once', async () => {
    const store = new NotificationHoldStore(NOTIFICATION_COLLECT_HOLD_MS, () => undefined);
    const f1 = vi.fn(async () => true);
    const f2 = vi.fn(async () => true);
    store.start('apprise:1', 'k1', A, f1);
    store.start('apprise:1', 'k2', B, f2);

    await store.flushAll();
    expect(f1).toHaveBeenCalledTimes(1);
    expect(f2).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);

    // The cancelled timers never fire a second send.
    await vi.advanceTimersByTimeAsync(NOTIFICATION_COLLECT_HOLD_MS * 2);
    expect(f1).toHaveBeenCalledTimes(1);
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it('keeps the meta of the first copy for the caller', () => {
    const store = new NotificationHoldStore(NOTIFICATION_COLLECT_HOLD_MS, () => undefined);
    store.start('desktop', 'k', A, async () => true, { ownerUserId: 7 });
    expect(store.getMeta('desktop', 'k')).toEqual({ ownerUserId: 7 });
    expect(store.getMeta('desktop', 'other')).toBeUndefined();
    store.clear();
    expect(store.isHeld('desktop', 'k')).toBe(false);
  });
});
