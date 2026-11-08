import { describe, it, expect } from 'vitest';
import { hopLinksToRenderSegments, meshcorePositionKey } from './meshcoreTraceSegments';
import type { SourcedMeshCoreHopLink } from '../services/analysisApi';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const C = 'cc'.repeat(32);
const end = (k: string | null, candidates = k ? 1 : 0) => ({ publicKey: k, hash: null, candidates });
const link = (over: Partial<SourcedMeshCoreHopLink> & { s: string | null; r: string | null }): SourcedMeshCoreHopLink => ({
  sourceId: 'src',
  sender: end(over.s),
  receiver: end(over.r),
  count: 4,
  lastSnr: 6,
  avgSnr: 6,
  minSnr: 2,
  maxSnr: 9,
  lastTimestamp: 1000,
  initiatedCount: 0,
  points: [],
  ...over,
});
const pos = new Map<string, [number, number]>([
  [meshcorePositionKey('src', A), [1, 1]],
  [meshcorePositionKey('src', B), [2, 2]],
  [meshcorePositionKey('src', C), [3, 3]],
]);
const opts = { directionMode: 'both' as const, scopeToSelectedNode: true, minOccurrences: 1, minSnr: null };

describe('hopLinksToRenderSegments', () => {
  it('draws resolved links with fromKey/toKey and positions, neutral without a selection', () => {
    const [s] = hopLinksToRenderSegments([link({ s: A, r: B })], pos, null, opts);
    expect(s).toMatchObject({ fromKey: A, toKey: B, from: [1, 1], to: [2, 2], direction: 'neutral', occurrences: 4, avgSnr: 6 });
    expect(s.fromNodeNum).toBeUndefined();
  });

  it('skips unresolved/ambiguous ends, self links and unpositioned nodes', () => {
    const links = [
      link({ s: null, r: B }),
      link({ s: A, r: B, receiver: end(B, 2) }),
      link({ s: A, r: A }),
      link({ s: A, r: 'dd'.repeat(32) }),
    ];
    expect(hopLinksToRenderSegments(links, pos, null, opts)).toEqual([]);
  });

  it('applies minOccurrences and minSnr', () => {
    const links = [link({ s: A, r: B, count: 1 }), link({ s: B, r: C, avgSnr: -4 })];
    expect(hopLinksToRenderSegments(links, pos, null, { ...opts, minOccurrences: 2 })).toHaveLength(1);
    const r = hopLinksToRenderSegments(links, pos, null, { ...opts, minSnr: 0 });
    expect(r.map((x) => x.toKey)).toEqual([B]);
  });

  it('scopes to the selected node and classifies direction (receiver heard sender)', () => {
    const links = [link({ s: A, r: B }), link({ s: B, r: C }), link({ s: A, r: C })];
    const both = hopLinksToRenderSegments(links, pos, `mc:${B}`, opts);
    expect(both.map((x) => [x.fromKey, x.direction])).toEqual([[A, 'inbound'], [B, 'outbound']]);
    expect(hopLinksToRenderSegments(links, pos, `mc:${B}`, { ...opts, directionMode: 'inbound' })).toHaveLength(1);
    expect(hopLinksToRenderSegments(links, pos, `mc:${B}`, { ...opts, directionMode: 'outbound' })[0].toKey).toBe(C);
    // scope off: everything, all neutral
    const all = hopLinksToRenderSegments(links, pos, `mc:${B}`, { ...opts, scopeToSelectedNode: false });
    expect(all).toHaveLength(3);
    expect(all.every((x) => x.direction === 'neutral')).toBe(true);
  });

  it('ignores a Meshtastic selection key and honours the time window', () => {
    const links = [link({ s: A, r: B, lastTimestamp: 50 })];
    expect(hopLinksToRenderSegments(links, pos, 'mt:123', opts)[0].direction).toBe('neutral');
    expect(hopLinksToRenderSegments(links, pos, null, { ...opts, timeWindow: { startMs: 100, endMs: 200 } })).toEqual([]);
  });

  it('keeps sources apart: the same key on another source needs its own position', () => {
    const l = link({ s: A, r: B, sourceId: 'other' });
    expect(hopLinksToRenderSegments([l], pos, null, opts)).toEqual([]);
  });
});
