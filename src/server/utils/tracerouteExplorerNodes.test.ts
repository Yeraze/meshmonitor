import { describe, it, expect } from 'vitest';
import { mergeExplorerNodes, type ExplorerNodeRow } from './tracerouteExplorerNodes.js';

const row = (o: Partial<ExplorerNodeRow>): ExplorerNodeRow => ({ nodeNum: 1, sourceId: 'a', ...o });

describe('mergeExplorerNodes', () => {
  it('takes names from the newest-heard row and position from the newest positioned row', () => {
    const nodes = mergeExplorerNodes(
      [
        row({ sourceId: 'a', longName: 'Old', shortName: 'OLD', lastHeard: 100, latitude: 10, longitude: 20 }),
        row({ sourceId: 'b', longName: 'New', shortName: 'NEW', lastHeard: 200 }),
      ],
      [1],
      new Map(),
    );
    expect(nodes).toEqual([
      expect.objectContaining({ nodeNum: 1, longName: 'New', shortName: 'NEW', latitude: 10, longitude: 20 }),
    ]);
  });

  it('gives an unknown node a hex id and no position', () => {
    const [n] = mergeExplorerNodes([], [0xabcd], new Map());
    expect(n).toEqual({
      nodeNum: 0xabcd, nodeId: '!0000abcd', shortName: null, longName: null,
      role: null, hwModel: null, latitude: null, longitude: null,
    });
  });

  it('skips Null Island and uses a position override when enabled', () => {
    const [bogus] = mergeExplorerNodes([row({ latitude: 0, longitude: 0 })], [1], new Map());
    expect(bogus.latitude).toBeNull();

    const [override] = mergeExplorerNodes(
      [row({ latitude: 1, longitude: 2, positionOverrideEnabled: 1, latitudeOverride: 5, longitudeOverride: 6 })],
      [1],
      new Map(),
    );
    expect(override).toMatchObject({ latitude: 5, longitude: 6 });
  });
});
