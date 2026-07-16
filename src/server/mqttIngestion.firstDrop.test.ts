/**
 * Unit tests for the first-drop-per-node noise-suppression tracker used by
 * `ingestServiceEnvelope` (see mqttIngestion.ts) to log the first
 * ignore/geo-ignore drop for a given (sourceId, nodeNum) pair at info and
 * silence subsequent repeats to debug.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { firstDropForNode, __resetFirstDropCacheForTest } from './mqttIngestion.js';

describe('firstDropForNode', () => {
  beforeEach(() => {
    __resetFirstDropCacheForTest();
  });

  it('returns true the first time a (source, node) pair is dropped', () => {
    expect(firstDropForNode('src-a', 123)).toBe(true);
  });

  it('returns false for subsequent drops of the same (source, node) pair', () => {
    expect(firstDropForNode('src-a', 123)).toBe(true);
    expect(firstDropForNode('src-a', 123)).toBe(false);
    expect(firstDropForNode('src-a', 123)).toBe(false);
  });

  it('tracks independently across different sourceIds for the same nodeNum', () => {
    expect(firstDropForNode('src-a', 123)).toBe(true);
    expect(firstDropForNode('src-b', 123)).toBe(true);
    // repeats on each source are still suppressed independently
    expect(firstDropForNode('src-a', 123)).toBe(false);
    expect(firstDropForNode('src-b', 123)).toBe(false);
  });

  it('tracks independently across different nodeNums for the same sourceId', () => {
    expect(firstDropForNode('src-a', 1)).toBe(true);
    expect(firstDropForNode('src-a', 2)).toBe(true);
    expect(firstDropForNode('src-a', 1)).toBe(false);
    expect(firstDropForNode('src-a', 2)).toBe(false);
  });

  it('resets cleanly between test cases via __resetFirstDropCacheForTest', () => {
    expect(firstDropForNode('src-a', 123)).toBe(true);
    expect(firstDropForNode('src-a', 123)).toBe(false);
    __resetFirstDropCacheForTest();
    expect(firstDropForNode('src-a', 123)).toBe(true);
  });

  it('behaves independently across a few hundred distinct keys (pragmatic stand-in for overflow behavior)', () => {
    // The tracker is bounded (DROPPED_ONCE_MAX = 10_000) and clears itself on
    // overflow rather than growing unbounded; the constant isn't exported, so
    // rather than filling to the exact cap we assert the per-key semantics
    // hold at meaningful scale, which is what the overflow-clear preserves
    // (best-effort logging aid, not correctness state).
    const total = 500;
    for (let i = 0; i < total; i++) {
      expect(firstDropForNode('src-bulk', i)).toBe(true);
    }
    for (let i = 0; i < total; i++) {
      expect(firstDropForNode('src-bulk', i)).toBe(false);
    }
  });
});
