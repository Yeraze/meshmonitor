/**
 * Tests for auto-traceroute last-heard and hop-range filter logic.
 *
 * These tests verify the AND filter logic that runs after nodes are fetched
 * from the database but before the OR/UNION filters are applied.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The filter logic extracted as pure functions for testability.
// These mirror the inline filter logic in getNodeNeedingTraceroute / getNodeNeedingTracerouteAsync.

interface TestNode {
  nodeNum: number;
  lastHeard: number | null;
  hopsAway: number | null | undefined;
}

function applyLastHeardFilter(nodes: TestNode[], enabled: boolean, hours: number): TestNode[] {
  if (!enabled) return nodes;
  const lastHeardCutoff = Math.floor(Date.now() / 1000) - (hours * 3600);
  return nodes.filter(node => node.lastHeard != null && node.lastHeard >= lastHeardCutoff);
}

function applyHopRangeFilter(nodes: TestNode[], enabled: boolean, min: number, max: number): TestNode[] {
  if (!enabled) return nodes;
  return nodes.filter(node => {
    const hops = node.hopsAway ?? 1;
    return hops >= min && hops <= max;
  });
}

describe('Auto-Traceroute Filters', () => {
  // Pin time so the boundary-case "heard 1 hour ago with a 1-hour window"
  // doesn't flake on slow CI: the `nowSeconds` captured at describe-load and
  // the `Date.now()` inside applyLastHeardFilter must see the same second.
  const FIXED_NOW_MS = 1_700_000_000_000;
  const nowSeconds = Math.floor(FIXED_NOW_MS / 1000);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper to create a node with lastHeard relative to now
  const makeNode = (nodeNum: number, hoursAgo: number | null, hopsAway: number | null = null): TestNode => ({
    nodeNum,
    lastHeard: hoursAgo !== null ? nowSeconds - (hoursAgo * 3600) : null,
    hopsAway,
  });

  describe('Last Heard Filter', () => {
    const nodes = [
      makeNode(1, 1),       // heard 1 hour ago
      makeNode(2, 12),      // heard 12 hours ago
      makeNode(3, 48),      // heard 2 days ago
      makeNode(4, 200),     // heard 8+ days ago
      makeNode(5, null),    // never heard
    ];

    it('should pass all nodes when disabled', () => {
      const result = applyLastHeardFilter(nodes, false, 24);
      expect(result).toHaveLength(5);
    });

    it('should filter nodes older than the cutoff', () => {
      const result = applyLastHeardFilter(nodes, true, 24);
      expect(result.map(n => n.nodeNum)).toEqual([1, 2]);
    });

    it('should exclude nodes with null lastHeard', () => {
      const result = applyLastHeardFilter(nodes, true, 999);
      expect(result.map(n => n.nodeNum)).toEqual([1, 2, 3, 4]);
      expect(result.find(n => n.nodeNum === 5)).toBeUndefined();
    });

    it('should filter with a 7-day window (168 hours)', () => {
      const result = applyLastHeardFilter(nodes, true, 168);
      expect(result.map(n => n.nodeNum)).toEqual([1, 2, 3]);
    });

    it('should filter with a very short window', () => {
      const result = applyLastHeardFilter(nodes, true, 1);
      expect(result.map(n => n.nodeNum)).toEqual([1]);
    });
  });

  describe('Hop Range Filter', () => {
    const nodes: TestNode[] = [
      { nodeNum: 1, lastHeard: nowSeconds, hopsAway: null },      // direct (null → 1)
      { nodeNum: 2, lastHeard: nowSeconds, hopsAway: undefined },  // direct (undefined → 1)
      { nodeNum: 3, lastHeard: nowSeconds, hopsAway: 1 },          // 1 hop
      { nodeNum: 4, lastHeard: nowSeconds, hopsAway: 3 },          // 3 hops
      { nodeNum: 5, lastHeard: nowSeconds, hopsAway: 5 },          // 5 hops
      { nodeNum: 6, lastHeard: nowSeconds, hopsAway: 8 },          // 8 hops
    ];

    it('should pass all nodes when disabled', () => {
      const result = applyHopRangeFilter(nodes, false, 0, 10);
      expect(result).toHaveLength(6);
    });

    it('should filter by min and max hops', () => {
      const result = applyHopRangeFilter(nodes, true, 2, 5);
      expect(result.map(n => n.nodeNum)).toEqual([4, 5]);
    });

    it('should treat null hopsAway as 1 (direct neighbor)', () => {
      const result = applyHopRangeFilter(nodes, true, 0, 1);
      // Nodes 1 (null→1), 2 (undefined→1), and 3 (explicit 1)
      expect(result.map(n => n.nodeNum)).toEqual([1, 2, 3]);
    });

    it('should treat undefined hopsAway as 1', () => {
      const result = applyHopRangeFilter(nodes, true, 2, 10);
      // null/undefined treated as 1, so excluded by min=2
      expect(result.find(n => n.nodeNum === 1)).toBeUndefined();
      expect(result.find(n => n.nodeNum === 2)).toBeUndefined();
    });

    it('should allow single-hop filter (min equals max)', () => {
      const result = applyHopRangeFilter(nodes, true, 3, 3);
      expect(result.map(n => n.nodeNum)).toEqual([4]);
    });

    it('should allow max hops of 0 (excludes everything except 0-hop)', () => {
      const result = applyHopRangeFilter(nodes, true, 0, 0);
      // No nodes have 0 hops (null/undefined → 1)
      expect(result).toHaveLength(0);
    });
  });

  describe('Combined Filters (AND logic)', () => {
    const nodes = [
      makeNode(1, 1, 2),       // recent, 2 hops — should pass both
      makeNode(2, 200, 2),     // stale, 2 hops — fails last-heard
      makeNode(3, 1, 8),       // recent, 8 hops — fails hop range
      makeNode(4, 200, 8),     // stale, 8 hops — fails both
      makeNode(5, null, 3),    // never heard, 3 hops — fails last-heard
    ];

    it('should apply both filters as AND conditions', () => {
      let result = applyLastHeardFilter(nodes, true, 24);
      result = applyHopRangeFilter(result, true, 1, 5);
      expect(result.map(n => n.nodeNum)).toEqual([1]);
    });

    it('should pass all when both disabled', () => {
      let result = applyLastHeardFilter(nodes, false, 24);
      result = applyHopRangeFilter(result, false, 1, 5);
      expect(result).toHaveLength(5);
    });

    it('should apply only last-heard when hops disabled', () => {
      let result = applyLastHeardFilter(nodes, true, 24);
      result = applyHopRangeFilter(result, false, 1, 5);
      expect(result.map(n => n.nodeNum)).toEqual([1, 3]);
    });

    it('should apply only hops when last-heard disabled', () => {
      let result = applyLastHeardFilter(nodes, false, 24);
      result = applyHopRangeFilter(result, true, 1, 5);
      expect(result.map(n => n.nodeNum)).toEqual([1, 2, 5]);
    });
  });
});
