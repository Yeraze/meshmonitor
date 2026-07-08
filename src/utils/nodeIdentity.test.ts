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
