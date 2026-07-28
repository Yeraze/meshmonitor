/**
 * Runs in the default node environment — tracerouteStrip.ts is pure, React-
 * free, Leaflet-free, and DeviceInfo-free (#4381 WP2).
 *
 * Test names mirror the case numbers in
 * docs/internal/dev-notes/TRACEROUTE_VISUAL_STRIP_SPEC.md §3.7.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTracerouteStripGraph,
  buildStripGraphFromLegs,
  layoutTracerouteStrip,
  BROADCAST_ADDR,
  type TracerouteStripInput,
  type TracerouteStripGraph,
} from './tracerouteStrip';

// Reusable "real" node numbers — small distinct integers that are never
// reserved/placeholder values (isValidRouteNode rejects <=3, 255, 65535,
// BROADCAST_ADDR).
const FROM = 100;
const TO = 200;
const A = 100; // alias for readability in divergence cases (== FROM)
const B = 110;
const C = 120;
const D = 200; // alias (== TO)
const E = 130;
const X = 140;
const Y = 150;

function findNode(graph: TracerouteStripGraph, nodeNum: number, row?: 0 | 1) {
  return graph.nodes.filter((n) => n.nodeNum === nodeNum && (row === undefined || n.row === row));
}

describe('buildTracerouteStripGraph — §3.7 edge cases', () => {
  it('case 1: both legs entirely absent (route=null, routeBack=null) yields an empty graph', () => {
    const input: TracerouteStripInput = { fromNodeNum: FROM, toNodeNum: TO, route: null, routeBack: null };
    const graph = buildTracerouteStripGraph(input);
    expect(graph).toEqual({
      nodes: [],
      edges: [],
      columns: 0,
      hasForward: false,
      hasReturn: false,
      isEmpty: true,
    });
  });

  it("case 2: route = 'null' (the string) behaves like absent for that leg", () => {
    const input: TracerouteStripInput = { fromNodeNum: FROM, toNodeNum: TO, route: 'null', routeBack: null };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.isEmpty).toBe(true);
    expect(graph.hasForward).toBe(false);
  });

  it("case 3: route = '' behaves like absent for that leg", () => {
    const input: TracerouteStripInput = { fromNodeNum: FROM, toNodeNum: TO, route: '', routeBack: null };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.isEmpty).toBe(true);
    expect(graph.hasForward).toBe(false);
  });

  it("case 4: route = '[]', snrTowards = '[]' emits a direct 2-node forward leg with snr:null", () => {
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: '[]',
      snrTowards: '[]',
      routeBack: null,
    };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.hasForward).toBe(true);
    expect(graph.hasReturn).toBe(false);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ leg: 'forward', snr: null, snrUnknown: false });
  });

  it("case 5: routeBack = '[]', snrBack = '[]' suppresses the return leg (#2051/#3622)", () => {
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: '[]',
      routeBack: '[]',
      snrBack: '[]',
    };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.hasReturn).toBe(false);
    expect(graph.edges.every((e) => e.leg === 'forward')).toBe(true);
  });

  it('case 6: forward only (routeBack null) — one row, forward edges only', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: JSON.stringify([B]),
      routeBack: null,
    };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.hasForward).toBe(true);
    expect(graph.hasReturn).toBe(false);
    expect(graph.nodes.every((n) => n.row === 0)).toBe(true);
    expect(graph.edges.every((e) => e.leg === 'forward')).toBe(true);
    expect(graph.nodes.map((n) => n.nodeNum)).toEqual([FROM, B, TO]);
  });

  it("case 7: return only (route null) — one row laid out in the return leg's order (left = toNodeNum)", () => {
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: null,
      routeBack: JSON.stringify([B]),
      snrBack: JSON.stringify([10, 20]),
    };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.hasForward).toBe(false);
    expect(graph.hasReturn).toBe(true);
    expect(graph.nodes.every((n) => n.row === 0)).toBe(true);
    expect(graph.edges.every((e) => e.leg === 'return')).toBe(true);
    // Left = toNodeNum: the return leg's own traversal order.
    expect(graph.nodes.map((n) => n.nodeNum)).toEqual([TO, B, FROM]);
  });

  it('case 8: single hop / direct with both legs present between the same pair', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: '[]',
      routeBack: '[]',
      snrBack: JSON.stringify([-40]),
    };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(2);
    const [fwd, ret] = graph.edges;
    expect(fwd.leg).toBe('forward');
    expect(ret.leg).toBe('return');
    expect(fwd.id).not.toBe(ret.id);
    // Return edge points the other way.
    expect(fwd.fromId).toBe(ret.toId);
    expect(fwd.toId).toBe(ret.fromId);
  });

  it('case 9: identical forward and return paths — full overlap, dedup complete, row 1 unused', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: A,
      toNodeNum: C,
      route: JSON.stringify([B]),
      routeBack: JSON.stringify([B]),
      snrTowards: JSON.stringify([10, 20]),
      snrBack: JSON.stringify([15, 25]),
    };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.nodes).toHaveLength(3); // A, B, C — exactly n nodes
    expect(graph.nodes.every((n) => n.shared)).toBe(true);
    expect(graph.nodes.every((n) => n.row === 0)).toBe(true); // row 1 unused
    expect(graph.edges).toHaveLength(4); // 2(n-1) = 4
  });

  it('case 10: divergence F = A→B→C→D, R = D→E→A — E branches to row 1, A and D shared', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: A,
      toNodeNum: D,
      route: JSON.stringify([B, C]),
      routeBack: JSON.stringify([E]),
      snrBack: JSON.stringify([1, 2]),
    };
    const graph = buildTracerouteStripGraph(input);
    const row0 = graph.nodes.filter((n) => n.row === 0).sort((x, y) => x.col - y.col);
    expect(row0.map((n) => n.nodeNum)).toEqual([A, B, C, D]);
    const eNode = findNode(graph, E, 1);
    expect(eNode).toHaveLength(1);
    const aNode = findNode(graph, A, 0)[0];
    const dNode = findNode(graph, D, 0)[0];
    expect(aNode.shared).toBe(true);
    expect(dNode.shared).toBe(true);
    // Return edges D->E, E->A both cross rows.
    const returnEdges = graph.edges.filter((e) => e.leg === 'return');
    expect(returnEdges.map((e) => [e.fromId, e.toId])).toEqual([
      [dNode.id, eNode[0].id],
      [eNode[0].id, aNode.id],
    ]);
  });

  it('case 11: multi-node branch F = A→B→C, R = C→X→Y→A — X,Y on row 1, monotone columns, one inserted', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: A,
      toNodeNum: C,
      route: JSON.stringify([B]),
      routeBack: JSON.stringify([X, Y]),
      snrBack: JSON.stringify([1, 2, 3]),
    };
    const graph = buildTracerouteStripGraph(input);
    const xNode = findNode(graph, X, 1)[0];
    const yNode = findNode(graph, Y, 1)[0];
    expect(xNode).toBeDefined();
    expect(yNode).toBeDefined();
    const aNode = findNode(graph, A, 0)[0];
    const cNode = findNode(graph, C, 0)[0];
    // Traversal C -> X -> Y -> A must be column-monotone (decreasing, since
    // it travels right-to-left): cNode.col > xNode.col > yNode.col > aNode.col.
    expect(cNode.col).toBeGreaterThan(xNode.col);
    expect(xNode.col).toBeGreaterThan(yNode.col);
    expect(yNode.col).toBeGreaterThan(aNode.col);
    // Before insertion: A=0,B=1,C=2, available = hi-lo-1 = 2-0-1 = 1 slot,
    // but k=2 -> deficit=1 column inserted after lo=0. After insertion:
    // A=0 (unshifted, it IS lo), B=2, C=3 (both shifted right by 1). Row 1
    // (Y,X) fills the two now-available slots between lo and the new hi:
    // columns 1 and 2 (branch columns MAY coincide with a row-0 column —
    // they're different rows, so no collision). Max col = 3 -> columns = 4.
    expect(graph.columns).toBe(4);
  });

  it('case 12: loop within one leg route = [B, C, B] — 3 distinct columns, first-occurrence-wins dedup', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: JSON.stringify([B, C, B]),
      routeBack: JSON.stringify([B]), // revisits B — must anchor to the FIRST B's column
    };
    const graph = buildTracerouteStripGraph(input);
    const row0 = graph.nodes.filter((n) => n.row === 0).sort((x, y) => x.col - y.col);
    // FROM, B, C, B, TO -> 5 distinct StripNodes, 3 distinct columns for B/C/B.
    expect(row0.map((n) => n.nodeNum)).toEqual([FROM, B, C, B, TO]);
    const bOccurrences = row0.filter((n) => n.nodeNum === B);
    expect(bOccurrences).toHaveLength(2);
    expect(new Set(bOccurrences.map((n) => n.col)).size).toBe(2);
    // First-occurrence-wins: the return leg's B hop must anchor to the FIRST
    // B (col 1), marking IT shared — not the second B (col 3).
    const firstB = bOccurrences.find((n) => n.col === 1)!;
    const secondB = bOccurrences.find((n) => n.col === 3)!;
    expect(firstB.shared).toBe(true);
    expect(secondB.shared).toBe(false);
    // Edges have distinct ids even though two of them touch the same nodeNum.
    const ids = graph.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('case 13: reserved node numbers in route are dropped; surviving hops keep their OWN unshifted SNR', () => {
    // route entries [2,999,255,65535,1234] pair index-aligned with
    // snrTowards [10,20,30,40,50] (each route entry's OWN arrival snr), and
    // snrTowards[5]=60 is the destination (`to`)'s arrival snr.
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: JSON.stringify([2, 999, 255, 65535, 1234]),
      snrTowards: JSON.stringify([10, 20, 30, 40, 50, 60]),
    };

    const graph = buildTracerouteStripGraph(input);
    const row0 = graph.nodes.sort((x, y) => x.col - y.col);
    expect(row0.map((n) => n.nodeNum)).toEqual([FROM, 999, 1234, TO]);

    expect(graph.edges).toHaveLength(3);
    // 999's own arrival snr = raw 20 / 4 = 5 (unshifted — NOT the dropped
    // node's raw 10, and NOT re-indexed to some other value).
    expect(graph.edges[0].snr).toBe(5);
    // 1234's own arrival snr = raw 50 / 4 = 12.5.
    expect(graph.edges[1].snr).toBe(12.5);
    // to's own arrival snr = raw 60 / 4 = 15.
    expect(graph.edges[2].snr).toBe(15);
  });

  it('case 14: BROADCAST_ADDR in route is kept with isUnknown:true and still gets its edge + SNR', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: JSON.stringify([BROADCAST_ADDR]),
      snrTowards: JSON.stringify([40, 20]),
    };
    const graph = buildTracerouteStripGraph(input);
    const row0 = graph.nodes.sort((x, y) => x.col - y.col);
    expect(row0.map((n) => n.nodeNum)).toEqual([FROM, BROADCAST_ADDR, TO]);
    const bcastNode = row0.find((n) => n.nodeNum === BROADCAST_ADDR)!;
    expect(bcastNode.isUnknown).toBe(true);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges[0].snr).toBe(10); // 40/4
    expect(graph.edges[1].snr).toBe(5); // 20/4
  });

  it('case 15: snrTowards SHORTER than the hop list — missing entries become snr:null, snrUnknown:false', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: JSON.stringify([B]),
      snrTowards: '[]', // no samples at all
    };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.edges).toHaveLength(2);
    for (const e of graph.edges) {
      expect(e.snr).toBeNull();
      expect(e.snrUnknown).toBe(false);
    }
  });

  it('case 16: snrTowards LONGER than the hop list — extra entries ignored, destination arrival snr IS used', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: JSON.stringify([B]), // 1 intermediate hop
      snrTowards: JSON.stringify([40, 32, 999]), // 3 entries; index 2 unused
    };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges[0].snr).toBe(10); // B's arrival snr = 40/4
    expect(graph.edges[1].snr).toBe(8); // to's arrival snr = snrTowards[1] = 32/4
  });

  it('case 17: snrTowards contains -128 — the INT8_MIN sentinel maps to snr:null, snrUnknown:true', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: '[]',
      snrTowards: JSON.stringify([-128]),
    };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].snr).toBeNull();
    expect(graph.edges[0].snrUnknown).toBe(true);
  });

  it("case 18: malformed JSON (route = '{') is caught by parseHopArray -> [], leg still emitted as direct", () => {
    const input: TracerouteStripInput = { fromNodeNum: FROM, toNodeNum: TO, route: '{' };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.hasForward).toBe(true);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
  });

  it("case 19: non-array JSON (route = '5') parses to [] via parseHopArray, same as malformed", () => {
    const input: TracerouteStripInput = { fromNodeNum: FROM, toNodeNum: TO, route: '5' };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.hasForward).toBe(true);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
  });

  it('case 20: fromNodeNum === toNodeNum is degenerate but must not crash or loop', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: FROM,
      route: '[]',
      routeBack: null,
    };
    expect(() => buildTracerouteStripGraph(input)).not.toThrow();
    const graph = buildTracerouteStripGraph(input);
    expect(graph.isEmpty).toBe(false);
    // Spec §3.7's summary phrase for this case says "single column when the
    // route is empty" — that is NOT literal: §3.4's per-element rule ("each
    // element becomes a StripNode ... its own column") still applies to the
    // two endpoint hops here, so this yields 2 StripNodes / 2 columns, same
    // as the loop case (case 12). Confirmed correct reading with the spec
    // author: "single ROW" is what's meant (no divergence is possible for a
    // degenerate self-path, so row 1 stays unused) — do NOT "fix" this back
    // to asserting a single column.
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.every((n) => n.row === 0)).toBe(true);
    expect(graph.edges).toHaveLength(1);
  });

  it('case 21: legs sharing no node (hand-built) — secondary leg placed wholly on row 1 from column 0, no throw', () => {
    expect(() =>
      buildStripGraphFromLegs(
        { leg: 'forward', hops: [{ nodeNum: 1 }, { nodeNum: 2 }] },
        { leg: 'return', hops: [{ nodeNum: 3 }, { nodeNum: 4 }] },
      ),
    ).not.toThrow();

    const graph = buildStripGraphFromLegs(
      { leg: 'forward', hops: [{ nodeNum: 1 }, { nodeNum: 2 }] },
      { leg: 'return', hops: [{ nodeNum: 3 }, { nodeNum: 4 }] },
    );
    const row1 = graph.nodes.filter((n) => n.row === 1).sort((x, y) => x.col - y.col);
    expect(row1.map((n) => n.nodeNum)).toEqual([3, 4]);
    expect(row1[0].col).toBe(0);
    expect(row1.every((n) => !n.shared)).toBe(true);
  });

  it('case 22: BROADCAST_ADDR in BOTH legs must never cross-leg dedup — two independent unknown hops stay two nodes', () => {
    // Firmware backfills NODENUM_BROADCAST independently per leg
    // (TraceRouteModule::insertUnknownHops), so the forward leg's "we don't
    // know who this was" and the return leg's are almost always two
    // DIFFERENT physical (unknown) relays. Merging them into one shared
    // StripNode would draw a false overlap.
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: JSON.stringify([BROADCAST_ADDR]),
      routeBack: JSON.stringify([BROADCAST_ADDR]),
      snrTowards: JSON.stringify([10, 20]),
      snrBack: JSON.stringify([30, 40]),
    };
    const graph = buildTracerouteStripGraph(input);

    const unknownNodes = graph.nodes.filter((n) => n.nodeNum === BROADCAST_ADDR);
    expect(unknownNodes).toHaveLength(2); // two distinct StripNodes, not one
    expect(unknownNodes.every((n) => !n.shared)).toBe(true); // neither is shared

    // The return leg's unknown hop must land on the branch row, not get
    // anchored onto the forward leg's unknown hop.
    const returnUnknown = unknownNodes.find((n) => n.legs.includes('return'));
    expect(returnUnknown).toBeDefined();
    expect(returnUnknown!.row).toBe(1);

    // The fix must not over-correct: the genuinely shared endpoints
    // (fromNodeNum/toNodeNum) still dedup correctly in this same graph.
    const fromNode = findNode(graph, FROM, 0)[0];
    const toNode = findNode(graph, TO, 0)[0];
    expect(fromNode.shared).toBe(true);
    expect(toNode.shared).toBe(true);
  });
});

describe('layoutTracerouteStrip', () => {
  it('computes center/width/height arithmetic from fixed defaults', () => {
    const graph = buildTracerouteStripGraph({
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: '[]',
      routeBack: null,
    });
    const layout = layoutTracerouteStrip(graph);
    expect(graph.columns).toBe(2);
    expect(layout.width).toBe(2 * 64); // columns * colWidth
    expect(layout.height).toBe(44 + 1 * 56 + 26); // topBand + rows*rowHeight + bottomBand

    const [n0, n1] = graph.nodes;
    expect(layout.centers.get(n0.id)).toEqual({ x: 32, y: 60 }); // col0: 0*64+32, 44+0*56+16
    expect(layout.centers.get(n1.id)).toEqual({ x: 96, y: 60 }); // col1: 64+32
  });

  it('gives a row-crossing edge a 3-point polyline', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: A,
      toNodeNum: D,
      route: JSON.stringify([B, C]),
      routeBack: JSON.stringify([E]),
      snrBack: JSON.stringify([1, 2]),
    };
    const graph = buildTracerouteStripGraph(input);
    const layout = layoutTracerouteStrip(graph);
    const crossingEdges = graph.edges.filter((e) => e.leg === 'return');
    expect(crossingEdges).toHaveLength(2);
    for (const e of crossingEdges) {
      expect(layout.edgePaths.get(e.id)).toHaveLength(3);
    }
  });

  it('anchors the forward SNR label above the row and the return label below', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: '[]',
      routeBack: '[]',
      snrBack: JSON.stringify([-40]),
    };
    const graph = buildTracerouteStripGraph(input);
    const layout = layoutTracerouteStrip(graph);
    const fwdEdge = graph.edges.find((e) => e.leg === 'forward')!;
    const retEdge = graph.edges.find((e) => e.leg === 'return')!;
    const fwdAnchor = layout.labelAnchors.get(fwdEdge.id)!;
    const retAnchor = layout.labelAnchors.get(retEdge.id)!;
    const rowCenterY = layout.centers.get(graph.nodes[0].id)!.y;
    expect(fwdAnchor.y).toBeLessThan(rowCenterY); // above
    expect(retAnchor.y).toBeGreaterThan(rowCenterY); // below
  });

  it('scales every dimension when a compact-style options override is passed', () => {
    const graph = buildTracerouteStripGraph({
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: '[]',
      routeBack: null,
    });
    const compactOpts = { colWidth: 48, rowHeight: 44, glyphSize: 24, topBand: 34, bottomBand: 20 };
    const layout = layoutTracerouteStrip(graph, compactOpts);
    expect(layout.width).toBe(2 * 48);
    expect(layout.height).toBe(34 + 1 * 44 + 20);
    const [n0, n1] = graph.nodes;
    expect(layout.centers.get(n0.id)).toEqual({ x: 24, y: 34 + 12 }); // col0: 0*48+24, 34+0*44+12
    expect(layout.centers.get(n1.id)).toEqual({ x: 72, y: 46 }); // col1: 48+24
  });
});
