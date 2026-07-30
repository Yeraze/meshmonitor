/**
 * Tests for `tracerouteAggregate.ts` (Statistical Route epic, Phase 1 WP2).
 * §4.2 of `docs/internal/dev-notes/SR_PHASE1_SPEC.md`, cases 1-44.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTracerouteUnion,
  statOpacity,
  REAL_NODE_ID_PREFIX,
  UNKNOWN_HOP_ID_PREFIX,
  MIN_STAT_OPACITY,
  type AggregateTracerouteRow,
} from './tracerouteAggregate';
import { BROADCAST_ADDR } from './tracerouteSegments';

const LOCAL = 100;
const PEER = 200;

/** Build a minimal row. `route`/`routeBack`/`snrBack` default to absent. */
function row(overrides: Partial<AggregateTracerouteRow> = {}): AggregateTracerouteRow {
  return {
    fromNodeNum: LOCAL,
    toNodeNum: PEER,
    ...overrides,
  };
}

const n = (nodeNum: number): string => `${REAL_NODE_ID_PREFIX}:${nodeNum}`;
const u = (depth: number): string => `${UNKNOWN_HOP_ID_PREFIX}:${depth}`;

describe('tracerouteAggregate — counting rules', () => {
  it('1. node counted once per row when it appears in both legs of that row', () => {
    // forward L,A,P ; return P,A,L — A appears in both legs of the same row.
    const rows = [row({ route: JSON.stringify([300]), routeBack: JSON.stringify([300]), snrBack: '[1]' })];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const nodeA = union.nodes.find((x) => x.id === n(300));
    expect(nodeA?.count).toBe(1);
  });

  it('2. node counted once per row when it appears twice in one leg (a loop)', () => {
    // forward L,A,B,A,P — A appears twice in the single forward leg.
    const rows = [row({ route: JSON.stringify([300, 400, 300]) })];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const nodeA = union.nodes.find((x) => x.id === n(300));
    expect(nodeA?.count).toBe(1);
  });

  it('3. edge counted once per row when the pair is adjacent in both legs', () => {
    // forward L,A,B,P ; return P,B,A,L — A-B adjacent in both legs of one row.
    const rows = [
      row({ route: JSON.stringify([300, 400]), routeBack: JSON.stringify([400, 300]), snrBack: '[1,1]' }),
    ];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const edgeAB = union.edges.find((e) => e.aId === n(300) && e.bId === n(400));
    expect(edgeAB?.count).toBe(1);
  });

  it('4. edge counted once per row when the pair is adjacent twice in one leg', () => {
    // forward L,A,B,A,P — (A,B) and (B,A) both undirected-A-B.
    const rows = [row({ route: JSON.stringify([300, 400, 300]) })];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const edgeAB = union.edges.find(
      (e) => (e.aId === n(300) && e.bId === n(400)) || (e.aId === n(400) && e.bId === n(300)),
    );
    expect(edgeAB?.count).toBe(1);
  });

  it('5. A→B in one row and B→A in another produce one edge with count 2', () => {
    const rows = [
      row({ route: JSON.stringify([300, 400]) }), // L,A,B,P
      row({ route: JSON.stringify([400, 300]) }), // L,B,A,P
    ];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const edgesAB = union.edges.filter(
      (e) => (e.aId === n(300) && e.bId === n(400)) || (e.aId === n(400) && e.bId === n(300)),
    );
    expect(edgesAB.length).toBe(1);
    expect(edgesAB[0].count).toBe(2);
  });

  it('6. endpoints have count === totalRoutes and share === 1', () => {
    const rows = [
      row({ route: JSON.stringify([300]) }),
      row({ route: JSON.stringify([400]) }),
      row({ route: JSON.stringify([]) }),
    ];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const local = union.nodes.find((x) => x.id === n(LOCAL));
    const peer = union.nodes.find((x) => x.id === n(PEER));
    expect(local?.count).toBe(union.totalRoutes);
    expect(local?.share).toBe(1);
    expect(peer?.count).toBe(union.totalRoutes);
    expect(peer?.share).toBe(1);
  });

  it('7. share equals count / totalRoutes for every node and edge', () => {
    const rows = [
      row({ route: JSON.stringify([300]) }),
      row({ route: JSON.stringify([]) }),
      row({ route: JSON.stringify([]) }),
    ];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    for (const nd of union.nodes) expect(nd.share).toBeCloseTo(nd.count / union.totalRoutes, 10);
    for (const e of union.edges) expect(e.share).toBeCloseTo(e.count / union.totalRoutes, 10);
  });

  it('8. self-adjacency (sequence[k] === sequence[k+1]) emits no edge', () => {
    // A repeated back-to-back can only arise via the reserved-node drop
    // collapsing two survivors into adjacent identical ids is not directly
    // constructible from a route array (identical consecutive node numbers
    // ARE possible in raw route data), so use route [300, 300].
    const rows = [row({ route: JSON.stringify([300, 300]) })];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const selfEdge = union.edges.find((e) => e.aId === n(300) && e.bId === n(300));
    expect(selfEdge).toBeUndefined();
  });
});

