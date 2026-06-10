import { describe, it, expect } from 'vitest';
import {
  analyzeTraceroutes,
  type TracerouteAnalysisInput,
  type AnalyzeParams,
  type TracerouteAnalysisOptions,
} from './useTracerouteAnalysis';

// Node numbers used across the fixtures.
const REQ = 100; // requester (local) -> stored as toNodeNum
const RESP = 200; // responder (remote) -> stored as fromNodeNum
const MID = 150; // an intermediate hop

// Positions for everyone so segments are renderable.
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
    positionByKey: positions(REQ, RESP, MID),
    selectedNodeNum: null,
    selectedSourceId: null,
    options: defaultOptions,
    visibleNodeNums: null,
    timeWindow: null,
    ...overrides,
  };
}

// Direct one-hop traceroute: requester <-> responder, SNR raw (dB x 4).
function directTrace(
  id: number,
  snrTowardsRaw: number[],
  snrBackRaw: number[],
  timestamp = 1_000,
): TracerouteAnalysisInput {
  return {
    id,
    fromNodeNum: RESP,
    toNodeNum: REQ,
    sourceId: 's1',
    route: '[]',
    routeBack: '[]',
    snrTowards: JSON.stringify(snrTowardsRaw),
    snrBack: JSON.stringify(snrBackRaw),
    timestamp,
  };
}

