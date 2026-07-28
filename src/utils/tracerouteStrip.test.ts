/**
 * Runs in the default node environment — tracerouteStrip.ts is pure, React-
 * free, Leaflet-free, and DeviceInfo-free (#4381 WP2; spine model WP-A/WP-B).
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
  type StripLayoutOptions,
  type StripLane,
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

function findNode(graph: TracerouteStripGraph, nodeNum: number) {
  return graph.nodes.filter((n) => n.nodeNum === nodeNum);
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

  it("case 4: route = '[]', snrTowards = '[]' emits a direct 2-node forward leg with snr:null, on the spine lane", () => {
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
    // Single leg -> that leg IS the spine (§3.4.8).
    expect(graph.nodes.every((n) => n.lane === 'spine')).toBe(true);
    expect(graph.nodes.every((n) => !n.shared)).toBe(true);
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

  it('case 6: forward only (routeBack null) — one row, forward edges only, spine lane', () => {
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
    expect(graph.nodes.every((n) => n.lane === 'spine')).toBe(true);
    expect(graph.edges.every((e) => e.leg === 'forward')).toBe(true);
    expect(graph.nodes.map((n) => n.nodeNum)).toEqual([FROM, B, TO]);
  });

  it("case 7: return only (route null) — one row laid out in the return leg's order (left = toNodeNum), spine lane", () => {
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
    expect(graph.nodes.every((n) => n.lane === 'spine')).toBe(true);
    expect(graph.edges.every((e) => e.leg === 'return')).toBe(true);
    // Left = toNodeNum: the return leg's own traversal order.
    expect(graph.nodes.map((n) => n.nodeNum)).toEqual([TO, B, FROM]);
  });

  it('case 8: single hop / direct with both legs present between the same pair — both endpoints shared spine nodes', () => {
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
    expect(graph.nodes.every((n) => n.lane === 'spine' && n.shared)).toBe(true);
    const [fwd, ret] = graph.edges;
    expect(fwd.leg).toBe('forward');
    expect(ret.leg).toBe('return');
    expect(fwd.id).not.toBe(ret.id);
    // Return edge points the other way.
    expect(fwd.fromId).toBe(ret.toId);
    expect(fwd.toId).toBe(ret.fromId);
  });

  it('case 9: identical forward and return paths (4-node, reversed order) — full overlap, all-spine, one flat row', () => {
    // Extended to a 4-node path (2 intermediates) so the symmetric-stays-flat
    // guard isn't trivially satisfied by a single-hop fixture: the return
    // leg's own traversal order is the REVERSE of the forward leg's
    // ([C, B] vs [B, C]), and the spine construction + per-leg walk must
    // still collapse this onto one row with zero branch nodes.
    const input: TracerouteStripInput = {
      fromNodeNum: A,
      toNodeNum: D,
      route: JSON.stringify([B, C]),
      routeBack: JSON.stringify([C, B]),
      snrTowards: JSON.stringify([10, 20, 30]),
      snrBack: JSON.stringify([15, 25, 35]),
    };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.nodes).toHaveLength(4); // A, B, C, D — exactly n nodes
    expect(graph.nodes.every((n) => n.shared)).toBe(true);
    expect(graph.nodes.every((n) => n.lane === 'spine')).toBe(true);
    expect(graph.nodes.every((n) => n.row === 0)).toBe(true); // branch lanes unused
    expect(graph.edges).toHaveLength(6); // 2(n-1) = 6
  });

  it('case 10: divergence F = A→B→C→D, R = D→E→A — spine [A,D]; B,C raised (forward); E dropped (return)', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: A,
      toNodeNum: D,
      route: JSON.stringify([B, C]),
      routeBack: JSON.stringify([E]),
      snrBack: JSON.stringify([1, 2]),
    };
    const graph = buildTracerouteStripGraph(input);

    const aNode = findNode(graph, A)[0];
    const bNode = findNode(graph, B)[0];
    const cNode = findNode(graph, C)[0];
    const dNode = findNode(graph, D)[0];
    const eNode = findNode(graph, E)[0];

    expect(aNode.lane).toBe('spine');
    expect(dNode.lane).toBe('spine');
    expect(aNode.shared).toBe(true);
    expect(dNode.shared).toBe(true);
    expect(bNode.lane).toBe('forward');
    expect(cNode.lane).toBe('forward');
    expect(eNode.lane).toBe('return');
    expect(bNode.shared).toBe(false);
    expect(eNode.shared).toBe(false);

    expect(aNode.col).toBe(0);
    expect(bNode.col).toBe(1);
    expect(cNode.col).toBe(2);
    expect(dNode.col).toBe(3);
    expect(eNode.col).toBe(1);
    expect(graph.columns).toBe(4);

    // Three rows: forward (0) above spine (1) above return (2).
    expect(bNode.row).toBe(0);
    expect(cNode.row).toBe(0);
    expect(aNode.row).toBe(1);
    expect(dNode.row).toBe(1);
    expect(eNode.row).toBe(2);

    // Return edges D->E, E->A both cross rows (spine <-> return-lane).
    const returnEdges = graph.edges.filter((e) => e.leg === 'return');
    expect(returnEdges.map((e) => [e.fromId, e.toId])).toEqual([
      [dNode.id, eNode.id],
      [eNode.id, aNode.id],
    ]);
  });

  it('case 11: multi-node branch F = A→B→C, R = C→X→Y→A — spine [A,C]; B raised forward; X,Y dropped return', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: A,
      toNodeNum: C,
      route: JSON.stringify([B]),
      routeBack: JSON.stringify([X, Y]),
      snrBack: JSON.stringify([1, 2, 3]),
    };
    const graph = buildTracerouteStripGraph(input);
    const aNode = findNode(graph, A)[0];
    const bNode = findNode(graph, B)[0];
    const cNode = findNode(graph, C)[0];
    const xNode = findNode(graph, X)[0];
    const yNode = findNode(graph, Y)[0];

    expect(aNode.lane).toBe('spine');
    expect(cNode.lane).toBe('spine');
    expect(bNode.lane).toBe('forward');
    expect(xNode.lane).toBe('return');
    expect(yNode.lane).toBe('return');

    // Traversal C -> X -> Y -> A must be column-monotone (decreasing, since
    // it travels right-to-left): cNode.col > xNode.col > yNode.col > aNode.col.
    expect(cNode.col).toBeGreaterThan(xNode.col);
    expect(xNode.col).toBeGreaterThan(yNode.col);
    expect(yNode.col).toBeGreaterThan(aNode.col);

    expect(aNode.col).toBe(0);
    expect(bNode.col).toBe(2);
    expect(xNode.col).toBe(2);
    expect(yNode.col).toBe(1);
    expect(cNode.col).toBe(3);
    expect(graph.columns).toBe(4);

    // Three rows: forward (B) above spine (A,C) above return (X,Y).
    expect(bNode.row).toBe(0);
    expect(aNode.row).toBe(1);
    expect(cNode.row).toBe(1);
    expect(xNode.row).toBe(2);
    expect(yNode.row).toBe(2);
  });

  it('case 12: loop within one leg route = [B, C, B] — spine [FROM,B,TO]; C and second B raised to the forward lane', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: JSON.stringify([B, C, B]),
      routeBack: JSON.stringify([B]), // revisits B — must anchor to the FIRST B's spine column
    };
    const graph = buildTracerouteStripGraph(input);

    const spineNodes = graph.nodes.filter((n) => n.lane === 'spine').sort((x, y) => x.col - y.col);
    expect(spineNodes.map((n) => n.nodeNum)).toEqual([FROM, B, TO]);
    expect(spineNodes.map((n) => n.col)).toEqual([0, 1, 4]);
    expect(spineNodes.every((n) => n.shared)).toBe(true);

    const forwardNodes = graph.nodes.filter((n) => n.lane === 'forward').sort((x, y) => x.col - y.col);
    expect(forwardNodes.map((n) => n.nodeNum)).toEqual([C, B]); // C, then the SECOND B
    expect(forwardNodes.map((n) => n.col)).toEqual([2, 3]);
    expect(forwardNodes.every((n) => !n.shared)).toBe(true);

    expect(graph.nodes.filter((n) => n.lane === 'return')).toHaveLength(0);
    expect(graph.columns).toBe(5);

    // Two rows: forward (C, second B) above spine (FROM, first B, TO).
    expect(forwardNodes.every((n) => n.row === 0)).toBe(true);
    expect(spineNodes.every((n) => n.row === 1)).toBe(true);

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

  it('case 14: BROADCAST_ADDR in route is kept with isUnknown:true and still gets its edge + SNR (single leg => spine lane)', () => {
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
    // Single-leg graph: the I6 cross-leg-dedup exemption is about NOT
    // dedup'ing two independently-unknown hops across legs — it says
    // nothing about a one-leg graph, which has no dedup to do at all.
    expect(bcastNode.lane).toBe('spine');
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
    // degenerate self-path, so no branch lane is ever used) — do NOT "fix"
    // this back to asserting a single column.
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.every((n) => n.row === 0)).toBe(true);
    expect(graph.edges).toHaveLength(1);
  });

  it('case 21: legs sharing no node (hand-built) — NO spine at all; each leg wholly on its own lane from column 0', () => {
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
    // No spine lane at all — every node is forward- or return-exclusive.
    expect(graph.nodes.every((n) => n.lane !== 'spine')).toBe(true);
    expect(graph.nodes.filter((n) => n.lane === 'forward').map((n) => n.nodeNum)).toEqual([1, 2]);
    expect(row1.every((n) => n.lane === 'return')).toBe(true);
  });

  it('case 22: BROADCAST_ADDR in BOTH legs must never cross-leg dedup — the two unknown hops land on OPPOSITE branch lanes', () => {
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

    // Opposite branch lanes: the forward unknown raises above the spine,
    // the return unknown drops below it.
    const forwardUnknown = unknownNodes.find((n) => n.legs.includes('forward'))!;
    const returnUnknown = unknownNodes.find((n) => n.legs.includes('return'))!;
    expect(forwardUnknown).toBeDefined();
    expect(returnUnknown).toBeDefined();
    expect(forwardUnknown.lane).toBe('forward');
    expect(returnUnknown.lane).toBe('return');
    expect(forwardUnknown.row).toBe(0);
    expect(returnUnknown.row).toBe(2);

    // The fix must not over-correct: the genuinely shared endpoints
    // (fromNodeNum/toNodeNum) still dedup correctly in this same graph, on
    // the spine (row 1, between the two branch rows).
    const fromNode = findNode(graph, FROM)[0];
    const toNode = findNode(graph, TO)[0];
    expect(fromNode.lane).toBe('spine');
    expect(toNode.lane).toBe('spine');
    expect(fromNode.shared).toBe(true);
    expect(toNode.shared).toBe(true);
    expect(fromNode.row).toBe(1);
    expect(toNode.row).toBe(1);
  });

  it('case 23: the BOCA G2 fixture — the motivating live-mesh bug, used verbatim', () => {
    // forward: Yble -> Yrze -> CS (SW SECTOR) V4 -> TRPK G2 -> BOCA G2
    //   snrTowards [42,-45,29,15]
    // return:  BOCA G2 -> Yrze -> Yble
    //   snrBack [37,44]
    // CS and TRPK are forward-only. The old algorithm put the whole forward
    // leg on row 0 and drew the return edge BOCA->Yrze as a long line
    // passing underneath CS/TRPK, as though the return traversed them — it
    // doesn't. Under the spine model, CS/TRPK raise above the spine and the
    // return edge is a clean same-row spine segment.
    const YBLE = 2001;
    const YRZE = 2002;
    const CS = 2003;
    const TRPK = 2004;
    const BOCA = 2005;
    const input: TracerouteStripInput = {
      fromNodeNum: YBLE,
      toNodeNum: BOCA,
      route: JSON.stringify([YRZE, CS, TRPK]),
      snrTowards: JSON.stringify([42, -45, 29, 15]),
      routeBack: JSON.stringify([YRZE]),
      snrBack: JSON.stringify([37, 44]),
    };
    const graph = buildTracerouteStripGraph(input);

    const yble = findNode(graph, YBLE)[0];
    const yrze = findNode(graph, YRZE)[0];
    const cs = findNode(graph, CS)[0];
    const trpk = findNode(graph, TRPK)[0];
    const boca = findNode(graph, BOCA)[0];

    // Spine = [Yble, Yrze, BOCA G2] at cols 0, 1, 4.
    expect(yble.lane).toBe('spine');
    expect(yrze.lane).toBe('spine');
    expect(boca.lane).toBe('spine');
    expect([yble.col, yrze.col, boca.col]).toEqual([0, 1, 4]);

    // CS and TRPK are forward-exclusive, raised above the spine.
    expect(cs.lane).toBe('forward');
    expect(trpk.lane).toBe('forward');
    expect([cs.col, trpk.col]).toEqual([2, 3]);

    // No return-lane node at all — two rows only.
    expect(graph.nodes.filter((n) => n.lane === 'return')).toHaveLength(0);
    expect(cs.row).toBe(0);
    expect(trpk.row).toBe(0);
    expect(yble.row).toBe(1);
    expect(yrze.row).toBe(1);
    expect(boca.row).toBe(1);
    expect(graph.columns).toBe(5);

    // The critical assertion: the return edge BOCA G2 -> Yrze connects two
    // SPINE nodes on the SAME row — it no longer passes underneath CS/TRPK.
    const returnEdge = graph.edges.find((e) => e.leg === 'return' && e.fromId === boca.id)!;
    expect(returnEdge).toBeDefined();
    expect(returnEdge.toId).toBe(yrze.id);
    const returnFromNode = graph.nodes.find((n) => n.id === returnEdge.fromId)!;
    const returnToNode = graph.nodes.find((n) => n.id === returnEdge.toId)!;
    expect(returnFromNode.row).toBe(returnToNode.row);

    // Forward SNRs land on the right edges too (§1.4 pairing on a real
    // payload): 42/4=10.5, -45/4=-11.25, 29/4=7.25, 15/4=3.75.
    const forwardEdges = graph.edges.filter((e) => e.leg === 'forward');
    expect(forwardEdges.map((e) => e.snr)).toEqual([10.5, -11.25, 7.25, 3.75]);
  });

  it('case 24: forward-only divergence, minimal — F = A→B→C, R = C→A (direct return)', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: JSON.stringify([B]),
      routeBack: '[]',
      snrBack: '[37]', // non-empty snrBack: NOT suppressed by hasReturnPath (unlike case 5)
    };
    const graph = buildTracerouteStripGraph(input);
    expect(graph.hasReturn).toBe(true);

    const fromNode = findNode(graph, FROM)[0];
    const bNode = findNode(graph, B)[0];
    const toNode = findNode(graph, TO)[0];

    expect(fromNode.lane).toBe('spine');
    expect(toNode.lane).toBe('spine');
    expect(bNode.lane).toBe('forward');
    expect(fromNode.col).toBe(0);
    expect(bNode.col).toBe(1);
    expect(toNode.col).toBe(2);
    expect(graph.columns).toBe(3);
    expect(graph.nodes.filter((n) => n.lane === 'return')).toHaveLength(0);

    // Two rows: forward (B) above spine (FROM, TO). No return lane.
    expect(bNode.row).toBe(0);
    expect(fromNode.row).toBe(1);
    expect(toNode.row).toBe(1);

    // Return edge C->A is a same-row spine segment — the shape the old
    // algorithm got wrong in the small.
    const returnEdge = graph.edges.find((e) => e.leg === 'return')!;
    expect(returnEdge.fromId).toBe(toNode.id);
    expect(returnEdge.toId).toBe(fromNode.id);
  });

  it('case 25: simultaneous divergence — F = A→B→C, R = C→X→A, both branch lanes populated', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: A,
      toNodeNum: C,
      route: JSON.stringify([B]),
      routeBack: JSON.stringify([X]),
      snrBack: JSON.stringify([1, 2]),
    };
    const graph = buildTracerouteStripGraph(input);

    const aNode = findNode(graph, A)[0];
    const bNode = findNode(graph, B)[0];
    const cNode = findNode(graph, C)[0];
    const xNode = findNode(graph, X)[0];

    expect(bNode.lane).toBe('forward');
    expect(xNode.lane).toBe('return');
    expect(aNode.lane).toBe('spine');
    expect(cNode.lane).toBe('spine');

    // row(B) < row(A) < row(X).
    expect(bNode.row).toBeLessThan(aNode.row);
    expect(aNode.row).toBeLessThan(xNode.row);

    // B and X may share a column (different lanes/rows) without colliding ids.
    expect(bNode.col).toBe(xNode.col);
    expect(bNode.id).not.toBe(xNode.id);
    const ids = graph.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('case 26: legs share only the endpoints, multi-hop each side — F = A→B→C→D, R = D→X→Y→A', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: A,
      toNodeNum: D,
      route: JSON.stringify([B, C]),
      routeBack: JSON.stringify([X, Y]),
      snrBack: JSON.stringify([1, 2, 3]),
    };
    const graph = buildTracerouteStripGraph(input);

    const aNode = findNode(graph, A)[0];
    const bNode = findNode(graph, B)[0];
    const cNode = findNode(graph, C)[0];
    const dNode = findNode(graph, D)[0];
    const xNode = findNode(graph, X)[0];
    const yNode = findNode(graph, Y)[0];

    expect(aNode.lane).toBe('spine');
    expect(dNode.lane).toBe('spine');
    expect(bNode.lane).toBe('forward');
    expect(cNode.lane).toBe('forward');
    expect(xNode.lane).toBe('return');
    expect(yNode.lane).toBe('return');

    // Each branch run is monotone in its own leg's traversal direction:
    // forward B->C increasing (left-to-right); return X->Y decreasing
    // (right-to-left, since D sits at the high-column end).
    expect(bNode.col).toBeLessThan(cNode.col);
    expect(xNode.col).toBeGreaterThan(yNode.col);
    expect(aNode.col).toBeLessThan(dNode.col);

    // The two branch runs reuse the SAME columns on different lanes — the
    // strip does not grow wider than it needs to.
    expect(new Set([bNode.col, cNode.col])).toEqual(new Set([xNode.col, yNode.col]));
    expect(graph.columns).toBe(4);

    const ids = graph.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('case 27: unknown hops branch while a genuine shared intermediate M stays on the spine', () => {
    // The strongest form of the I6 guard: the unknown-hop dedup exemption
    // must not over-fire and drag a REAL shared hop off the spine with it.
    const M = 2145;
    const input: TracerouteStripInput = {
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: JSON.stringify([BROADCAST_ADDR, M]),
      routeBack: JSON.stringify([M, BROADCAST_ADDR]),
      snrTowards: JSON.stringify([1, 2, 3]),
      snrBack: JSON.stringify([4, 5, 6]),
    };
    const graph = buildTracerouteStripGraph(input);

    const fromNode = findNode(graph, FROM)[0];
    const mNode = findNode(graph, M)[0];
    const toNode = findNode(graph, TO)[0];
    const unknownNodes = graph.nodes.filter((n) => n.nodeNum === BROADCAST_ADDR);

    // M is a REAL shared hop and must stay on the spine.
    expect(mNode.lane).toBe('spine');
    expect(mNode.shared).toBe(true);
    expect(fromNode.lane).toBe('spine');
    expect(toNode.lane).toBe('spine');
    expect([fromNode.col, mNode.col, toNode.col]).toEqual([0, 2, 3]);

    expect(unknownNodes).toHaveLength(2);
    const forwardUnknown = unknownNodes.find((n) => n.legs.includes('forward'))!;
    const returnUnknown = unknownNodes.find((n) => n.legs.includes('return'))!;
    expect(forwardUnknown.lane).toBe('forward');
    expect(returnUnknown.lane).toBe('return');
    expect(forwardUnknown.col).toBe(1);
    expect(returnUnknown.col).toBe(1);

    expect(graph.columns).toBe(4);
    // Three rows: forward, spine, return.
    expect(forwardUnknown.row).toBe(0);
    expect(mNode.row).toBe(1);
    expect(returnUnknown.row).toBe(2);
  });

  it('case 28: invariant sweep — I1 lane containment, I3/I4 per-lane column + id uniqueness, I5 monotonicity, I6 unknowns never on spine', () => {
    const fixtures: TracerouteStripGraph[] = [
      buildTracerouteStripGraph({ fromNodeNum: FROM, toNodeNum: TO, route: '[]', routeBack: null }),
      buildTracerouteStripGraph({
        fromNodeNum: A,
        toNodeNum: D,
        route: JSON.stringify([B, C]),
        routeBack: JSON.stringify([C, B]),
        snrTowards: JSON.stringify([10, 20, 30]),
        snrBack: JSON.stringify([15, 25, 35]),
      }),
      buildTracerouteStripGraph({
        fromNodeNum: A,
        toNodeNum: D,
        route: JSON.stringify([B, C]),
        routeBack: JSON.stringify([E]),
        snrBack: JSON.stringify([1, 2]),
      }),
      buildTracerouteStripGraph({
        fromNodeNum: A,
        toNodeNum: C,
        route: JSON.stringify([B]),
        routeBack: JSON.stringify([X, Y]),
        snrBack: JSON.stringify([1, 2, 3]),
      }),
      buildTracerouteStripGraph({
        fromNodeNum: FROM,
        toNodeNum: TO,
        route: JSON.stringify([B, C, B]),
        routeBack: JSON.stringify([B]),
      }),
      buildTracerouteStripGraph({
        fromNodeNum: FROM,
        toNodeNum: TO,
        route: JSON.stringify([BROADCAST_ADDR]),
        routeBack: JSON.stringify([BROADCAST_ADDR]),
        snrTowards: JSON.stringify([10, 20]),
        snrBack: JSON.stringify([30, 40]),
      }),
      buildTracerouteStripGraph({
        fromNodeNum: A,
        toNodeNum: C,
        route: JSON.stringify([B]),
        routeBack: JSON.stringify([X]),
        snrBack: JSON.stringify([1, 2]),
      }),
      buildTracerouteStripGraph({
        fromNodeNum: A,
        toNodeNum: D,
        route: JSON.stringify([B, C]),
        routeBack: JSON.stringify([X, Y]),
        snrBack: JSON.stringify([1, 2, 3]),
      }),
      buildStripGraphFromLegs(
        { leg: 'forward', hops: [{ nodeNum: 1 }, { nodeNum: 2 }] },
        { leg: 'return', hops: [{ nodeNum: 3 }, { nodeNum: 4 }] },
      ),
    ];

    const nodesById = (g: TracerouteStripGraph) => new Map(g.nodes.map((n) => [n.id, n] as const));

    for (const g of fixtures) {
      const byId = nodesById(g);

      // I1 — lane containment.
      for (const e of g.edges) {
        const from = byId.get(e.fromId)!;
        const to = byId.get(e.toId)!;
        const allowed: StripLane[] = e.leg === 'forward' ? ['spine', 'forward'] : ['spine', 'return'];
        expect(allowed).toContain(from.lane);
        expect(allowed).toContain(to.lane);
      }

      // I3 — per-lane column uniqueness.
      for (const lane of ['forward', 'spine', 'return'] as StripLane[]) {
        const cols = g.nodes.filter((n) => n.lane === lane).map((n) => n.col);
        expect(new Set(cols).size).toBe(cols.length);
      }

      // I4 — id uniqueness.
      const ids = g.nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);

      // I5 — per-leg column monotonicity.
      for (const leg of ['forward', 'return'] as const) {
        const legEdges = g.edges.filter((e) => e.leg === leg);
        if (legEdges.length === 0) continue;
        const chain = [legEdges[0].fromId, ...legEdges.map((e) => e.toId)];
        const cols = chain.map((id) => byId.get(id)!.col);
        const diffs = cols.slice(1).map((c, i) => c - cols[i]);
        expect(diffs.every((d) => d !== 0)).toBe(true);
        const allIncreasing = diffs.every((d) => d > 0);
        const allDecreasing = diffs.every((d) => d < 0);
        expect(allIncreasing || allDecreasing).toBe(true);
      }

      // I6 — unknown hops are never spine nodes, in a two-leg graph.
      if (g.hasForward && g.hasReturn) {
        for (const n of g.nodes) {
          if (n.isUnknown) expect(n.lane).not.toBe('spine');
        }
      }
    }
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
    expect(layout.height).toBe(44 + 1 * 76 + 44); // topBand + rows*rowHeight + bottomBand (rowHeight default now 76)

    const [n0, n1] = graph.nodes;
    expect(layout.centers.get(n0.id)).toEqual({ x: 32, y: 60 }); // col0: 0*64+32, 44+0*76+16
    expect(layout.centers.get(n1.id)).toEqual({ x: 96, y: 60 }); // col1: 64+32
  });

  it('gives every row-crossing edge (both legs) a 3-point polyline; same-lane edges stay 2-point', () => {
    // F = A->B->C->D, R = D->E->A (spec case 10): now produces BOTH a
    // forward crossing edge (A->B, C->D) and a return crossing edge
    // (D->E, E->A), plus one same-row forward branch edge (B->C).
    const input: TracerouteStripInput = {
      fromNodeNum: A,
      toNodeNum: D,
      route: JSON.stringify([B, C]),
      routeBack: JSON.stringify([E]),
      snrBack: JSON.stringify([1, 2]),
    };
    const graph = buildTracerouteStripGraph(input);
    const layout = layoutTracerouteStrip(graph);
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));

    let crossingCount = 0;
    let sameRowCount = 0;
    for (const e of graph.edges) {
      const from = nodeById.get(e.fromId)!;
      const to = nodeById.get(e.toId)!;
      const path = layout.edgePaths.get(e.id)!;
      if (from.row === to.row) {
        expect(path).toHaveLength(2);
        sameRowCount++;
      } else {
        expect(path).toHaveLength(3);
        crossingCount++;
      }
    }
    // Sanity: this fixture actually exercises both shapes.
    expect(crossingCount).toBe(4); // A->B, C->D, D->E, E->A
    expect(sameRowCount).toBe(1); // B->C
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

  it('never anchors a forward-leg label at/below the spine row, nor a return-leg label at/above it (three-row fixture)', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: A,
      toNodeNum: D,
      route: JSON.stringify([B, C]),
      routeBack: JSON.stringify([E]),
      snrTowards: JSON.stringify([10, 20, 30]),
      snrBack: JSON.stringify([1, 2]),
    };
    const graph = buildTracerouteStripGraph(input);
    const layout = layoutTracerouteStrip(graph);
    const spineNode = graph.nodes.find((n) => n.lane === 'spine')!;
    const spineCenterY = layout.centers.get(spineNode.id)!.y;

    for (const e of graph.edges) {
      const anchor = layout.labelAnchors.get(e.id)!;
      if (e.leg === 'forward') {
        expect(anchor.y).toBeLessThan(spineCenterY);
      } else {
        expect(anchor.y).toBeGreaterThan(spineCenterY);
      }
    }
  });

  it('scales every dimension when a compact-style options override is passed', () => {
    const graph = buildTracerouteStripGraph({
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: '[]',
      routeBack: null,
    });
    // A small-size options preset (the component no longer has a "compact"
    // mode of its own — #4381 follow-up — but StripLayoutOptions still
    // supports arbitrary overrides). topBand/bottomBand/rowHeight are the
    // minimum the SNR-label-clearance geometry (§3.5.2 C1-C3) requires for
    // this glyphSize/nameHeight, not arbitrary round numbers.
    const compactOpts = { colWidth: 48, rowHeight: 64, glyphSize: 24, nameHeight: 11, topBand: 40, bottomBand: 40 };
    const layout = layoutTracerouteStrip(graph, compactOpts);
    expect(layout.width).toBe(2 * 48);
    expect(layout.height).toBe(40 + 1 * 64 + 40);
    const [n0, n1] = graph.nodes;
    expect(layout.centers.get(n0.id)).toEqual({ x: 24, y: 40 + 12 }); // col0: 0*48+24, 40+0*64+12
    expect(layout.centers.get(n1.id)).toEqual({ x: 72, y: 52 }); // col1: 48+24
  });
});

describe('layoutTracerouteStrip — SNR label collision avoidance (#4381 follow-up)', () => {
  // A live-deployment check (not a unit test — jsdom has no layout engine)
  // found both SNR labels overlapping node content: `.node`'s CSS centers
  // the glyph AND the short name together as one flex column on a node's
  // `center` point, so a node's real footprint is `glyphSize + gap +
  // nameHeight` tall, not just `glyphSize`. These constants mirror
  // `tracerouteStrip.ts`'s internal `NODE_NAME_GAP`/`LABEL_HALF_HEIGHT` so the
  // assertions below recompute the same geometry contract independently
  // (from the public `StripLayoutOptions`, not by importing the private
  // constants) rather than restating the implementation.
  const NODE_NAME_GAP = 2; // matches `.node { gap: 2px }` in TracerouteStrip.module.css
  const LABEL_HALF_HEIGHT = 8; // matches tracerouteStrip.ts's LABEL_HALF_HEIGHT
  const LABEL_CLEARANCE = 4; // matches tracerouteStrip.ts's LABEL_CLEARANCE

  function directGraphWithBothLabels() {
    // Both legs present with real (non-null, non-sentinel) SNR so both a
    // forward (above) and a return (below) label actually render.
    return buildTracerouteStripGraph({
      fromNodeNum: FROM,
      toNodeNum: TO,
      route: '[]',
      snrTowards: '[20]',
      routeBack: '[]',
      snrBack: '[-40]',
    });
  }

  function expectLabelsClearNodeFootprint(opts: Partial<StripLayoutOptions> & { glyphSize: number; nameHeight: number }) {
    const graph = directGraphWithBothLabels();
    const layout = layoutTracerouteStrip(graph, opts);
    const fwdEdge = graph.edges.find((e) => e.leg === 'forward')!;
    const retEdge = graph.edges.find((e) => e.leg === 'return')!;
    const centerY = layout.centers.get(graph.nodes[0].id)!.y;
    const fwdAnchor = layout.labelAnchors.get(fwdEdge.id)!;
    const retAnchor = layout.labelAnchors.get(retEdge.id)!;

    // The rendered `.node` box (glyph + gap + short name) is centered on
    // `centerY` as ONE unit, so it extends `nodeHalf` on either side — the
    // glyph starts at the box's top edge, the name ends at its bottom edge.
    // (NOT `centerY -/+ glyphSize/2`: that would double-count part of the
    // name/gap on top of the glyph's own half-height.)
    const nodeHalf = (opts.glyphSize + NODE_NAME_GAP + opts.nameHeight) / 2;
    const glyphTop = centerY - nodeHalf;
    const nameBottom = centerY + nodeHalf;

    // Forward label's bottom edge must stay above (numerically less than)
    // the glyph's top edge.
    expect(fwdAnchor.y + LABEL_HALF_HEIGHT).toBeLessThan(glyphTop);
    // Return label's top edge must stay below (numerically greater than)
    // the short name's bottom edge.
    expect(retAnchor.y - LABEL_HALF_HEIGHT).toBeGreaterThan(nameBottom);
  }

  it('guards the default (non-compact) layout', () => {
    expectLabelsClearNodeFootprint({
      colWidth: 64,
      rowHeight: 76,
      glyphSize: 32,
      nameHeight: 14,
      topBand: 44,
      bottomBand: 44,
    });
  });

  it('guards the compact layout — the exact config that overlapped in live deployment', () => {
    expectLabelsClearNodeFootprint({
      colWidth: 48,
      rowHeight: 64,
      glyphSize: 24,
      nameHeight: 11,
      topBand: 40,
      bottomBand: 40,
    });
  });

  it('bumps an under-sized custom topBand/bottomBand up to the safe minimum instead of overlapping', () => {
    // A caller passing bands too small for its glyphSize/nameHeight must not
    // reintroduce the overlap: layoutTracerouteStrip enforces a floor.
    expectLabelsClearNodeFootprint({
      colWidth: 64,
      rowHeight: 56,
      glyphSize: 32,
      nameHeight: 14,
      topBand: 1,
      bottomBand: 1,
    });
  });

  // -------------------------------------------------------------------
  // C1 (§3.5.2): universal label/node clearance — |anchor.y - center(N).y|
  // >= labelOffset, for EVERY edge label and EVERY node in the graph, not
  // just the rendering node's own row. Generalizes the two guards above
  // (which only checked the direct graph's own two nodes) across every
  // multi-lane §3.7 shape, so a three-row graph's forward label can't land
  // inside the raised row above it, etc.
  // -------------------------------------------------------------------

  function computeLabelOffset(opts: { glyphSize: number; nameHeight: number }): number {
    const nodeHalf = (opts.glyphSize + NODE_NAME_GAP + opts.nameHeight) / 2;
    return nodeHalf + LABEL_HALF_HEIGHT + LABEL_CLEARANCE;
  }

  function assertUniversalLabelClearance(
    graph: TracerouteStripGraph,
    opts: Partial<StripLayoutOptions> & { glyphSize: number; nameHeight: number },
  ): void {
    const layout = layoutTracerouteStrip(graph, opts);
    const offset = computeLabelOffset(opts);
    for (const e of graph.edges) {
      const anchor = layout.labelAnchors.get(e.id);
      if (!anchor) continue;
      for (const n of graph.nodes) {
        const c = layout.centers.get(n.id)!;
        expect(Math.abs(anchor.y - c.y)).toBeGreaterThanOrEqual(offset - 1e-9);
      }
    }
  }

  const multiLaneFixtures = (): { name: string; graph: TracerouteStripGraph }[] => [
    { name: 'case 8 (direct, both legs)', graph: buildTracerouteStripGraph({
        fromNodeNum: FROM, toNodeNum: TO, route: '[]', routeBack: '[]', snrBack: '[-40]',
      }) },
    { name: 'case 10 (forward+return divergence)', graph: buildTracerouteStripGraph({
        fromNodeNum: A, toNodeNum: D, route: JSON.stringify([B, C]), routeBack: JSON.stringify([E]),
        snrTowards: JSON.stringify([10, 20, 30]), snrBack: JSON.stringify([1, 2]),
      }) },
    { name: 'case 23 (BOCA G2 — forward-only divergence)', graph: buildTracerouteStripGraph({
        fromNodeNum: 3001, toNodeNum: 3005,
        route: JSON.stringify([3002, 3003, 3004]),
        snrTowards: JSON.stringify([42, -45, 29, 15]),
        routeBack: JSON.stringify([3002]),
        snrBack: JSON.stringify([37, 44]),
      }) },
    { name: 'case 25 (simultaneous divergence, both branch lanes)', graph: buildTracerouteStripGraph({
        fromNodeNum: A, toNodeNum: C, route: JSON.stringify([B]), routeBack: JSON.stringify([X]),
        snrBack: JSON.stringify([1, 2]),
      }) },
    { name: 'case 27 (unknown hops branch, real shared hop stays on spine)', graph: buildTracerouteStripGraph({
        fromNodeNum: FROM, toNodeNum: TO,
        route: JSON.stringify([BROADCAST_ADDR, 3145]),
        routeBack: JSON.stringify([3145, BROADCAST_ADDR]),
        snrTowards: JSON.stringify([1, 2, 3]),
        snrBack: JSON.stringify([4, 5, 6]),
      }) },
  ];

  it('C1 clearance holds over every multi-lane fixture at default options', () => {
    for (const { graph } of multiLaneFixtures()) {
      assertUniversalLabelClearance(graph, { colWidth: 64, rowHeight: 76, glyphSize: 32, nameHeight: 14, topBand: 44, bottomBand: 44 });
    }
  });

  it('C1 clearance holds over every multi-lane fixture at the compact preset', () => {
    for (const { graph } of multiLaneFixtures()) {
      assertUniversalLabelClearance(graph, { colWidth: 48, rowHeight: 64, glyphSize: 24, nameHeight: 11, topBand: 40, bottomBand: 40 });
    }
  });

  it('C1 clearance holds over every multi-lane fixture even with deliberately under-sized rowHeight/bands (floors enforced)', () => {
    for (const { graph } of multiLaneFixtures()) {
      assertUniversalLabelClearance(graph, { colWidth: 64, rowHeight: 1, glyphSize: 32, nameHeight: 14, topBand: 1, bottomBand: 1 });
    }
  });

  it('bumps an under-sized custom rowHeight up to the safe minimum instead of overlapping (three-row graph)', () => {
    const graph = buildTracerouteStripGraph({
      fromNodeNum: A,
      toNodeNum: D,
      route: JSON.stringify([B, C]),
      routeBack: JSON.stringify([E]),
      snrTowards: JSON.stringify([10, 20, 30]),
      snrBack: JSON.stringify([1, 2]),
    });
    assertUniversalLabelClearance(graph, { colWidth: 64, rowHeight: 1, glyphSize: 32, nameHeight: 14, topBand: 44, bottomBand: 44 });
  });
});

describe('layoutTracerouteStrip — per-leg edge lanes (#4381 follow-up #2)', () => {
  // Live deployment found the forward and return edges drawn on the
  // IDENTICAL line whenever the return leg reverses the forward leg between
  // the same two nodes — the most common outcome, and exactly the case
  // dedup collapses onto one row. `points="51,60 77,60"` (solid forward) and
  // `points="77,60 51,60"` (dashed return) render as one muddy
  // double-headed blob. Each leg now gets its own lane via a small
  // perpendicular translation in `layoutTracerouteStrip`.

  it('separates the forward and return edge paths between the same node pair (no longer collinear)', () => {
    // Direct path, both legs present between the identical pair (spec §3.7
    // case 8) — the exact scenario from the live bug report.
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
    const fwdPath = layout.edgePaths.get(fwdEdge.id)!;
    const retPath = layout.edgePaths.get(retEdge.id)!;

    const rowCenterY = layout.centers.get(graph.nodes[0].id)!.y;

    // Both paths still span the same x-range (same two nodes)...
    const fwdXs = fwdPath.map((p) => p.x).sort((a, b) => a - b);
    const retXs = retPath.map((p) => p.x).sort((a, b) => a - b);
    expect(fwdXs).toEqual(retXs);

    // ...but forward sits in the "above" lane and return in the "below"
    // lane, each offset LANE_OFFSET (5px) from the shared centerline, for a
    // full 10px separation — no longer the same horizontal line.
    for (const p of fwdPath) expect(p.y).toBeCloseTo(rowCenterY - 5, 5);
    for (const p of retPath) expect(p.y).toBeCloseTo(rowCenterY + 5, 5);
    expect(fwdPath[0].y).not.toBeCloseTo(retPath[0].y, 1);
  });

  it('keeps the row-crossing branch edge a 3-point polyline that stays clear of both glyphs', () => {
    // F = A->B->C->D, R = D->E->A (spec §3.7 case 10): D->E and E->A cross
    // rows, so they exercise the 3-point dog-leg path, not the 2-point
    // same-row path.
    const input: TracerouteStripInput = {
      fromNodeNum: A,
      toNodeNum: D,
      route: JSON.stringify([B, C]),
      routeBack: JSON.stringify([E]),
      snrBack: JSON.stringify([1, 2]),
    };
    const graph = buildTracerouteStripGraph(input);
    const opts = { colWidth: 64, rowHeight: 76, glyphSize: 32, nameHeight: 14, topBand: 44, bottomBand: 44 };
    const layout = layoutTracerouteStrip(graph, opts);
    const pullIn = opts.glyphSize / 2 + 3;

    const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
    const crossingEdges = graph.edges.filter((e) => e.leg === 'return');
    expect(crossingEdges).toHaveLength(2);

    for (const e of crossingEdges) {
      const path = layout.edgePaths.get(e.id)!;
      // Still a dog-leg, not distorted into a 2-point line.
      expect(path).toHaveLength(3);

      const fromCenter = layout.centers.get(e.fromId)!;
      const toCenter = layout.centers.get(e.toId)!;
      const fromNode = nodeById.get(e.fromId)!;
      const toNode = nodeById.get(e.toId)!;

      // A pure perpendicular translation can only move the rim endpoints
      // FARTHER from their own node's center than the plain pull-in
      // distance (sqrt(pullIn^2 + offset^2) >= pullIn) — i.e. never closer,
      // never under the glyph.
      const startDist = Math.hypot(path[0].x - fromCenter.x, path[0].y - fromCenter.y);
      const endDist = Math.hypot(path[2].x - toCenter.x, path[2].y - toCenter.y);
      expect(startDist).toBeGreaterThanOrEqual(pullIn - 1e-9);
      expect(endDist).toBeGreaterThanOrEqual(pullIn - 1e-9);

      // The elbow (dog-leg midpoint) must not land inside EITHER endpoint's
      // glyph radius — it needs to clear the row it doesn't already sit on.
      const elbow = path[1];
      const distFromFromGlyph = Math.hypot(elbow.x - fromCenter.x, elbow.y - fromCenter.y);
      const distFromToGlyph = Math.hypot(elbow.x - toCenter.x, elbow.y - toCenter.y);
      if (fromNode.row !== toNode.row) {
        expect(distFromFromGlyph).toBeGreaterThanOrEqual(opts.glyphSize / 2);
        expect(distFromToGlyph).toBeGreaterThanOrEqual(opts.glyphSize / 2);
      }
    }
  });

  it('offsets forward/return lanes horizontally for a purely vertical chord (dx===0 canonicalPerpendicular branch)', () => {
    // canonicalPerpendicular's `dx === 0 && dy < 0` branch only fires for a
    // chord with NO horizontal component at all — i.e. two nodes in the same
    // column on different rows. Every other test in this file exercises
    // same-row (horizontal) or dog-leg (diagonal) chords, so this is the only
    // coverage for that branch. Hand-built graph (not buildTracerouteStripGraph
    // — real traceroute data never places both endpoints of one edge in the
    // same column) with a forward edge one way and a return edge the other,
    // between two nodes that share column 0 but sit on different rows.
    const graph: TracerouteStripGraph = {
      nodes: [
        { id: 'n0', nodeNum: FROM, lane: 'spine', row: 0, col: 0, legs: ['forward'], shared: false, isUnknown: false },
        { id: 'n1', nodeNum: TO, lane: 'return', row: 1, col: 0, legs: ['return'], shared: false, isUnknown: false },
      ],
      edges: [
        { id: 'fwd', leg: 'forward', fromId: 'n0', toId: 'n1', snr: null, snrUnknown: false },
        { id: 'ret', leg: 'return', fromId: 'n1', toId: 'n0', snr: null, snrUnknown: false },
      ],
      columns: 1,
      hasForward: true,
      hasReturn: true,
      isEmpty: false,
    };
    const layout = layoutTracerouteStrip(graph);
    const colCenterX = layout.centers.get('n0')!.x;
    expect(layout.centers.get('n1')!.x).toBe(colCenterX); // confirms the chord truly has dx === 0

    const fwdPath = layout.edgePaths.get('fwd')!;
    const retPath = layout.edgePaths.get('ret')!;

    // With no horizontal component to the chord itself, the per-leg lane
    // offset is purely horizontal (canonicalPerpendicular rotates the
    // vertical unit vector 90° into a horizontal one) — every point of the
    // forward path lands on one side of the column, every point of the
    // return path on the other.
    for (const p of fwdPath) expect(p.x).toBeCloseTo(colCenterX + 5, 5);
    for (const p of retPath) expect(p.x).toBeCloseTo(colCenterX - 5, 5);

    // Offset in opposite directions and never collinear (10px apart, same side
    // consistently — not just at one point).
    expect(fwdPath[0].x).not.toBeCloseTo(retPath[0].x, 1);
    expect(fwdPath.every((p) => p.x > colCenterX)).toBe(true);
    expect(retPath.every((p) => p.x < colCenterX)).toBe(true);
  });
});
