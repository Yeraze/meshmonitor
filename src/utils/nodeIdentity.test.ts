/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { unifiedNodeKey, isNodeEmphasized, selectionOpacity, SELECTION_DIM_OPACITY } from './nodeIdentity';
import { mergeUnifiedSourceData, type UnifiedSourceBundle } from '../hooks/useDashboardData';

describe('unifiedNodeKey', () => {
  it('keys a Meshtastic node on nodeNum', () => {
    expect(unifiedNodeKey({ nodeNum: 5 })).toBe('mt:5');
  });

  it('keys a MeshCore node on publicKey', () => {
    expect(unifiedNodeKey({ isMeshCore: true, publicKey: 'ab' })).toBe('mc:ab');
  });

  it('falls back to nodeId when a MeshCore node has no publicKey', () => {
    expect(unifiedNodeKey({ isMeshCore: true, nodeId: 'mc:x' })).toBe('mc:mc:x');
  });

  it('returns null for a MeshCore node with neither publicKey nor nodeId', () => {
    expect(unifiedNodeKey({ isMeshCore: true })).toBeNull();
  });

  it('returns null for a Meshtastic node missing nodeNum', () => {
    expect(unifiedNodeKey({})).toBeNull();
  });

  // #4573 — every case below used to return null, which made
  // mergeUnifiedSourceData drop the node from the unified view while the
  // per-source view kept showing it.
  describe('identity fallbacks (#4573)', () => {
    it('accepts a BIGINT nodeNum that arrived as a numeric string', () => {
      // PostgreSQL/MySQL surface nodeNum as a string; `typeof === "number"`
      // rejected it and the node vanished from the unified view.
      expect(unifiedNodeKey({ nodeNum: '2864434397' })).toBe('mt:2864434397');
    });

    it('recovers nodeNum from the hex nodeId when the numeric field is unusable', () => {
      expect(unifiedNodeKey({ nodeId: '!aabbccdd' })).toBe(`mt:${0xaabbccdd}`);
    });

    it('buckets the numeric and hex forms of the same node together', () => {
      // The whole point of preferring the numeric identity: one physical node
      // reported both ways by two sources must not split into two rows.
      expect(unifiedNodeKey({ nodeNum: 0xaabbccdd })).toBe(unifiedNodeKey({ nodeId: '!aabbccdd' }));
      expect(unifiedNodeKey({ nodeNum: '2864434397' })).toBe(unifiedNodeKey({ nodeId: '!aabbccdd' }));
    });

    it('keys nodeNum 0 rather than treating it as absent', () => {
      expect(unifiedNodeKey({ nodeNum: 0 })).toBe('mt:0');
    });

    it('falls back to any stable string id before giving up', () => {
      expect(unifiedNodeKey({ nodeId: 'weird-but-stable' })).toBe('mt:weird-but-stable');
    });

    it('still returns null when there is no identity at all', () => {
      expect(unifiedNodeKey({ nodeNum: null, nodeId: null })).toBeNull();
      expect(unifiedNodeKey({ nodeNum: 'not-a-number' })).toBeNull();
    });
  });
});

