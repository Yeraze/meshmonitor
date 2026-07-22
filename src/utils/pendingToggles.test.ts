/**
 * #4240 (half 1) — the optimistic-toggle store must not deadlock.
 *
 * Reported symptom: "Show on Map" permanently no-op'd with ZERO network
 * requests, recoverable only by a full page reload. The pending entry was
 * cleared only from inside the poll's `.map()` over the server's node list, so
 * it survived forever once the node stopped coming back (or the user switched
 * sources, since keys embed the sourceId captured at click time).
 */
import { describe, it, expect } from 'vitest';
import { PendingToggleMap, sweepAll, PENDING_TOGGLE_TTL_MS } from './pendingToggles';

const T0 = 1_000_000;

describe('PendingToggleMap (#4240)', () => {
  it('returns the pending value while in flight', () => {
    const m = new PendingToggleMap();
    m.set('src1:42', true, T0);
    expect(m.get('src1:42', T0 + 1_000)).toBe(true);
  });

  it('distinguishes a pending false from an absent entry', () => {
    // The guard tests `!== undefined`, so `false` must NOT read as absent —
    // otherwise un-hiding a node would be re-clickable mid-flight.
    const m = new PendingToggleMap();
    m.set('src1:42', false, T0);
    expect(m.get('src1:42', T0)).toBe(false);
    expect(m.get('src1:99', T0)).toBeUndefined();
  });

  it('expires an entry on read once past the TTL', () => {
    const m = new PendingToggleMap();
    m.set('src1:42', true, T0);
    expect(m.get('src1:42', T0 + PENDING_TOGGLE_TTL_MS + 1)).toBeUndefined();
  });

  it('drops the expired entry rather than merely hiding it', () => {
    const m = new PendingToggleMap();
    m.set('src1:42', true, T0);
    m.get('src1:42', T0 + PENDING_TOGGLE_TTL_MS + 1);
    expect(m.size).toBe(0);
  });

  it('keeps an entry that is exactly at the TTL boundary', () => {
    const m = new PendingToggleMap();
    m.set('src1:42', true, T0);
    // Strictly greater-than expires, so the boundary itself is still in flight.
    expect(m.get('src1:42', T0 + PENDING_TOGGLE_TTL_MS)).toBe(true);
  });

  it('sweeps orphans without the node ever reappearing — the actual deadlock', () => {
    const m = new PendingToggleMap();
    // Node vanishes from the poll response, so per-node reconciliation never
    // visits this key again. Before the fix this entry was immortal and the
    // toggle stayed dead until a page reload.
    m.set('src1:42', true, T0);
    m.sweep(T0 + PENDING_TOGGLE_TTL_MS + 1);
    expect(m.size).toBe(0);
    expect(m.get('src1:42', T0 + PENDING_TOGGLE_TTL_MS + 1)).toBeUndefined();
  });

  it('sweeping leaves still-in-flight entries alone', () => {
    const m = new PendingToggleMap();
    m.set('fresh', true, T0 + PENDING_TOGGLE_TTL_MS);
    m.set('stale', true, T0);
    m.sweep(T0 + PENDING_TOGGLE_TTL_MS + 1);
    expect(m.get('fresh', T0 + PENDING_TOGGLE_TTL_MS + 1)).toBe(true);
    expect(m.get('stale', T0 + PENDING_TOGGLE_TTL_MS + 1)).toBeUndefined();
  });

  it('clears an orphan left under a previous sourceId after a source switch', () => {
    const m = new PendingToggleMap();
    // Clicked while viewing src1; the user then switches to src2, so the
    // reconciler computes 'src2:42' and never revisits 'src1:42'.
    m.set('src1:42', true, T0);
    m.sweep(T0 + PENDING_TOGGLE_TTL_MS + 1);
    expect(m.get('src1:42', T0 + PENDING_TOGGLE_TTL_MS + 1)).toBeUndefined();
  });

  it('delete() still clears immediately for the error/rollback paths', () => {
    const m = new PendingToggleMap();
    m.set('src1:42', true, T0);
    m.delete('src1:42');
    expect(m.get('src1:42', T0)).toBeUndefined();
    expect(m.size).toBe(0);
  });

  it('sweepAll sweeps every store the poll owns', () => {
    const a = new PendingToggleMap();
    const b = new PendingToggleMap();
    const c = new PendingToggleMap();
    a.set('k', true, T0);
    b.set('k', false, T0);
    c.set('k', true, T0);
    sweepAll([a, b, c], T0 + PENDING_TOGGLE_TTL_MS + 1);
    expect([a.size, b.size, c.size]).toEqual([0, 0, 0]);
  });

  it('re-setting a key restarts its expiry clock', () => {
    const m = new PendingToggleMap();
    m.set('src1:42', true, T0);
    m.set('src1:42', false, T0 + PENDING_TOGGLE_TTL_MS);
    expect(m.get('src1:42', T0 + PENDING_TOGGLE_TTL_MS + 1)).toBe(false);
  });
});