describe('tracerouteAggregate — direction and normalization', () => {
  it('9. a row stored (peer, local) produces the same union as (local, peer)', () => {
    const rowsForward = [row({ route: JSON.stringify([300]) })];
    const rowsReverse = [row({ fromNodeNum: PEER, toNodeNum: LOCAL, route: JSON.stringify([300]) })];
    const unionForward = buildTracerouteUnion(rowsForward, LOCAL, PEER);
    const unionReverse = buildTracerouteUnion(rowsReverse, LOCAL, PEER);
    expect(unionReverse.nodes).toEqual(unionForward.nodes);
    expect(unionReverse.edges).toEqual(unionForward.edges);
  });

  it('10. a mixed history of both orientations merges into one graph, not two', () => {
    const rows = [
      row({ route: JSON.stringify([300]) }),
      row({ fromNodeNum: PEER, toNodeNum: LOCAL, route: JSON.stringify([300]) }),
    ];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const nodeA = union.nodes.filter((x) => x.id === n(300));
    expect(nodeA.length).toBe(1);
    expect(nodeA[0].count).toBe(2);
    expect(union.totalRoutes).toBe(2);
  });

  it('11. the return leg is oriented local→peer, so its hop depths count from local', () => {
    // routeBack [400, 500] means raw return sequence peer,400,500,local; after
    // orientation (reverse, since it starts at peer not local) it becomes
    // local,500,400,peer — so 500 is at depth 1 and 400 is at depth 2.
    const rows = [row({ routeBack: JSON.stringify([400, 500]), snrBack: '[1,1,1]' })];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const node500 = union.nodes.find((x) => x.id === n(500));
    const node400 = union.nodes.find((x) => x.id === n(400));
    expect(node500?.depthSamples).toEqual([1]);
    expect(node400?.depthSamples).toEqual([2]);
  });

  it('12. localNodeNum === peerNodeNum returns an empty union', () => {
    const union = buildTracerouteUnion([row({ fromNodeNum: LOCAL, toNodeNum: LOCAL })], LOCAL, LOCAL);
    expect(union.isEmpty).toBe(true);
    expect(union.totalRoutes).toBe(0);
    expect(union.nodes).toEqual([]);
    expect(union.edges).toEqual([]);
  });

  it('13. a row whose endpoints are neither local nor peer increments mismatchedRoutes', () => {
    const rows = [row({ fromNodeNum: 900, toNodeNum: 901, route: JSON.stringify([]) })];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    expect(union.mismatchedRoutes).toBe(1);
    expect(union.totalRoutes).toBe(0);
  });
});

