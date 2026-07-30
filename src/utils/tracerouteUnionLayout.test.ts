/**
 * Tests for `tracerouteUnionLayout.ts` (Statistical Route epic, Phase 1 WP3).
 * §4.3 of `docs/internal/dev-notes/SR_PHASE1_SPEC.md`, cases 1-30.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildUnionStripGraph,
  layoutTracerouteUnion,
  buildStatisticalStrip,
} from './tracerouteUnionLayout';
import { buildTracerouteUnion, statOpacity, type AggregateTracerouteRow } from './tracerouteAggregate';
import {
  DEFAULT_LAYOUT_OPTIONS,
  minBand,
  minRowHeight,
  labelOffset,
  edgeClearance,
  GEOM_EPS,
  type StripPoint,
} from './tracerouteStrip';
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

const n = (nodeNum: number): string => `n:${nodeNum}`;

/** Shorthand: rows -> a UnionStripGraph, skipping the pixel layout. */
function buildGraph(rows: AggregateTracerouteRow[]) {
  return buildUnionStripGraph(buildTracerouteUnion(rows, LOCAL, PEER));
}

/** Closest distance from point `p` to the segment `a`->`b`. Independent
 *  reimplementation for test verification — not a copy of anything the
 *  module under test imports or exports. */
function pointToSegmentDistance(p: StripPoint, a: StripPoint, b: StripPoint): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  const cx = a.x + t * abx;
  const cy = a.y + t * aby;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Minimum distance from any obstacle centre to any point on any segment of `path`. */
function minDistanceToObstacles(path: StripPoint[], obstacles: StripPoint[]): number {
  let min = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    for (const o of obstacles) {
      min = Math.min(min, pointToSegmentDistance(o, path[i], path[i + 1]));
    }
  }
  return min;
}

describe('tracerouteUnionLayout — columns', () => {
  it('1. local at column 0, peer at column columns - 1', () => {
    const graph = buildGraph([row({ route: JSON.stringify([300]) })]);
    const local = graph.nodes.find((nd) => nd.id === n(LOCAL));
    const peer = graph.nodes.find((nd) => nd.id === n(PEER));
    expect(local?.col).toBe(0);
    expect(peer?.col).toBe(graph.columns - 1);
  });

  it('2. columns 0 and columns - 1 hold exactly one node each', () => {
    const graph = buildGraph([row({ route: JSON.stringify([300]) }), row({ route: JSON.stringify([400]) })]);
    expect(graph.nodes.filter((nd) => nd.col === 0).length).toBe(1);
    expect(graph.nodes.filter((nd) => nd.col === graph.columns - 1).length).toBe(1);
  });

  it('3. a node at depth 1 in one route and depth 3 in another gets the lower median (column derived from key 1)', () => {
    const rows = [
      row({ route: JSON.stringify([300]) }), // 300 at depth 1
      row({ route: JSON.stringify([400, 500, 300]) }), // 300 at depth 3
    ];
    const graph = buildGraph(rows);
    const node300 = graph.nodes.find((nd) => nd.id === n(300));
    // depthSamples [1,3] -> lower median index 0 -> key 1 -> column 1.
    expect(node300?.col).toBe(1);
  });

  it('4. even-count depthSamples take the LOWER median', () => {
    const rows = [
      row({ route: JSON.stringify([300]) }), // 300 depth 1
      row({ route: JSON.stringify([400, 300]) }), // 400 depth 1, 300 depth 2
      row({ route: JSON.stringify([800, 900]) }), // 800 depth 1, 900 depth 2 — makes key 2 a distinct column
    ];
    const graph = buildGraph(rows);
    // 300's depthSamples [1,2] -> lower median index 0 -> key 1. If the
    // (wrong) upper median were used, 300 would land in the key-2 column.
    const node300 = graph.nodes.find((nd) => nd.id === n(300));
    const node400 = graph.nodes.find((nd) => nd.id === n(400));
    expect(node300?.col).toBe(node400?.col);
    expect(node300?.col).toBe(1);
  });

  it('5. direct-only history -> columns === 2, one row', () => {
    const graph = buildGraph([row({ route: '[]' })]);
    expect(graph.columns).toBe(2);
    expect(graph.nodes.every((nd) => nd.row === 0)).toBe(true);
  });

  it('6. two routes of different length -> dense column indices, no gaps', () => {
    const rows = [row({ route: JSON.stringify([300]) }), row({ route: JSON.stringify([400, 500, 600]) })];
    const graph = buildGraph(rows);
    const usedCols = new Set(graph.nodes.map((nd) => nd.col));
    expect(usedCols.size).toBe(graph.columns);
    for (let c = 0; c < graph.columns; c++) expect(usedCols.has(c)).toBe(true);
  });
});

