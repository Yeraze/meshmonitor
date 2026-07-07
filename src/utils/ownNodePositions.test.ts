import { describe, it, expect } from 'vitest';
import { getOwnNodePositions } from './ownNodePositions';

describe('getOwnNodePositions', () => {
  it('resolves a source own-node position from a nested position record', () => {
    const nodes = [
      { nodeNum: 100, position: { latitude: 35, longitude: -80 } },
      { nodeNum: 200, position: { latitude: 36, longitude: -81 } },
    ];
    const out = getOwnNodePositions(nodes, new Map([['src-a', 100]]));
    expect(out).toEqual([{ sourceId: 'src-a', lat: 35, lng: -80 }]);
  });

  it('resolves from a flat lat/lng record', () => {
    const nodes = [{ nodeNum: 100, latitude: 40, longitude: -70 }];
    const out = getOwnNodePositions(nodes, new Map([['s', 100]]));
    expect(out).toEqual([{ sourceId: 's', lat: 40, lng: -70 }]);
  });

  it('returns one entry per source that has a local nodeNum with a position', () => {
    const nodes = [
      { nodeNum: 1, position: { latitude: 10, longitude: 10 } },
      { nodeNum: 2, position: { latitude: 20, longitude: 20 } },
    ];
    const out = getOwnNodePositions(
      nodes,
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out).toContainEqual({ sourceId: 'a', lat: 10, lng: 10 });
    expect(out).toContainEqual({ sourceId: 'b', lat: 20, lng: 20 });
  });

  it('skips a source whose local nodeNum is null/undefined (MeshCore / disconnected)', () => {
    const nodes = [{ nodeNum: 1, position: { latitude: 10, longitude: 10 } }];
    const out = getOwnNodePositions(
      nodes,
      new Map<string, number | null | undefined>([
        ['a', null],
        ['b', undefined],
      ]),
    );
    expect(out).toEqual([]);
  });

  it('skips a source whose local node has no resolvable position', () => {
    const nodes = [{ nodeNum: 1, position: null }];
    const out = getOwnNodePositions(nodes, new Map([['a', 1]]));
    expect(out).toEqual([]);
  });

  it('rejects a Null Island (0,0) local-node position', () => {
    const nodes = [{ nodeNum: 1, position: { latitude: 0, longitude: 0 } }];
    const out = getOwnNodePositions(nodes, new Map([['a', 1]]));
    expect(out).toEqual([]);
  });

  it('coerces string nodeNum values (BIGINT-backed rows) before matching', () => {
    const nodes = [{ nodeNum: '100', position: { latitude: 1, longitude: 2 } }];
    const out = getOwnNodePositions(nodes, new Map([['a', 100]]));
    expect(out).toEqual([{ sourceId: 'a', lat: 1, lng: 2 }]);
  });

  it('returns empty when no node matches the local nodeNum', () => {
    const nodes = [{ nodeNum: 999, position: { latitude: 1, longitude: 2 } }];
    const out = getOwnNodePositions(nodes, new Map([['a', 100]]));
    expect(out).toEqual([]);
  });
});