describe('tracerouteAggregate — row exclusion', () => {
  it('14. route: null, routeBack: null → excludedRoutes: 1, totalRoutes: 0', () => {
    const union = buildTracerouteUnion([row({ route: null, routeBack: null })], LOCAL, PEER);
    expect(union.excludedRoutes).toBe(1);
    expect(union.totalRoutes).toBe(0);
  });

  it("15. route: 'null' and routeBack: '' → excluded (the string forms)", () => {
    const union = buildTracerouteUnion([row({ route: 'null', routeBack: '' })], LOCAL, PEER);
    expect(union.excludedRoutes).toBe(1);
    expect(union.totalRoutes).toBe(0);
  });

  it('16. forward-only row is included', () => {
    const union = buildTracerouteUnion([row({ route: JSON.stringify([300]) })], LOCAL, PEER);
    expect(union.totalRoutes).toBe(1);
    expect(union.excludedRoutes).toBe(0);
  });

  it('17. return-only row (empty routeBack, non-empty snrBack) is included and yields a direct local–peer edge', () => {
    const union = buildTracerouteUnion([row({ routeBack: '[]', snrBack: '[-10]' })], LOCAL, PEER);
    expect(union.totalRoutes).toBe(1);
    const directEdge = union.edges.find((e) => e.aId === n(LOCAL) && e.bId === n(PEER));
    expect(directEdge).toBeDefined();
    expect(directEdge?.count).toBe(1);
  });

  it('18. a failed row mixed into a good history does not change any share', () => {
    const goodOnly = buildTracerouteUnion(
      [row({ route: JSON.stringify([300]) }), row({ route: JSON.stringify([300]) })],
      LOCAL,
      PEER,
    );
    const withFailed = buildTracerouteUnion(
      [
        row({ route: JSON.stringify([300]) }),
        row({ route: null, routeBack: null }),
        row({ route: JSON.stringify([300]) }),
      ],
      LOCAL,
      PEER,
    );
    expect(withFailed.totalRoutes).toBe(goodOnly.totalRoutes);
    expect(withFailed.excludedRoutes).toBe(1);
    const nodeA = withFailed.nodes.find((x) => x.id === n(300));
    const nodeAGood = goodOnly.nodes.find((x) => x.id === n(300));
    expect(nodeA?.share).toBe(nodeAGood?.share);
  });

  it('19. malformed JSON (route: "{") parses to [] via parseHopArray; the row still counts as a direct forward leg', () => {
    const union = buildTracerouteUnion([row({ route: '{' })], LOCAL, PEER);
    expect(union.totalRoutes).toBe(1);
    const directEdge = union.edges.find((e) => e.aId === n(LOCAL) && e.bId === n(PEER));
    expect(directEdge).toBeDefined();
  });
});

describe('tracerouteAggregate — unknown hops', () => {
  it('20. two routes, each with one unknown at depth 1, merge to a single u:1 node with count 2', () => {
    const rows = [
      row({ route: JSON.stringify([BROADCAST_ADDR]) }),
      row({ route: JSON.stringify([BROADCAST_ADDR]) }),
    ];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const unknownNodes = union.nodes.filter((x) => x.isUnknown);
    expect(unknownNodes.length).toBe(1);
    expect(unknownNodes[0].id).toBe(u(1));
    expect(unknownNodes[0].count).toBe(2);
  });

  it('21. unknowns at different depths stay distinct (u:1 and u:2)', () => {
    const rows = [
      row({ route: JSON.stringify([BROADCAST_ADDR]) }), // depth 1
      row({ route: JSON.stringify([300, BROADCAST_ADDR]) }), // depth 2
    ];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const unknownIds = union.nodes.filter((x) => x.isUnknown).map((x) => x.id);
    expect(unknownIds).toEqual(expect.arrayContaining([u(1), u(2)]));
    expect(unknownIds.length).toBe(2);
  });

  it('22. an unknown never merges with a real node at the same depth', () => {
    const rows = [
      row({ route: JSON.stringify([BROADCAST_ADDR]) }), // u:1
      row({ route: JSON.stringify([300]) }), // n:300, also at depth 1
    ];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const unknownNode = union.nodes.find((x) => x.id === u(1));
    const realNode = union.nodes.find((x) => x.id === n(300));
    expect(unknownNode).toBeDefined();
    expect(realNode).toBeDefined();
    expect(unknownNode?.count).toBe(1);
    expect(realNode?.count).toBe(1);
  });

  it('23. unknownDepth is set exactly when isUnknown is true', () => {
    const rows = [row({ route: JSON.stringify([300, BROADCAST_ADDR]) })];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    for (const nd of union.nodes) {
      if (nd.isUnknown) expect(nd.unknownDepth).not.toBeNull();
      else expect(nd.unknownDepth).toBeNull();
    }
  });

  it('24. an unknown in the forward leg and one at the same depth in the return leg of the same row merge and still count once', () => {
    // forward: L, unknown(depth1), P — return: P, unknown(depth1 after orientation), L
    const rows = [
      row({
        route: JSON.stringify([BROADCAST_ADDR]),
        routeBack: JSON.stringify([BROADCAST_ADDR]),
        snrBack: '[1,1]',
      }),
    ];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const unknownNodes = union.nodes.filter((x) => x.id === u(1));
    expect(unknownNodes.length).toBe(1);
    expect(unknownNodes[0].count).toBe(1);
  });

  it('25. nodeNum === BROADCAST_ADDR on every unknown node', () => {
    const rows = [row({ route: JSON.stringify([BROADCAST_ADDR]) })];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    for (const nd of union.nodes.filter((x) => x.isUnknown)) {
      expect(nd.nodeNum).toBe(BROADCAST_ADDR);
    }
  });
});

