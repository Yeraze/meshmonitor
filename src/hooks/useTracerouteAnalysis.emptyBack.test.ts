/**
 * @vitest-environment jsdom
 *
 * jsdom is required because useTracerouteAnalysis now imports isUnknownSnr/
 * UNKNOWN_SNR_SENTINEL from utils/mapHelpers.tsx (#4047 P3 WP1, folding the
 * previously-duplicated sentinel into its single canonical home), and
 * mapHelpers.tsx pulls in `leaflet`, which touches `window` at module scope.
 *
 * Tests for issue #3622 — fictitious direct-connection line from empty routeBack.
 *
 * When MeshMonitor is connected to the TARGET node (L) of a traceroute:
 *  1. L receives an incoming REQUEST (from=A, to=L, requestId=0).
 *     - Old behaviour: saved as a traceroute record with routeBack='[]', snrBack='[]'.
 *     - New behaviour (meshtasticManager fix): REQUEST is skipped entirely.
 *  2. L immediately sends a RESPONSE (from=L, to=A, requestId≠0).
 *     - routeBack is still '[]' at this point — relay nodes haven't populated it yet.
 *     - Old behaviour: `segmentsForTraceroute` built backPath=[L, A] → direct segment.
 *     - New behaviour: empty routeBack + empty snrBack → backPath suppressed.
 *
 * These tests validate the `segmentsForTraceroute` / `analyzeTraceroutes` half of the fix.
 * The `formatTracerouteRoute` half is validated in utils/traceroute.emptyBack.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeTraceroutes,
  type TracerouteAnalysisInput,
  type AnalyzeParams,
  type TracerouteAnalysisOptions,
} from './useTracerouteAnalysis';

// Node numbers: A (requester), L (responder / local / target), C (relay).
const A = 0xaaaa0001; // requester
const L = 0xbbbb0002; // responder (local node — MeshMonitor is on this node)
const C = 0xcccc0003; // relay between them

function positions(...nums: number[]): Map<string, [number, number]> {
  const m = new Map<string, [number, number]>();
  nums.forEach((n, i) => m.set(`s1:${n}`, [10 + i, 20 + i]));
  return m;
}

const defaultOptions: TracerouteAnalysisOptions = {
  directionMode: 'both',
  scopeToSelectedNode: true,
  minOccurrences: 1,
  minSnr: null,
};

function makeParams(overrides: Partial<AnalyzeParams>): AnalyzeParams {
  return {
    traceroutes: [],
    positionByKey: positions(A, L, C),
    selectedNodeNum: null,
    selectedSourceId: null,
    options: defaultOptions,
    visibleNodeNums: null,
    timeWindow: null,
    ...overrides,
  };
}

describe('analyzeTraceroutes — empty routeBack + empty snrBack (issue #3622)', () => {
  it('does NOT draw a direct segment when routeBack=[] and snrBack=[] (unresolved return path)', () => {
    // This represents the "local node response seen before relay nodes populate routeBack":
    //   fromNodeNum = L (responder/local), toNodeNum = A (requester)
    //   route = [C] (forward path A→C→L), routeBack = [] (not yet populated)
    //   snrTowards = [raw_snr1, raw_snr2], snrBack = []
    const tr: TracerouteAnalysisInput = {
      id: 1,
      fromNodeNum: L,
      toNodeNum: A,
      sourceId: 's1',
      route: JSON.stringify([C]),
      routeBack: '[]',
      snrTowards: JSON.stringify([40, 32]), // 10 dB@C, 8 dB@L
      snrBack: JSON.stringify([]),          // empty — return path not recorded yet
      timestamp: 1_000,
    };

    const { segments } = analyzeTraceroutes(
      makeParams({
        traceroutes: [tr],
        selectedNodeNum: L,
        selectedSourceId: 's1',
      }),
    );

    // The ONLY segments incident to L should be from the forward path:
    //   A→C (L is not involved) — filtered out by focus scoping
    //   C→L (inbound to L) — survives
    // The backPath (L→A direct) must NOT appear.
    const backPathSegment = segments.find(
      (s) => s.from === L && s.to === A,
    );
    expect(backPathSegment).toBeUndefined();

    // The forward-path inbound segment C→L should still be present.
    const inboundFromC = segments.find(
      (s) => s.from === C && s.to === L,
    );
    expect(inboundFromC).toBeDefined();
    expect(inboundFromC!.direction).toBe('inbound');
  });

  it('DOES draw a direct segment when routeBack=[] but snrBack has data (genuine direct RF hop)', () => {
    // This is a legitimate single-hop traceroute where the return path is direct
    // but the firmware reports an SNR for that hop.
    //   fromNodeNum = L, toNodeNum = A
    //   route = [], routeBack = []
    //   snrBack = [raw_snr] — confirms an actual RF reception at A
    const tr: TracerouteAnalysisInput = {
      id: 2,
      fromNodeNum: L,
      toNodeNum: A,
      sourceId: 's1',
      route: '[]',
      routeBack: '[]',
      snrTowards: JSON.stringify([40]),  // A→L direct, 10 dB@L
      snrBack: JSON.stringify([32]),     // L→A direct, 8 dB@A
      timestamp: 1_000,
    };

    const { segments } = analyzeTraceroutes(
      makeParams({
        traceroutes: [tr],
        selectedNodeNum: L,
        selectedSourceId: 's1',
      }),
    );

    // snrBack is non-empty so the backPath IS drawn: L→A (outbound from L's POV).
    const outboundToA = segments.find(
      (s) => s.from === L && s.to === A,
    );
    expect(outboundToA).toBeDefined();
    expect(outboundToA!.direction).toBe('outbound');
    expect(outboundToA!.avgSnr).toBe(8); // 32 / 4
  });

  it('suppresses only the back path — forward path segments are unaffected', () => {
    // Verifies that when backPath is suppressed, the forward route still produces
    // its full set of directed segments.
    const tr: TracerouteAnalysisInput = {
      id: 3,
      fromNodeNum: L,
      toNodeNum: A,
      sourceId: 's1',
      route: JSON.stringify([C]),
      routeBack: '[]',
      snrTowards: JSON.stringify([40, 32]),
      snrBack: '[]',
      timestamp: 1_000,
    };

    // Use global (non-focused) view so we can see all segments.
    const { segments } = analyzeTraceroutes(
      makeParams({
        traceroutes: [tr],
        selectedNodeNum: null,
        options: { ...defaultOptions, scopeToSelectedNode: false },
      }),
    );

    // Forward path: A→C→L produces 2 directed segments.
    const fwdAtoC = segments.find((s) => s.from === A && s.to === C);
    const fwdCtoL = segments.find((s) => s.from === C && s.to === L);
    expect(fwdAtoC).toBeDefined();
    expect(fwdCtoL).toBeDefined();

    // Back path entirely absent (both routeBack and snrBack are empty).
    const anyBack = segments.filter((s) => s.from === L || (s.from === C && s.to === A));
    // L→A and L→C and C→A are all back-path segments — none should exist.
    const backSegments = segments.filter((s) => s.from === L);
    expect(backSegments).toHaveLength(0);
  });

  it('handles routeBack populated (normal case) — back path is drawn correctly', () => {
    // Confirms that once relay nodes populate routeBack, the return path is visible.
    const tr: TracerouteAnalysisInput = {
      id: 4,
      fromNodeNum: L,
      toNodeNum: A,
      sourceId: 's1',
      route: JSON.stringify([C]),
      routeBack: JSON.stringify([C]),  // relay populated the return path
      snrTowards: JSON.stringify([40, 32]),
      snrBack: JSON.stringify([36, 28]),
      timestamp: 1_000,
    };

    const { segments } = analyzeTraceroutes(
      makeParams({
        traceroutes: [tr],
        selectedNodeNum: L,
        selectedSourceId: 's1',
      }),
    );

    // Back path: L→C (outbound from L's perspective) — should exist.
    const outboundToC = segments.find((s) => s.from === L && s.to === C);
    expect(outboundToC).toBeDefined();
    expect(outboundToC!.direction).toBe('outbound');

    // Direct L→A must NOT appear since routeBack=[C] routes through C.
    const directBack = segments.find((s) => s.from === L && s.to === A);
    expect(directBack).toBeUndefined();
  });
});
