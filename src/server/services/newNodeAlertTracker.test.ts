import { describe, it, expect, vi } from 'vitest';
import { BoundedKeySet, NewNodeAlertTracker } from './newNodeAlertTracker.js';
import type { NewNodeAlertGate } from './newNodeAlertGate.js';

function fakeGate(over: Partial<Record<'admit' | 'isLearning', any>> = {}) {
  return {
    admit: vi.fn().mockResolvedValue({ allow: true }),
    isLearning: vi.fn().mockResolvedValue(false),
    ...over,
  } as unknown as NewNodeAlertGate & { admit: ReturnType<typeof vi.fn>; isLearning: ReturnType<typeof vi.fn> };
}

describe('BoundedKeySet', () => {
  it('evicts the oldest key past the cap', () => {
    const s = new BoundedKeySet(3);
    ['a', 'b', 'c', 'd'].forEach(k => s.add(k));
    expect(s.size).toBe(3);
    expect(s.has('a')).toBe(false);
    expect(s.keys()).toEqual(['b', 'c', 'd']);
  });
  it('delete and clear work', () => {
    const s = new BoundedKeySet();
    s.add('a'); s.add('b');
    s.delete('a');
    expect(s.has('a')).toBe(false);
    s.clear();
    expect(s.size).toBe(0);
  });
});

describe('NewNodeAlertTracker.claim', () => {
  it('refuses a known key unless pending, and refuses notified or in-flight keys', () => {
    const t = new NewNodeAlertTracker(fakeGate());
    expect(t.claim('k', false)).toBe(false);
    t.pending.add('k');
    expect(t.claim('k', false)).toBe(true);
    expect(t.claim('k', true)).toBe(false); // in flight
    t.release('k');
    t.notified.add('k');
    expect(t.claim('k', true)).toBe(false);
  });
});

describe('NewNodeAlertTracker.admitGated', () => {
  it('drops a named key while learning and clears pending', async () => {
    const gate = fakeGate({ admit: vi.fn().mockResolvedValue({ allow: false, reason: 'learning' }) });
    const t = new NewNodeAlertTracker(gate);
    t.pending.add('k');
    expect(await t.admitGated('s', 'k', true)).toEqual({ alert: false });
    expect(t.pending.has('k')).toBe(false);
  });
  it('does not park a nameless key while learning', async () => {
    const t = new NewNodeAlertTracker(fakeGate({ isLearning: vi.fn().mockResolvedValue(true) }));
    expect(await t.admitGated('s', 'k', false)).toEqual({ alert: false });
    expect(t.pending.has('k')).toBe(false);
  });
  it('parks a nameless key once armed', async () => {
    const gate = fakeGate();
    const t = new NewNodeAlertTracker(gate);
    expect(await t.admitGated('s', 'k', false)).toEqual({ alert: false });
    expect(t.pending.has('k')).toBe(true);
    expect(gate.admit).not.toHaveBeenCalled();
  });
  it('passes suppressedCount through', async () => {
    const t = new NewNodeAlertTracker(fakeGate({ admit: vi.fn().mockResolvedValue({ allow: true, suppressedSinceLast: 3 }) }));
    expect(await t.admitGated('s', 'k', true)).toEqual({ alert: true, suppressedCount: 3 });
  });
  it('omits suppressedCount when none', async () => {
    const t = new NewNodeAlertTracker(fakeGate());
    expect(await t.admitGated('s', 'k', true)).toEqual({ alert: true });
  });
});
