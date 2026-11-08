/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { buildHopByKey, lookupHops, hopMapKey, useHopByKey } from './useHopByKey';

vi.mock('./useMapAnalysisData', () => ({
  useHopCounts: () => ({
    data: {
      entries: [
        { sourceId: 's', nodeNum: 5, hops: 2, nodeKey: 'mt:5' },
        { sourceId: 's', nodeNum: 5, hops: 4, nodeKey: `mc:${'AB'.repeat(32)}`, publicKey: 'AB'.repeat(32) },
        { sourceId: 's', nodeNum: 9, hops: 1 },
      ],
    },
  }),
}));

describe('useHopByKey', () => {
  it('keys by sourceId|nodeKey so a MeshCore synthetic nodeNum never collides with a Meshtastic node', () => {
    const { result } = renderHook(() => useHopByKey({ enabled: true, sources: ['s'] }));
    const m = result.current.hopByKey;
    expect(lookupHops(m, 's', { nodeNum: 5 })).toBe(2);
    expect(lookupHops(m, 's', { isMeshCore: true, publicKey: 'ab'.repeat(32) })).toBe(4);
    // entry without nodeKey (older server) falls back to mt:<nodeNum>
    expect(lookupHops(m, 's', { nodeNum: 9 })).toBe(1);
    expect(lookupHops(m, 'other', { nodeNum: 5 })).toBeUndefined();
    expect(lookupHops(m, 's', { isMeshCore: true, nodeNum: 5 })).toBeUndefined();
  });

  it('buildHopByKey handles undefined and normalises mc keys', () => {
    expect(buildHopByKey(undefined).size).toBe(0);
    expect(hopMapKey('s', 'mc:AB')).toBe('s|mc:ab');
  });
});