describe('tracerouteUnionLayout — rows', () => {
  it('7. single repeated path -> every node on one row', () => {
    const rows = [row({ route: JSON.stringify([300, 400]) }), row({ route: JSON.stringify([300, 400]) })];
    const graph = buildGraph(rows);
    expect(graph.nodes.every((nd) => nd.row === 0)).toBe(true);
  });

  it('8. two parallel paths -> two rows; the more frequent node sits on the dominant row', () => {
    const rows = [
      row({ route: JSON.stringify([300]) }),
      row({ route: JSON.stringify([300]) }),
      row({ route: JSON.stringify([300]) }),
      row({ route: JSON.stringify([400]) }),
    ];
    const graph = buildGraph(rows);
    const node300 = graph.nodes.find((nd) => nd.id === n(300))!; // share 0.75
    const node400 = graph.nodes.find((nd) => nd.id === n(400))!; // share 0.25
    const distinctRows = new Set(graph.nodes.map((nd) => nd.row));
    expect(distinctRows.size).toBe(2);
    expect(node300.row).not.toBe(node400.row);
    // The dominant (higher-share) node shares the local/peer row — the
    // "straight line" property (D6).
    const local = graph.nodes.find((nd) => nd.id === n(LOCAL))!;
    expect(node300.row).toBe(local.row);
  });

  it('9. the dominant node of every column shares one row index (D6 property)', () => {
    // Two columns, each a 3-way fan with strictly descending shares —
    // (A1,B1) most frequent, then (A2,B2), then (A3,B3).
    const rows = [
      ...Array(3).fill(row({ route: JSON.stringify([301, 302]) })),
      ...Array(2).fill(row({ route: JSON.stringify([303, 304]) })),
      ...Array(1).fill(row({ route: JSON.stringify([305, 306]) })),
    ];
    const graph = buildGraph(rows);
    const dominantCol1 = graph.nodes.find((nd) => nd.id === n(301))!; // highest share in its column
    const dominantCol2 = graph.nodes.find((nd) => nd.id === n(302))!;
    expect(dominantCol1.col).not.toBe(dominantCol2.col);
    expect(dominantCol1.row).toBe(dominantCol2.row);
  });

  it('10. offsets alternate 0, +1, -1, +2, -2 for a five-node fan in one column', () => {
    // Five distinct-depth-1 intermediates with strictly descending counts,
    // so (share desc, id asc) order is unambiguous.
    const rows: AggregateTracerouteRow[] = [];
    const counts: [number, number][] = [
      [701, 5],
      [702, 4],
      [703, 3],
      [704, 2],
      [705, 1],
    ];
    for (const [nodeNum, count] of counts) {
      for (let i = 0; i < count; i++) rows.push(row({ route: JSON.stringify([nodeNum]) }));
    }
    const graph = buildGraph(rows);
    const rowOf = (num: number): number => graph.nodes.find((nd) => nd.id === n(num))!.row;
    const base = rowOf(701); // offset 0 — differences below match the offset table exactly.
    expect(rowOf(702) - base).toBe(1);
    expect(rowOf(703) - base).toBe(-1);
    expect(rowOf(704) - base).toBe(2);
    expect(rowOf(705) - base).toBe(-2);
  });

  it('11. no two nodes in one column share a row', () => {
    const rows = [
      ...Array(3).fill(row({ route: JSON.stringify([301, 302]) })),
      ...Array(2).fill(row({ route: JSON.stringify([303, 304]) })),
      ...Array(1).fill(row({ route: JSON.stringify([305, 306]) })),
      row({ route: JSON.stringify([301, 700, 302]) }), // adds an extra depth-2 node sharing 302's column
    ];
    const graph = buildGraph(rows);
    const byCol = new Map<number, number[]>();
    for (const nd of graph.nodes) {
      const arr = byCol.get(nd.col) ?? [];
      arr.push(nd.row);
      byCol.set(nd.col, arr);
    }
    for (const [, rowsInCol] of byCol) {
      expect(new Set(rowsInCol).size).toBe(rowsInCol.length);
    }
  });
});

