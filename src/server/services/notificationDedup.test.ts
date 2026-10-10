/**
 * The dedup store on its own (#5729): outcomes, window, release, bound.
 * The delivery-channel behaviour is in notificationDedup.crossSource.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  NotificationDedupStore,
  NOTIFICATION_DEDUP_WINDOW_MS,
  NOTIFICATION_DEDUP_MAX_ENTRIES,
  packetDedupKey,
  joinSourceNames,
  dedupTag,
} from './notificationDedup.js';

const A = { sourceId: 'src-a', sourceName: 'Hilltop' };
const B = { sourceId: 'src-b', sourceName: 'Valley' };
const T0 = 1_800_000_000_000;

describe('NotificationDedupStore', () => {
  it('defaults to a 60 s window and a finite cap', () => {
    expect(NOTIFICATION_DEDUP_WINDOW_MS).toBe(60_000);
    expect(Number.isFinite(NOTIFICATION_DEDUP_MAX_ENTRIES)).toBe(true);
  });

  it('first copy is first; another source is additional; the same source again is a duplicate', () => {
    const store = new NotificationDedupStore();
    expect(store.claim('u1', 'k', A, T0)).toEqual({ outcome: 'first', sources: [A] });
    expect(store.claim('u1', 'k', B, T0 + 500)).toEqual({ outcome: 'additional', sources: [A, B] });
    expect(store.claim('u1', 'k', B, T0 + 900)).toEqual({ outcome: 'duplicate', sources: [A, B] });
    expect(store.claim('u1', 'k', A, T0 + 900)).toEqual({ outcome: 'duplicate', sources: [A, B] });
    expect(store.size).toBe(1);
  });

  it('keeps recipients apart: one recipient never sees a source only another recipient claimed', () => {
    const store = new NotificationDedupStore();
    store.claim('u1', 'k', A, T0);
    store.claim('u1', 'k', B, T0);
    // u2 only ever passed on B.
    expect(store.claim('u2', 'k', B, T0)).toEqual({ outcome: 'first', sources: [B] });
  });

  it('keeps keys apart', () => {
    const store = new NotificationDedupStore();
    expect(store.claim('u1', 'k1', A, T0).outcome).toBe('first');
    expect(store.claim('u1', 'k2', B, T0).outcome).toBe('first');
  });

  it('a copy at the window edge starts a new event, and names only its own source', () => {
    const store = new NotificationDedupStore();
    store.claim('u1', 'k', A, T0);
    expect(store.claim('u1', 'k', B, T0 + NOTIFICATION_DEDUP_WINDOW_MS - 1).outcome).toBe('additional');
    expect(store.claim('u1', 'k', B, T0 + NOTIFICATION_DEDUP_WINDOW_MS)).toEqual({ outcome: 'first', sources: [B] });
  });

  it('the window runs from the first copy and does not slide', () => {
    const store = new NotificationDedupStore(1000);
    store.claim('u1', 'k', A, T0);
    // Copies every 400 ms must not hold the entry open past T0 + 1000.
    expect(store.claim('u1', 'k', A, T0 + 400).outcome).toBe('duplicate');
    expect(store.claim('u1', 'k', A, T0 + 800).outcome).toBe('duplicate');
    expect(store.claim('u1', 'k', A, T0 + 1200).outcome).toBe('first');
  });

  it('release undoes a lone first claim so another source can deliver', () => {
    const store = new NotificationDedupStore();
    store.claim('u1', 'k', A, T0);
    store.release('u1', 'k', A.sourceId);
    expect(store.size).toBe(0);
    expect(store.claim('u1', 'k', B, T0 + 10)).toEqual({ outcome: 'first', sources: [B] });
  });

  it('release does nothing once a second source has joined, or for another source', () => {
    const store = new NotificationDedupStore();
    store.claim('u1', 'k', A, T0);
    store.release('u1', 'k', B.sourceId);
    expect(store.size).toBe(1);
    store.claim('u1', 'k', B, T0);
    store.release('u1', 'k', A.sourceId);
    expect(store.claim('u1', 'k', A, T0 + 1).outcome).toBe('duplicate');
  });

  it('is bounded: never holds more than the cap, and drops the oldest first', () => {
    const store = new NotificationDedupStore(60_000, 5);
    for (let i = 0; i < 50; i++) {
      store.claim('u1', `k${i}`, A, T0 + i);
      expect(store.size).toBeLessThanOrEqual(5);
    }
    expect(store.size).toBe(5);
    // The newest five survive; an evicted key reads as a new event.
    expect(store.claim('u1', 'k49', A, T0 + 60).outcome).toBe('duplicate');
    expect(store.claim('u1', 'k0', A, T0 + 60).outcome).toBe('first');
  });

  it('expired entries are dropped when a new event arrives (no timer)', () => {
    const store = new NotificationDedupStore(1000, 100);
    for (let i = 0; i < 20; i++) store.claim('u1', `k${i}`, A, T0);
    expect(store.size).toBe(20);
    store.claim('u1', 'later', A, T0 + 5000);
    expect(store.size).toBe(1);
  });

  it('a renewed key moves to the back, so it is not the next one evicted', () => {
    const store = new NotificationDedupStore(1000, 3);
    store.claim('u1', 'old', A, T0);
    store.claim('u1', 'x', A, T0 + 900);
    store.claim('u1', 'old', A, T0 + 1100); // expired → renewed, now newest
    store.claim('u1', 'y', A, T0 + 1200);
    store.claim('u1', 'z', A, T0 + 1300); // evicts x, the oldest
    expect(store.claim('u1', 'old', A, T0 + 1400).outcome).toBe('duplicate');
  });
});

describe('packetDedupKey', () => {
  it('is the same for every source that hears the packet', () => {
    expect(packetDedupKey(0x0a0b0c0d, 42, 1)).toBe(packetDedupKey(0x0a0b0c0d, 42, 1));
  });

  it('differs by sender, packet id and port', () => {
    const base = packetDedupKey(100, 42, 1);
    expect(packetDedupKey(101, 42, 1)).not.toBe(base);
    expect(packetDedupKey(100, 43, 1)).not.toBe(base);
    expect(packetDedupKey(100, 42, 3)).not.toBe(base);
  });

  it('reads a signed and an unsigned node number as the same node', () => {
    expect(packetDedupKey(-1, 42, 1)).toBe(packetDedupKey(0xffffffff, 42, 1));
  });

  it('is null without a usable packet id or port', () => {
    expect(packetDedupKey(100, 0, 1)).toBeNull();
    expect(packetDedupKey(100, null, 1)).toBeNull();
    expect(packetDedupKey(100, undefined, 1)).toBeNull();
    expect(packetDedupKey(100, 42, null)).toBeNull();
    expect(packetDedupKey(undefined, 42, 1)).toBeNull();
    expect(packetDedupKey(null, 42, 1)).toBeNull();
    expect(packetDedupKey(100, Number.NaN, 1)).toBeNull();
  });

  it('accepts port 0, which is a real port', () => {
    expect(packetDedupKey(100, 42, 0)).toBe('packet:100:42:0');
  });
});

describe('helpers', () => {
  it('joins source names in arrival order', () => {
    expect(joinSourceNames([A])).toBe('Hilltop');
    expect(joinSourceNames([A, B])).toBe('Hilltop, Valley');
  });

  it('gives one event one tag', () => {
    expect(dedupTag('packet:1:2:3')).toBe(dedupTag('packet:1:2:3'));
    expect(dedupTag('packet:1:2:3')).not.toBe(dedupTag('packet:1:2:4'));
  });
});