describe('tracerouteAggregate — hop filtering (delegated, asserted once)', () => {
  it('26. a reserved intermediate (nodeNum: 2) is dropped from the union', () => {
    const rows = [row({ route: JSON.stringify([2, 300]) })];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const reservedNode = union.nodes.find((x) => x.nodeNum === 2);
    expect(reservedNode).toBeUndefined();
    const nodeA = union.nodes.find((x) => x.id === n(300));
    expect(nodeA).toBeDefined();
  });

  it('27. reserved values at the endpoints are kept (endpoints are never filtered)', () => {
    // Use a reserved local endpoint value (2) and confirm it survives as a
    // node — filterHops never filters index 0 / last index.
    const union = buildTracerouteUnion([row({ fromNodeNum: 2, toNodeNum: PEER, route: '[]' })], 2, PEER);
    const localNode = union.nodes.find((x) => x.id === n(2));
    expect(localNode).toBeDefined();
    expect(localNode?.isEndpoint).toBe(true);
  });
});

describe('tracerouteAggregate — degenerate and structural', () => {
  it('28. empty rows → isEmpty: true, totalRoutes: 0, no nodes, no edges', () => {
    const union = buildTracerouteUnion([], LOCAL, PEER);
    expect(union.isEmpty).toBe(true);
    expect(union.totalRoutes).toBe(0);
    expect(union.nodes).toEqual([]);
    expect(union.edges).toEqual([]);
  });

  it('29. single route → every share is 1, node count is path length', () => {
    const rows = [row({ route: JSON.stringify([300, 400]) })];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    expect(union.nodes.length).toBe(4); // local, 300, 400, peer
    for (const nd of union.nodes) expect(nd.share).toBe(1);
  });

  it('30. two disjoint routes (no shared intermediates) → union contains both paths, each intermediate at share 0.5, endpoints at 1', () => {
    const rows = [row({ route: JSON.stringify([300]) }), row({ route: JSON.stringify([400]) })];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const nodeA = union.nodes.find((x) => x.id === n(300));
    const nodeB = union.nodes.find((x) => x.id === n(400));
    const local = union.nodes.find((x) => x.id === n(LOCAL));
    const peer = union.nodes.find((x) => x.id === n(PEER));
    expect(nodeA?.share).toBe(0.5);
    expect(nodeB?.share).toBe(0.5);
    expect(local?.share).toBe(1);
    expect(peer?.share).toBe(1);
  });

  it('31. two routes sharing a prefix → the shared prefix nodes carry the higher share, the diverging tails 0.5 each', () => {
    const rows = [
      row({ route: JSON.stringify([300, 400]) }),
      row({ route: JSON.stringify([300, 500]) }),
    ];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const nodeShared = union.nodes.find((x) => x.id === n(300));
    const nodeTail1 = union.nodes.find((x) => x.id === n(400));
    const nodeTail2 = union.nodes.find((x) => x.id === n(500));
    expect(nodeShared?.share).toBe(1);
    expect(nodeTail1?.share).toBe(0.5);
    expect(nodeTail2?.share).toBe(0.5);
  });

  it('32. a node visited at different depths in two routes yields depthSamples [d1, d2] sorted ascending', () => {
    const rows = [
      row({ route: JSON.stringify([300]) }), // depth 1
      row({ route: JSON.stringify([400, 300]) }), // depth 2
    ];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const nodeA = union.nodes.find((x) => x.id === n(300));
    expect(nodeA?.depthSamples).toEqual([1, 2]);
  });

  it('33. depthSamples.length may exceed count (documented granularity)', () => {
    // A appears in both legs of the same row: count 1, but two depth samples.
    const rows = [row({ route: JSON.stringify([300]), routeBack: JSON.stringify([300]), snrBack: '[1]' })];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const nodeA = union.nodes.find((x) => x.id === n(300));
    expect(nodeA?.count).toBe(1);
    expect(nodeA?.depthSamples.length).toBeGreaterThan(nodeA!.count);
  });
});