describe('unified view never undercounts (#4573)', () => {
  const bundle = (sourceId: string, nodes: unknown[]): UnifiedSourceBundle => ({
    sourceId,
    sourceName: sourceId,
    protocol: 'Meshtastic',
    nodes,
    traceroutes: [],
    neighborInfo: [],
    channels: [],
  });

  it('keeps a node whose nodeNum arrived as a BIGINT string', () => {
    const merged = mergeUnifiedSourceData([
      bundle('src-1', [{ nodeNum: '111', longName: 'A' }, { nodeNum: 222, longName: 'B' }]),
    ]);
    // Before the fix the string-nodeNum row was dropped and this was 1.
    expect(merged.nodes).toHaveLength(2);
  });

  it('merges the numeric and hex forms of one node across two sources into one row', () => {
    const merged = mergeUnifiedSourceData([
      bundle('src-1', [{ nodeNum: 0xaabbccdd, nodeId: '!aabbccdd', longName: 'Same Node' }]),
      bundle('src-2', [{ nodeId: '!aabbccdd', longName: 'Same Node' }]),
    ]);
    expect(merged.nodes).toHaveLength(1);
    expect((merged.nodes[0] as { sources?: unknown[] }).sources).toHaveLength(2);
  });

  it('never returns fewer nodes than the largest single source contributed', () => {
    // The invariant the reported symptom violates. A union cannot be smaller
    // than any of its inputs, so any view showing fewer nodes than one of its
    // sources is dropping rows, not over-merging them.
    const sourceA = [{ nodeNum: 1 }, { nodeNum: 2 }, { nodeNum: 3 }];
    const sourceB = [{ nodeNum: 3 }, { nodeNum: 4 }];
    const sourceC = [{ nodeNum: '5' }, { nodeId: '!00000006' }];

    const merged = mergeUnifiedSourceData([
      bundle('src-a', sourceA),
      bundle('src-b', sourceB),
      bundle('src-c', sourceC),
    ]);

    const largestSource = Math.max(sourceA.length, sourceB.length, sourceC.length);
    expect(merged.nodes.length).toBeGreaterThanOrEqual(largestSource);
    // nodeNums 1,2,3,4,5,6 — 3 is shared by A and B and must collapse to one.
    expect(merged.nodes).toHaveLength(6);
  });
});

describe('unifiedNodeKey drift guard', () => {
  it('matches the bucketing that mergeUnifiedSourceData performs internally', () => {
    const perSource: UnifiedSourceBundle[] = [
      {
        sourceId: 'src-1',
        sourceName: 'Source One',
        protocol: 'Meshtastic',
        nodes: [{ nodeNum: 42, lastHeard: 1000, longName: 'Meshtastic Node' }],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
      {
        sourceId: 'src-2',
        sourceName: 'Source Two',
        protocol: 'MeshCore',
        nodes: [
          {
            isMeshCore: true,
            nodeNum: 0,
            nodeId: 'mc:src-2:abc123',
            publicKey: 'abc123',
            lastHeard: 2000,
            longName: 'MeshCore Node',
          },
        ],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
    ];

    const merged = mergeUnifiedSourceData(perSource);
    expect(merged.nodes).toHaveLength(2);

    const keys = merged.nodes.map((n) => unifiedNodeKey(n as any)).sort();
    expect(keys).toEqual(['mc:abc123', 'mt:42']);

    // Every merged node's recomputed key must be non-null — mergeUnifiedSourceData
    // only ever buckets nodes for which unifiedNodeKey returns a real key.
    for (const n of merged.nodes) {
      expect(unifiedNodeKey(n as any)).not.toBeNull();
    }
  });
});

describe('isNodeEmphasized', () => {
  it('treats every key as emphasized when the selection is empty', () => {
    expect(isNodeEmphasized('mt:1', [])).toBe(true);
    expect(isNodeEmphasized(null, [])).toBe(true);
  });

  it('emphasizes only member keys when the selection is non-empty', () => {
    expect(isNodeEmphasized('mt:1', ['mt:1', 'mc:ab'])).toBe(true);
    expect(isNodeEmphasized('mt:2', ['mt:1', 'mc:ab'])).toBe(false);
  });

  it('never emphasizes a null key when the selection is non-empty', () => {
    expect(isNodeEmphasized(null, ['mt:1'])).toBe(false);
  });
});

describe('selectionOpacity', () => {
  it('returns the base opacity unchanged when emphasized', () => {
    expect(selectionOpacity(1, true)).toBe(1);
  });

  it('scales down by SELECTION_DIM_OPACITY when not emphasized', () => {
    expect(selectionOpacity(1, false)).toBe(SELECTION_DIM_OPACITY);
    expect(selectionOpacity(0.7, false)).toBeCloseTo(0.7 * SELECTION_DIM_OPACITY);
  });
});
