/**
 * Regression tests for mergeNodesAcrossSources (issue #3135).
 *
 * Without the merge step the unified Nodes view showed nodes once per source,
 * so a node heard on both an RF source (with NodeInfo) and an MQTT-bridged
 * source (without) appeared twice — once labeled, once as `Node <nodeNum>`.
 */
import { describe, it, expect } from 'vitest';
import type { DbNode } from '../../db/types.js';
import { mergeNodesAcrossSources } from './mergeNodesAcrossSources.js';

function makeNode(nodeNum: number, overrides: Partial<DbNode> = {}): DbNode {
  return {
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: null,
    shortName: null,
    hwModel: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  } as DbNode;
}

describe('mergeNodesAcrossSources (issue #3135)', () => {
  it('returns the input unchanged when there are no duplicates', () => {
    const rows = [
      makeNode(100, { longName: 'Alpha', updatedAt: 3000 }),
      makeNode(101, { longName: 'Bravo', updatedAt: 2000 }),
    ];
    const merged = mergeNodesAcrossSources(rows);
    expect(merged.length).toBe(2);
    expect(merged.map((n) => n.nodeNum).sort()).toEqual([100, 101]);
  });

  it('backfills labels from the older source when the newer one has none', () => {
    const rows: DbNode[] = [
      // Older source heard a full NodeInfo, then the newer source only saw a
      // bare transit packet and never learned the labels.
      makeNode(200, {
        longName: 'Real Name',
        shortName: 'RN',
        hwModel: 9,
        lastHeard: 1000,
        updatedAt: 1000,
      }),
      makeNode(200, {
        longName: null,
        shortName: null,
        hwModel: null,
        lastHeard: 2000,
        updatedAt: 2000,
      }),
    ];

    const merged = mergeNodesAcrossSources(rows);
    expect(merged.length).toBe(1);
    expect(merged[0].longName).toBe('Real Name');
    expect(merged[0].shortName).toBe('RN');
    expect(merged[0].hwModel).toBe(9);
    expect(merged[0].lastHeard).toBe(2000);
  });

  it('treats empty strings as missing and back-fills them', () => {
    const rows: DbNode[] = [
      makeNode(201, { longName: 'Real Name', lastHeard: 1000, updatedAt: 1000 }),
      makeNode(201, { longName: '   ', lastHeard: 2000, updatedAt: 2000 }),
    ];
    const [merged] = mergeNodesAcrossSources(rows);
    expect(merged.longName).toBe('Real Name');
  });

  it('keeps the newer source\'s values when both have a label', () => {
    const rows: DbNode[] = [
      makeNode(300, {
        longName: 'Old Name',
        shortName: 'OLD',
        lastHeard: 1000,
        updatedAt: 1000,
      }),
      makeNode(300, {
        longName: 'New Name',
        shortName: 'NEW',
        lastHeard: 2000,
        updatedAt: 2000,
      }),
    ];

    const [merged] = mergeNodesAcrossSources(rows);
    expect(merged.longName).toBe('New Name');
    expect(merged.shortName).toBe('NEW');
  });

  it('OR\'s isFavorite and isIgnored across sources', () => {
    const rows: DbNode[] = [
      makeNode(400, { isFavorite: true, isIgnored: false, lastHeard: 1000 }),
      makeNode(400, { isFavorite: false, isIgnored: true, lastHeard: 2000 }),
    ];
    const [merged] = mergeNodesAcrossSources(rows);
    expect(merged.isFavorite).toBe(true);
    expect(merged.isIgnored).toBe(true);
  });

  it('ORs hideFromMap across sources (#4137): winner false + older true -> merged true', () => {
    const rows: DbNode[] = [
      makeNode(401, { hideFromMap: false, lastHeard: 2000 }),
      makeNode(401, { hideFromMap: true, lastHeard: 1000 }),
    ];
    const [merged] = mergeNodesAcrossSources(rows);
    expect(merged.hideFromMap).toBe(true);
  });

  it('#4137: hideFromMap stays false when every source has it false', () => {
    const rows: DbNode[] = [
      makeNode(402, { hideFromMap: false, lastHeard: 2000 }),
      makeNode(402, { hideFromMap: false, lastHeard: 1000 }),
    ];
    const [merged] = mergeNodesAcrossSources(rows);
    expect(merged.hideFromMap).toBe(false);
  });

  it('exposes the max lastHeard / updatedAt across the group', () => {
    const rows: DbNode[] = [
      makeNode(500, { lastHeard: 5000, updatedAt: 5500 }),
      makeNode(500, { lastHeard: 9000, updatedAt: 4000 }),
      makeNode(500, { lastHeard: 7000, updatedAt: 9500 }),
    ];
    const [merged] = mergeNodesAcrossSources(rows);
    expect(merged.lastHeard).toBe(9000);
    expect(merged.updatedAt).toBe(9500);
  });

  it('back-fills position from a source that knows it', () => {
    const rows: DbNode[] = [
      makeNode(600, {
        latitude: 35.123,
        longitude: -90.456,
        altitude: 150,
        lastHeard: 1000,
      }),
      makeNode(600, {
        latitude: null,
        longitude: null,
        altitude: null,
        lastHeard: 2000,
      }),
    ];
    const [merged] = mergeNodesAcrossSources(rows);
    expect(merged.latitude).toBeCloseTo(35.123);
    expect(merged.longitude).toBeCloseTo(-90.456);
    expect(merged.altitude).toBe(150);
  });

  it('preserves the newer position when both sources have one', () => {
    const rows: DbNode[] = [
      makeNode(601, {
        latitude: 35.0,
        longitude: -90.0,
        lastHeard: 1000,
        updatedAt: 1000,
      }),
      makeNode(601, {
        latitude: 36.0,
        longitude: -91.0,
        lastHeard: 2000,
        updatedAt: 2000,
      }),
    ];
    const [merged] = mergeNodesAcrossSources(rows);
    expect(merged.latitude).toBeCloseTo(36.0);
    expect(merged.longitude).toBeCloseTo(-91.0);
  });

  it('handles three sources with mixed coverage', () => {
    const rows: DbNode[] = [
      makeNode(700, { longName: 'Full Name', shortName: 'FN', lastHeard: 500 }),
      makeNode(700, { latitude: 10, longitude: 20, lastHeard: 1500 }),
      makeNode(700, { hwModel: 31, lastHeard: 1000 }),
    ];
    const merged = mergeNodesAcrossSources(rows);
    expect(merged.length).toBe(1);
    expect(merged[0].longName).toBe('Full Name');
    expect(merged[0].shortName).toBe('FN');
    expect(merged[0].latitude).toBe(10);
    expect(merged[0].longitude).toBe(20);
    expect(merged[0].hwModel).toBe(31);
    expect(merged[0].lastHeard).toBe(1500);
  });

  it('returns empty array unchanged', () => {
    expect(mergeNodesAcrossSources([])).toEqual([]);
  });

  it('orders the result by updatedAt descending', () => {
    const rows: DbNode[] = [
      makeNode(800, { updatedAt: 1000 }),
      makeNode(801, { updatedAt: 3000 }),
      makeNode(802, { updatedAt: 2000 }),
    ];
    const merged = mergeNodesAcrossSources(rows);
    expect(merged.map((n) => n.nodeNum)).toEqual([801, 802, 800]);
  });

  // #4573 pinned the unified undercount on this function grouping by nodeNum
  // alone. Grouping by nodeNum is deliberate (#3135: one physical node heard by
  // N sources is ONE row), and it cannot produce an undercount: the output is
  // exactly the distinct-nodeNum count, and each source's own rows already have
  // distinct nodeNums thanks to the composite PK. So the result is always at
  // least as large as the biggest single source. A unified view showing fewer
  // nodes than one of its sources is dropping rows somewhere else — for the
  // real cause see unifiedNodeKey / mergeUnifiedSourceData on the client.
  describe('cannot undercount relative to a single source (#4573)', () => {
    it('returns at least as many nodes as the largest contributing source', () => {
      const sourceA = [makeNode(1), makeNode(2), makeNode(3)].map((n) => ({
        ...n,
        sourceId: 'a',
      })) as DbNode[];
      const sourceB = [makeNode(3), makeNode(4)].map((n) => ({
        ...n,
        sourceId: 'b',
      })) as DbNode[];

      const merged = mergeNodesAcrossSources([...sourceA, ...sourceB]);

      expect(merged.length).toBeGreaterThanOrEqual(Math.max(sourceA.length, sourceB.length));
      // nodeNum 3 is the same physical node on both sources — collapsing it to
      // one row is the intended behaviour, not the bug.
      expect(merged).toHaveLength(4);
    });

    it('output size equals the distinct nodeNum count, whatever the source mix', () => {
      const rows: DbNode[] = [
        { ...makeNode(10), sourceId: 'a' } as DbNode,
        { ...makeNode(10), sourceId: 'b' } as DbNode,
        { ...makeNode(10), sourceId: 'c' } as DbNode,
        { ...makeNode(11), sourceId: 'b' } as DbNode,
      ];
      expect(mergeNodesAcrossSources(rows)).toHaveLength(2);
    });
  });
});