describe('tracerouteAggregate — invariants and determinism', () => {
  const fixtureRows: AggregateTracerouteRow[] = [
    row({ route: JSON.stringify([300, 400]) }),
    row({ fromNodeNum: PEER, toNodeNum: LOCAL, route: JSON.stringify([400, 500]) }),
    row({ route: JSON.stringify([BROADCAST_ADDR, 300]) }),
    row({ route: null, routeBack: null }), // excluded
    row({ fromNodeNum: 900, toNodeNum: 901, route: '[]' }), // mismatched
    row({ routeBack: JSON.stringify([500, 300]), snrBack: '[1,1,1]' }),
  ];

  it('34. U1: every share is in (0, 1]', () => {
    const union = buildTracerouteUnion(fixtureRows, LOCAL, PEER);
    for (const nd of union.nodes) {
      expect(nd.share).toBeGreaterThan(0);
      expect(nd.share).toBeLessThanOrEqual(1);
    }
    for (const e of union.edges) {
      expect(e.share).toBeGreaterThan(0);
      expect(e.share).toBeLessThanOrEqual(1);
    }
  });

  it('35. U3: node ids unique; edge ids unique', () => {
    const union = buildTracerouteUnion(fixtureRows, LOCAL, PEER);
    expect(new Set(union.nodes.map((x) => x.id)).size).toBe(union.nodes.length);
    expect(new Set(union.edges.map((x) => x.id)).size).toBe(union.edges.length);
  });

  it('36. U4: every edges aId/bId resolves to a node in nodes', () => {
    const union = buildTracerouteUnion(fixtureRows, LOCAL, PEER);
    const ids = new Set(union.nodes.map((x) => x.id));
    for (const e of union.edges) {
      expect(ids.has(e.aId)).toBe(true);
      expect(ids.has(e.bId)).toBe(true);
    }
  });

  it('37. U5: aId < bId for every edge', () => {
    const union = buildTracerouteUnion(fixtureRows, LOCAL, PEER);
    for (const e of union.edges) {
      expect(e.aId < e.bId).toBe(true);
    }
  });

  it('38. U6: permuting rows yields a deep-equal union graph', () => {
    const permuted = [...fixtureRows].reverse();
    const unionA = buildTracerouteUnion(fixtureRows, LOCAL, PEER);
    const unionB = buildTracerouteUnion(permuted, LOCAL, PEER);
    expect(unionB).toEqual(unionA);
  });

  it('39. two calls with the same input yield deep-equal output', () => {
    const unionA = buildTracerouteUnion(fixtureRows, LOCAL, PEER);
    const unionB = buildTracerouteUnion(fixtureRows, LOCAL, PEER);
    expect(unionB).toEqual(unionA);
  });

  it('40. node and edge arrays are sorted by id ascending', () => {
    const union = buildTracerouteUnion(fixtureRows, LOCAL, PEER);
    const nodeIds = union.nodes.map((x) => x.id);
    const sortedNodeIds = [...nodeIds].sort();
    expect(nodeIds).toEqual(sortedNodeIds);
    const edgeIds = union.edges.map((x) => x.id);
    const sortedEdgeIds = [...edgeIds].sort();
    expect(edgeIds).toEqual(sortedEdgeIds);
  });
});

describe('tracerouteAggregate — statOpacity', () => {
  it('41. statOpacity(1) === 1', () => {
    expect(statOpacity(1)).toBe(1);
  });

  it('42. statOpacity(0) and statOpacity(1/50) are both >= MIN_STAT_OPACITY', () => {
    expect(statOpacity(0)).toBeGreaterThanOrEqual(MIN_STAT_OPACITY);
    expect(statOpacity(1 / 50)).toBeGreaterThanOrEqual(MIN_STAT_OPACITY);
    expect(statOpacity(0)).toBe(MIN_STAT_OPACITY);
  });

  it('43. statOpacity is monotone non-decreasing across a swept range', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const share = i / 20;
      const opacity = statOpacity(share);
      expect(opacity).toBeGreaterThanOrEqual(prev);
      prev = opacity;
    }
  });

  it('44. out-of-range input (-1, 2) clamps to MIN_STAT_OPACITY / 1', () => {
    expect(statOpacity(-1)).toBe(MIN_STAT_OPACITY);
    expect(statOpacity(2)).toBe(1);
  });
});
