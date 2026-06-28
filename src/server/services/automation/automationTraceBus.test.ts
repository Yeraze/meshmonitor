import { describe, it, expect, beforeEach } from 'vitest';
import { automationTraceBus, MAX_TRACE_MS } from './automationTraceBus.js';

const FUTURE = 9_000_000_000_000; // far-future expiry (epoch ms)

describe('automationTraceBus', () => {
  beforeEach(() => { automationTraceBus.reset(); automationTraceBus.setSink(null); });

  it('isTracing/activeCount reflect armed rules', () => {
    expect(automationTraceBus.activeCount()).toBe(0);
    expect(automationTraceBus.isTracing('a', 0)).toBe(false);
    automationTraceBus.arm('a', 'sock1', FUTURE);
    expect(automationTraceBus.activeCount()).toBe(1);
    expect(automationTraceBus.isTracing('a', 0)).toBe(true);
    expect(automationTraceBus.isTracing('b', 0)).toBe(false);
  });

  it('expires (and prunes) once past expiry', () => {
    automationTraceBus.arm('a', 'sock1', 1000);
    expect(automationTraceBus.isTracing('a', 999)).toBe(true);
    expect(automationTraceBus.isTracing('a', 1001)).toBe(false); // expired → pruned
    expect(automationTraceBus.activeCount()).toBe(0);
  });

  it('refcounts sockets: a rule stays armed until the last socket disarms', () => {
    automationTraceBus.arm('a', 's1', FUTURE);
    automationTraceBus.arm('a', 's2', FUTURE);
    automationTraceBus.disarm('a', 's1');
    expect(automationTraceBus.isTracing('a', 0)).toBe(true);
    automationTraceBus.disarm('a', 's2');
    expect(automationTraceBus.isTracing('a', 0)).toBe(false);
  });

  it('disarmSocket drops a disconnected socket from every rule', () => {
    automationTraceBus.arm('a', 's1', FUTURE);
    automationTraceBus.arm('b', 's1', FUTURE);
    automationTraceBus.arm('b', 's2', FUTURE);
    automationTraceBus.disarmSocket('s1');
    expect(automationTraceBus.isTracing('a', 0)).toBe(false); // s1 was the only one
    expect(automationTraceBus.isTracing('b', 0)).toBe(true);  // s2 still there
  });

  it('emit only delivers for armed, non-expired rules with a sink', () => {
    const got: Array<{ id: string; payload: unknown }> = [];
    automationTraceBus.setSink((id, payload) => got.push({ id, payload }));

    automationTraceBus.emit('a', { x: 1 }, 0);            // not armed → dropped
    automationTraceBus.arm('a', 's1', FUTURE);
    automationTraceBus.emit('a', { x: 2 }, 0);            // armed → delivered
    automationTraceBus.emit('a', { x: 3 }, FUTURE + 1);  // expired → dropped

    expect(got).toEqual([{ id: 'a', payload: { x: 2 } }]);
  });

  it('caps a session at MAX_TRACE_MS (sanity on the exported constant)', () => {
    expect(MAX_TRACE_MS).toBe(5 * 60_000);
  });
});