describe('tracerouteUnionLayout — edges and geometry', () => {
  it('12. same-column adjacency renders a 2-point vertical path, both endpoints pulled in, neither point equal to a glyph centre (D7)', () => {
    // route1 = L,300,400,P ; route2 = L,400,300,P — the spec's D7 example.
    // Both 300 and 400 get depthSamples [1,2] -> lower median 1 -> same column.
    const rows = [row({ route: JSON.stringify([300, 400]) }), row({ route: JSON.stringify([400, 300]) })];
    const { graph, layout } = buildStatisticalStrip(rows, LOCAL, PEER);
    const nodeA = graph.nodes.find((nd) => nd.id === n(300))!;
    const nodeB = graph.nodes.find((nd) => nd.id === n(400))!;
    expect(nodeA.col).toBe(nodeB.col);
    expect(nodeA.row).not.toBe(nodeB.row);

    const edge = graph.edges.find(
      (e) => (e.aId === nodeA.id && e.bId === nodeB.id) || (e.aId === nodeB.id && e.bId === nodeA.id),
    )!;
    expect(edge).toBeDefined();
    const path = layout.edgePaths.get(edge.id)!;
    expect(path.length).toBe(2);

    const centerA = layout.centers.get(nodeA.id)!;
    const centerB = layout.centers.get(nodeB.id)!;
    for (const p of path) {
      expect(p).not.toEqual(centerA);
      expect(p).not.toEqual(centerB);
    }
  });

  it('13. same-row, different-column adjacency renders a 2-point path', () => {
    // Single route: both 300 (col 1) and 400 (col 2) are the sole occupant
    // of their column, so both share offset 0 -> the same row.
    const rows = [row({ route: JSON.stringify([300, 400]) })];
    const { graph, layout } = buildStatisticalStrip(rows, LOCAL, PEER);
    const node300 = graph.nodes.find((nd) => nd.id === n(300))!;
    const node400 = graph.nodes.find((nd) => nd.id === n(400))!;
    expect(node300.col).not.toBe(node400.col);
    expect(node300.row).toBe(node400.row);
    const edge = graph.edges.find(
      (e) => (e.aId === node300.id && e.bId === node400.id) || (e.aId === node400.id && e.bId === node300.id),
    )!;
    const path = layout.edgePaths.get(edge.id)!;
    expect(path.length).toBe(2);
  });

  it('14. different-row, different-column adjacency renders a 3-point dog-leg with the elbow at the lower row', () => {
    const rows = [
      ...Array(2).fill(row({ route: JSON.stringify([300, 400]) })), // 400: share 2/3
      row({ route: JSON.stringify([300, 500]) }), // 500: share 1/3, sits on the +1 row
    ];
    const { graph, layout } = buildStatisticalStrip(rows, LOCAL, PEER);
    const node300 = graph.nodes.find((nd) => nd.id === n(300))!; // col 1, sole occupant -> row shared w/ local
    const node500 = graph.nodes.find((nd) => nd.id === n(500))!; // col 2, lower share -> different row
    expect(node300.col).not.toBe(node500.col);
    expect(node300.row).not.toBe(node500.row);

    const edge = graph.edges.find(
      (e) => (e.aId === node300.id && e.bId === node500.id) || (e.aId === node500.id && e.bId === node300.id),
    )!;
    const path = layout.edgePaths.get(edge.id)!;
    expect(path.length).toBe(3);
    const c0 = layout.centers.get(node300.id)!;
    const c1 = layout.centers.get(node500.id)!;
    expect(path[1].y).toBeCloseTo(Math.max(c0.y, c1.y), 6);
  });

  it('15. an edge spanning non-adjacent columns bends around the intervening glyph (clearance)', () => {
    // A long single-leg path establishes 3 intervening columns, all on row
    // 0; a second, return-only row adds a direct local<->peer edge, which
    // must detour around 300/400/500's glyphs sitting exactly on that line.
    const rows = [
      row({ route: JSON.stringify([300, 400, 500]) }),
      row({ routeBack: '[]', snrBack: '[-10]' }),
    ];
    const { graph, layout } = buildStatisticalStrip(rows, LOCAL, PEER);
    const local = graph.nodes.find((nd) => nd.id === n(LOCAL))!;
    const peer = graph.nodes.find((nd) => nd.id === n(PEER))!;
    expect(local.row).toBe(peer.row); // all-single-occupant columns -> one flat row

    const directEdge = graph.edges.find(
      (e) => (e.aId === local.id && e.bId === peer.id) || (e.aId === peer.id && e.bId === local.id),
    )!;
    expect(directEdge).toBeDefined();
    const path = layout.edgePaths.get(directEdge.id)!;

    const o = { ...DEFAULT_LAYOUT_OPTIONS };
    const clearance = edgeClearance(o);
    const obstacles = graph.nodes
      .filter((nd) => nd.id !== local.id && nd.id !== peer.id)
      .map((nd) => layout.centers.get(nd.id)!);
    const min = minDistanceToObstacles(path, obstacles);
    expect(min).toBeGreaterThanOrEqual(clearance - GEOM_EPS);
  });

  it('16. every graph.nodes id has a layout.centers entry (L1)', () => {
    const rows = [row({ route: JSON.stringify([300, 400]) })];
    const { graph, layout } = buildStatisticalStrip(rows, LOCAL, PEER);
    for (const nd of graph.nodes) expect(layout.centers.has(nd.id)).toBe(true);
  });

  it('17. width === columns * colWidth; height matches the floored band formula', () => {
    const rows = [row({ route: JSON.stringify([300, 400]) })];
    const { graph, layout } = buildStatisticalStrip(rows, LOCAL, PEER);
    const o = { ...DEFAULT_LAYOUT_OPTIONS };
    expect(layout.width).toBe(graph.columns * o.colWidth);
    const topBand = Math.max(o.topBand, minBand(o));
    const bottomBand = Math.max(o.bottomBand, minBand(o));
    const rowHeight = Math.max(o.rowHeight, minRowHeight(o));
    const maxRow = Math.max(...graph.nodes.map((nd) => nd.row));
    expect(layout.height).toBe(topBand + (maxRow + 1) * rowHeight + bottomBand);
  });

  it('18. custom opts below the floors are raised to minBand / minRowHeight', () => {
    const rows = [row({ route: JSON.stringify([300, 400]) })];
    const { graph } = buildStatisticalStrip(rows, LOCAL, PEER);
    const tinyOpts = { topBand: 1, bottomBand: 1, rowHeight: 1 };
    const layout = layoutTracerouteUnion(graph, tinyOpts);
    const o = { ...DEFAULT_LAYOUT_OPTIONS, ...tinyOpts };
    const topBand = Math.max(o.topBand, minBand(o));
    const bottomBand = Math.max(o.bottomBand, minBand(o));
    const rowHeight = Math.max(o.rowHeight, minRowHeight(o));
    const maxRow = Math.max(...graph.nodes.map((nd) => nd.row));
    expect(layout.height).toBe(topBand + (maxRow + 1) * rowHeight + bottomBand);
    // Floors actually took effect: the raw (too-small) opts alone would give a smaller height.
    expect(layout.height).toBeGreaterThan(tinyOpts.topBand + (maxRow + 1) * tinyOpts.rowHeight + tinyOpts.bottomBand);
  });

  it('19. every edgePaths entry has at least 2 points', () => {
    const rows = [
      row({ route: JSON.stringify([300, 400, 500]) }),
      row({ routeBack: '[]', snrBack: '[-10]' }),
    ];
    const { graph, layout } = buildStatisticalStrip(rows, LOCAL, PEER);
    for (const e of graph.edges) {
      const path = layout.edgePaths.get(e.id);
      expect(path).toBeDefined();
      expect(path!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('20. every edge has a labelAnchors entry, and its y clears every node centre by at least labelOffset(o) on a same-row edge', () => {
    const rows = [row({ route: JSON.stringify([300, 400]) })];
    const { graph, layout } = buildStatisticalStrip(rows, LOCAL, PEER);
    const o = { ...DEFAULT_LAYOUT_OPTIONS };
    const offset = labelOffset(o);
    const nodeById = new Map(graph.nodes.map((nd) => [nd.id, nd]));
    for (const e of graph.edges) {
      const anchor = layout.labelAnchors.get(e.id);
      expect(anchor).toBeDefined();
      const fromNode = nodeById.get(e.fromId)!;
      const toNode = nodeById.get(e.toId)!;
      if (fromNode.row === toNode.row) {
        for (const nd of graph.nodes) {
          const c = layout.centers.get(nd.id)!;
          expect(Math.abs(anchor!.y - c.y)).toBeGreaterThanOrEqual(offset - GEOM_EPS);
        }
      }
    }
  });
});

describe('tracerouteUnionLayout — graph shape', () => {
  it('21. every node has lane: "spine", legs: [], shared: false', () => {
    const rows = [row({ route: JSON.stringify([300, 400]) })];
    const graph = buildGraph(rows);
    for (const nd of graph.nodes) {
      expect(nd.lane).toBe('spine');
      expect(nd.legs).toEqual([]);
      expect(nd.shared).toBe(false);
    }
  });

  it('22. every edge has leg: "forward", snr: null, snrUnknown: false', () => {
    const rows = [row({ route: JSON.stringify([300, 400]) })];
    const graph = buildGraph(rows);
    for (const e of graph.edges) {
      expect(e.leg).toBe('forward');
      expect(e.snr).toBeNull();
      expect(e.snrUnknown).toBe(false);
    }
  });

  it('23. mode === "statistical"; hasForward/hasReturn are false', () => {
    const rows = [row({ route: JSON.stringify([300, 400]) })];
    const graph = buildGraph(rows);
    expect(graph.mode).toBe('statistical');
    expect(graph.hasForward).toBe(false);
    expect(graph.hasReturn).toBe(false);
  });

  it('24. opacity === statOpacity(share) on every node and edge', () => {
    const rows = [
      row({ route: JSON.stringify([300, 400]) }),
      row({ route: JSON.stringify([300]) }),
    ];
    const graph = buildGraph(rows);
    for (const nd of graph.nodes) expect(nd.opacity).toBe(statOpacity(nd.share));
    for (const e of graph.edges) expect(e.opacity).toBe(statOpacity(e.share));
  });

  it('25. node ids are carried over verbatim from the aggregate', () => {
    const rows = [row({ route: JSON.stringify([300, BROADCAST_ADDR]) })];
    const union = buildTracerouteUnion(rows, LOCAL, PEER);
    const graph = buildUnionStripGraph(union);
    const unionIds = new Set(union.nodes.map((nd) => nd.id));
    const graphIds = new Set(graph.nodes.map((nd) => nd.id));
    expect(graphIds).toEqual(unionIds);
    for (const nd of union.nodes) {
      const gnd = graph.nodes.find((x) => x.id === nd.id)!;
      expect(gnd.nodeNum).toBe(nd.nodeNum);
      expect(gnd.isUnknown).toBe(nd.isUnknown);
    }
  });

  it('26. empty union -> empty graph, columns: 0, width: 0, and a layout that does not throw', () => {
    const graph = buildGraph([]);
    expect(graph.isEmpty).toBe(true);
    expect(graph.columns).toBe(0);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(() => layoutTracerouteUnion(graph)).not.toThrow();
    const layout = layoutTracerouteUnion(graph);
    expect(layout.width).toBe(0);
  });
});

describe('tracerouteUnionLayout — determinism', () => {
  const fixtureRows: AggregateTracerouteRow[] = [
    row({ route: JSON.stringify([300, 400]) }),
    row({ fromNodeNum: PEER, toNodeNum: LOCAL, route: JSON.stringify([400, 500]) }),
    row({ route: JSON.stringify([BROADCAST_ADDR, 300]) }),
    row({ route: null, routeBack: null }), // excluded
    row({ routeBack: JSON.stringify([500, 300]), snrBack: '[1,1,1]' }),
  ];

  it('27. two runs of buildStatisticalStrip on the same rows deep-equal, including every Map', () => {
    const a = buildStatisticalStrip(fixtureRows, LOCAL, PEER);
    const b = buildStatisticalStrip(fixtureRows, LOCAL, PEER);
    expect(a.union).toEqual(b.union);
    expect(a.graph).toEqual(b.graph);
    expect(a.layout.width).toBe(b.layout.width);
    expect(a.layout.height).toBe(b.layout.height);
    expect([...a.layout.centers.entries()]).toEqual([...b.layout.centers.entries()]);
    expect([...a.layout.edgePaths.entries()]).toEqual([...b.layout.edgePaths.entries()]);
    expect([...a.layout.labelAnchors.entries()]).toEqual([...b.layout.labelAnchors.entries()]);
  });

  it('28. permuting the input rows yields a deep-equal layout', () => {
    const permuted = [...fixtureRows].reverse();
    const a = buildStatisticalStrip(fixtureRows, LOCAL, PEER);
    const b = buildStatisticalStrip(permuted, LOCAL, PEER);
    expect(a.graph).toEqual(b.graph);
    expect([...a.layout.centers.entries()]).toEqual([...b.layout.centers.entries()]);
    expect([...a.layout.edgePaths.entries()]).toEqual([...b.layout.edgePaths.entries()]);
    expect([...a.layout.labelAnchors.entries()]).toEqual([...b.layout.labelAnchors.entries()]);
  });

  it('29. no Date/Math.random reachable — stubbing Math.random to throw does not break a repeat run', () => {
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be called');
    });
    try {
      const a = buildStatisticalStrip(fixtureRows, LOCAL, PEER);
      const b = buildStatisticalStrip(fixtureRows, LOCAL, PEER);
      expect(a.graph).toEqual(b.graph);
      expect([...a.layout.centers.entries()]).toEqual([...b.layout.centers.entries()]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('tracerouteUnionLayout — integration with fixtures', () => {
  it('30. a realistic 15-row fixture (mixed orientations, one failed row, two unknowns, one loop) produces a valid graph', () => {
    const rows: AggregateTracerouteRow[] = [
      row({ route: JSON.stringify([300]) }),
      row({ route: JSON.stringify([300, 400]) }),
      row({ fromNodeNum: PEER, toNodeNum: LOCAL, route: JSON.stringify([400, 300]) }), // reverse orientation
      row({ route: JSON.stringify([500]) }),
      row({ route: JSON.stringify([500, 600]) }),
      row({ routeBack: JSON.stringify([700]), snrBack: '[1,1]' }), // return-only leg
      row({ route: JSON.stringify([BROADCAST_ADDR]) }), // unknown at depth 1
      row({ route: JSON.stringify([300, BROADCAST_ADDR]) }), // unknown at depth 2
      row({ route: JSON.stringify([300, 300]) }), // loop: 300 twice in one leg
      row({ route: null, routeBack: null }), // failed row -> excluded
      row({ route: JSON.stringify([400]) }),
      row({ route: JSON.stringify([600]) }),
      row({ fromNodeNum: PEER, toNodeNum: LOCAL, route: JSON.stringify([600]) }), // reverse orientation
      row({ route: JSON.stringify([300, 400, 500]) }),
      row({ route: '[]' }), // direct only
    ];
    expect(rows.length).toBe(15);

    const { union, graph, layout } = buildStatisticalStrip(rows, LOCAL, PEER);
    expect(union.totalRoutes).toBe(14); // one excluded
    expect(union.nodes.filter((nd) => nd.isUnknown).length).toBe(2); // u:1 and u:2

    // L1: every node has a centre.
    for (const nd of graph.nodes) expect(layout.centers.has(nd.id)).toBe(true);
    // L2: every edge path has >= 2 points.
    for (const e of graph.edges) expect(layout.edgePaths.get(e.id)!.length).toBeGreaterThanOrEqual(2);
    // L3: every edge has a label anchor.
    for (const e of graph.edges) expect(layout.labelAnchors.has(e.id)).toBe(true);
    // L4: width/height match the documented formula.
    const o = { ...DEFAULT_LAYOUT_OPTIONS };
    expect(layout.width).toBe(graph.columns * o.colWidth);

    // Every clearance assertion: no path (of any edge) passes closer than
    // edgeClearance(o) - GEOM_EPS to any node it doesn't terminate at.
    const clearance = edgeClearance(o);
    for (const e of graph.edges) {
      const path = layout.edgePaths.get(e.id)!;
      const obstacles = graph.nodes
        .filter((nd) => nd.id !== e.fromId && nd.id !== e.toId)
        .map((nd) => layout.centers.get(nd.id)!);
      expect(minDistanceToObstacles(path, obstacles)).toBeGreaterThanOrEqual(clearance - GEOM_EPS);
    }
  });
});