describe('analyzeTraceroutes', () => {
  it('decomposes a direct traceroute into outbound + inbound hops for the requester', () => {
    // Forward leg requester->responder: snrTowards[0] measured AT responder (so requester is TX => outbound).
    // Back leg responder->requester: snrBack[0] measured AT requester (so requester is RX => inbound).
    const { segments, summary } = analyzeTraceroutes(
      makeParams({
        traceroutes: [directTrace(1, [20], [12])], // 5 dB towards, 3 dB back
        selectedNodeNum: REQ,
        selectedSourceId: 's1',
      }),
    );

    const outbound = segments.find((s) => s.direction === 'outbound');
    const inbound = segments.find((s) => s.direction === 'inbound');

    expect(outbound).toBeDefined();
    expect(inbound).toBeDefined();
    // Outbound: requester -> responder, neighbour is the responder.
    expect(outbound!.from).toBe(REQ);
    expect(outbound!.to).toBe(RESP);
    expect(outbound!.neighborNum).toBe(RESP);
    expect(outbound!.avgSnr).toBe(5);
    // Inbound: responder -> requester, neighbour is the responder.
    expect(inbound!.from).toBe(RESP);
    expect(inbound!.to).toBe(REQ);
    expect(inbound!.neighborNum).toBe(RESP);
    expect(inbound!.avgSnr).toBe(3);

    expect(summary).not.toBeNull();
    expect(summary!.distinctLinks).toBe(1); // one neighbour (the responder)
    expect(summary!.outboundLinks).toBe(1);
    expect(summary!.inboundLinks).toBe(1);
    expect(summary!.totalObservations).toBe(2);
    expect(summary!.avgSnr).toBe(4); // mean of 5 and 3
  });

  it('classifies an intermediate selected node from both legs', () => {
    // route=[MID]: forward path req -> MID -> resp. snrTowards[0]@MID, snrTowards[1]@resp.
    const tr: TracerouteAnalysisInput = {
      id: 2,
      fromNodeNum: RESP,
      toNodeNum: REQ,
      sourceId: 's1',
      route: JSON.stringify([MID]),
      routeBack: '[]',
      snrTowards: JSON.stringify([16, 8]), // 4 dB @MID, 2 dB @resp
      snrBack: JSON.stringify([]),
      timestamp: 1_000,
    };
    const { segments } = analyzeTraceroutes(
      makeParams({
        traceroutes: [tr],
        selectedNodeNum: MID,
        selectedSourceId: 's1',
      }),
    );
    // Incident to MID: req->MID (inbound, RX@MID, 4dB) and MID->resp (outbound, TX from MID).
    const inbound = segments.find((s) => s.direction === 'inbound');
    const outbound = segments.find((s) => s.direction === 'outbound');
    expect(inbound!.from).toBe(REQ);
    expect(inbound!.to).toBe(MID);
    expect(inbound!.avgSnr).toBe(4);
    expect(outbound!.from).toBe(MID);
    expect(outbound!.to).toBe(RESP);
    expect(outbound!.avgSnr).toBe(2); // snrTowards[1] belongs to the receiver (resp)
    // No segment should be incident to a non-MID-touching pair.
    expect(segments.every((s) => s.from === MID || s.to === MID)).toBe(true);
  });

  it('filters by direction mode', () => {
    const params = makeParams({
      traceroutes: [directTrace(1, [20], [12])],
      selectedNodeNum: REQ,
      selectedSourceId: 's1',
    });
    const outboundOnly = analyzeTraceroutes({
      ...params,
      options: { ...defaultOptions, directionMode: 'outbound' },
    });
    expect(outboundOnly.segments).toHaveLength(1);
    expect(outboundOnly.segments[0].direction).toBe('outbound');

    const inboundOnly = analyzeTraceroutes({
      ...params,
      options: { ...defaultOptions, directionMode: 'inbound' },
    });
    expect(inboundOnly.segments).toHaveLength(1);
    expect(inboundOnly.segments[0].direction).toBe('inbound');
  });

  it('drops links seen fewer than minOccurrences times', () => {
    // Two traceroutes both exercise the same outbound hop requester->responder.
    const params = makeParams({
      traceroutes: [directTrace(1, [20], [12]), directTrace(2, [24], [16])],
      selectedNodeNum: REQ,
      selectedSourceId: 's1',
      options: { ...defaultOptions, minOccurrences: 2 },
    });
    const { segments } = analyzeTraceroutes(params);
    // Both outbound (req->resp) and inbound (resp->req) occur twice => survive.
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s.occurrences === 2)).toBe(true);

    // Raise threshold beyond observed -> nothing survives.
    const none = analyzeTraceroutes({
      ...params,
      options: { ...defaultOptions, minOccurrences: 3 },
    });
    expect(none.segments).toHaveLength(0);
  });

  it('drops links below the SNR threshold', () => {
    // Outbound 5 dB, inbound 3 dB. minSnr=4 keeps only outbound.
    const { segments } = analyzeTraceroutes(
      makeParams({
        traceroutes: [directTrace(1, [20], [12])],
        selectedNodeNum: REQ,
        selectedSourceId: 's1',
        options: { ...defaultOptions, minSnr: 4 },
      }),
    );
    expect(segments).toHaveLength(1);
    expect(segments[0].direction).toBe('outbound');
    expect(segments[0].avgSnr).toBe(5);
  });

  it('treats the firmware unknown-SNR sentinel (-128 raw) as MQTT/unknown', () => {
    const { segments } = analyzeTraceroutes(
      makeParams({
        traceroutes: [directTrace(1, [-128], [-128])],
        selectedNodeNum: REQ,
        selectedSourceId: 's1',
      }),
    );
    expect(segments.length).toBeGreaterThan(0);
    for (const s of segments) {
      expect(s.avgSnr).toBeNull();
      expect(s.isMqtt).toBe(true);
    }
    // minSnr filtering removes unknown-SNR links.
    const filtered = analyzeTraceroutes(
      makeParams({
        traceroutes: [directTrace(1, [-128], [-128])],
        selectedNodeNum: REQ,
        selectedSourceId: 's1',
        options: { ...defaultOptions, minSnr: -20 },
      }),
    );
    expect(filtered.segments).toHaveLength(0);
  });

  it('hides segments whose endpoints are not in the visible set', () => {
    const { segments } = analyzeTraceroutes(
      makeParams({
        traceroutes: [directTrace(1, [20], [12])],
        selectedNodeNum: REQ,
        selectedSourceId: 's1',
        visibleNodeNums: new Set([REQ]), // responder hidden
      }),
    );
    expect(segments).toHaveLength(0);
  });

  it('respects the time window', () => {
    const { segments } = analyzeTraceroutes(
      makeParams({
        traceroutes: [directTrace(1, [20], [12], 5_000)],
        selectedNodeNum: REQ,
        selectedSourceId: 's1',
        timeWindow: { startMs: 0, endMs: 1_000 },
      }),
    );
    expect(segments).toHaveLength(0);
  });

  it('ignores the selection (global view) when focus is off', () => {
    const { segments, summary } = analyzeTraceroutes(
      makeParams({
        traceroutes: [directTrace(1, [20], [12])],
        selectedNodeNum: REQ,
        selectedSourceId: 's1',
        options: { ...defaultOptions, scopeToSelectedNode: false },
      }),
    );
    expect(summary).toBeNull();
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((s) => s.direction === 'neutral')).toBe(true);
  });

  it('returns neutral segments and no summary when nothing is selected', () => {
    const { segments, summary } = analyzeTraceroutes(
      makeParams({
        traceroutes: [directTrace(1, [20], [12])],
        selectedNodeNum: null,
      }),
    );
    expect(summary).toBeNull();
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((s) => s.direction === 'neutral')).toBe(true);
  });

  it('skips segments with missing positions', () => {
    const { segments } = analyzeTraceroutes(
      makeParams({
        traceroutes: [directTrace(1, [20], [12])],
        selectedNodeNum: REQ,
        selectedSourceId: 's1',
        positionByKey: positions(REQ), // responder has no position
      }),
    );
    expect(segments).toHaveLength(0);
  });
});
