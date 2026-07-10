import { useMemo } from 'react';
// #2931 — shared unknown-hop sentinel (raw firmware INT8_MIN -128 / 4 = -32).
// Previously duplicated here as a private copy; now imported from the single
// canonical home in mapHelpers so the definition lives once (#4047 P3 WP1).
import { isUnknownSnr } from '../utils/mapHelpers';

/**
 * Traceroute analysis for the Map Analysis view (issue #3399).
 *
 * Turns raw traceroute rows into deduplicated, directed link segments with
 * occurrence counts and SNR statistics, then classifies each segment as
 * inbound (received at the selected node) or outbound (transmitted from the
 * selected node) so the operator can evaluate RX sensitivity vs TX power.
 *
 * SNR semantics (authoritative, from meshtasticManager storage):
 *   - fromNodeNum = responder (remote), toNodeNum = requester (local).
 *   - `route`/`snrTowards` describe the request leg. The physical node order is
 *     [requester, ...route, responder] and snrTowards[i] is the SNR measured at
 *     the *receiver* of hop i (fullPath[i+1]).
 *   - `routeBack`/`snrBack` describe the response leg, node order
 *     [responder, ...routeBack, requester], snrBack[i] measured at fullPath[i+1].
 *   - SNR values are raw firmware ints (actual dB x 4). The unknown-hop sentinel
 *     is raw -128 => -32 after /4 (see UNKNOWN_SNR_SENTINEL / isUnknownSnr).
 *
 * Because every hop's SNR belongs to its receiver, for a selected node N a
 * directed segment A->B means: B==N => inbound to N (N's RX), A==N => outbound
 * from N (the neighbour's reception of N's TX).
 */

export type SegmentDirection = 'inbound' | 'outbound' | 'neutral';

export interface TracerouteAnalysisInput {
  id: number | string;
  fromNodeNum: number;
  toNodeNum: number;
  sourceId: string;
  route?: string | null;
  routeBack?: string | null;
  snrTowards?: string | null;
  snrBack?: string | null;
  timestamp?: number;
}

export interface TracerouteAnalysisOptions {
  directionMode: 'both' | 'inbound' | 'outbound';
  scopeToSelectedNode: boolean;
  minOccurrences: number;
  minSnr: number | null;
}

export interface AnalyzeParams {
  traceroutes: TracerouteAnalysisInput[];
  /** `${sourceId}:${nodeNum}` -> [lat, lng] */
  positionByKey: Map<string, [number, number]>;
  selectedNodeNum: number | null;
  selectedSourceId: string | null;
  options: TracerouteAnalysisOptions;
  /** When set (search active), segments touching a node outside this set are dropped. */
  visibleNodeNums?: Set<number> | null;
  timeWindow?: { startMs?: number; endMs?: number } | null;
}

export interface AnalyzedSegment {
  key: string;
  sourceId: string;
  /** transmitter nodeNum */
  from: number;
  /** receiver nodeNum */
  to: number;
  fromPos: [number, number];
  toPos: [number, number];
  direction: SegmentDirection;
  /** the endpoint that is not the selected node (== `from` for neutral) */
  neighborNum: number;
  /** mean RF SNR in dB across observations, null if every sample was unknown */
  avgSnr: number | null;
  /** number of traceroutes that contained this directed hop */
  occurrences: number;
  /** true if any observation reported an unknown-SNR (sentinel) sample */
  isMqtt: boolean;
}

export interface TracerouteSummary {
  /** distinct neighbours (unordered) linked to the selected node */
  distinctLinks: number;
  /** total directed-hop observations incident to the selected node */
  totalObservations: number;
  /** mean SNR (dB) across surviving segments, null if none have RF SNR */
  avgSnr: number | null;
  /** distinct outbound directed links (N -> neighbour) */
  outboundLinks: number;
  /** distinct inbound directed links (neighbour -> N) */
  inboundLinks: number;
}

export interface AnalyzeResult {
  segments: AnalyzedSegment[];
  summary: TracerouteSummary | null;
}

function parseNumArray(json: string | null | undefined): number[] {
  if (!json || json === 'null' || json === '') return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map((n) => Number(n)) : [];
  } catch {
    return [];
  }
}

/** Raw firmware SNR (dB x 4) -> scaled dB. Returns the -32 sentinel for unknown. */
function scaleSnr(raw: number | undefined): number | undefined {
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  return raw / 4;
}

interface RawSegment {
  sourceId: string;
  from: number;
  to: number;
  snr: number | undefined; // scaled dB (may be the unknown sentinel)
}

/** Decompose one traceroute into directed hops carrying receiver-measured SNR. */
function segmentsForTraceroute(tr: TracerouteAnalysisInput): RawSegment[] {
  const out: RawSegment[] = [];
  const requester = Number(tr.toNodeNum);
  const responder = Number(tr.fromNodeNum);

  const route = parseNumArray(tr.route);
  const routeBack = parseNumArray(tr.routeBack);
  const snrTowards = parseNumArray(tr.snrTowards);
  const snrBack = parseNumArray(tr.snrBack);

  // Request leg: requester -> ...route -> responder
  const forwardPath = [requester, ...route, responder];
  for (let i = 0; i < forwardPath.length - 1; i++) {
    out.push({
      sourceId: tr.sourceId,
      from: forwardPath[i],
      to: forwardPath[i + 1],
      snr: scaleSnr(snrTowards[i]),
    });
  }

  // Response leg: responder -> ...routeBack -> requester.
  // When routeBack AND snrBack are both empty the return path has not been
  // recorded yet (e.g. MeshMonitor sees its own outgoing response before relay
  // nodes populate routeBack). Skip rather than drawing a fictitious direct
  // responder→requester line. (Issues #1140, #3622)
  if (routeBack.length > 0 || snrBack.length > 0) {
    const backPath = [responder, ...routeBack, requester];
    for (let i = 0; i < backPath.length - 1; i++) {
      out.push({
        sourceId: tr.sourceId,
        from: backPath[i],
        to: backPath[i + 1],
        snr: scaleSnr(snrBack[i]),
      });
    }
  }

  return out;
}

const INVALID_NODE_NUMS = new Set([0, 1, 2, 3, 255, 65535, 4294967295]);

function aggregateKey(s: RawSegment): string {
  return `${s.sourceId}:${s.from}->${s.to}`;
}

interface Accum {
  sourceId: string;
  from: number;
  to: number;
  occurrences: number;
  snrSum: number;
  snrCount: number;
  hasUnknown: boolean;
}

/**
 * Pure analysis core. Kept free of React so it can be unit-tested directly.
 */
export function analyzeTraceroutes(params: AnalyzeParams): AnalyzeResult {
  const {
    traceroutes,
    positionByKey,
    selectedNodeNum,
    selectedSourceId,
    options,
    visibleNodeNums,
    timeWindow,
  } = params;

  // "focus" = a node is selected AND the focus toggle is on. Only then do we
  // scope to / classify relative to that node; otherwise links render globally.
  const hasNode = selectedNodeNum !== null && selectedNodeNum !== undefined;
  const focus = hasNode && options.scopeToSelectedNode;

  const inWindow = (t: number | undefined): boolean => {
    if (!timeWindow) return true;
    const { startMs, endMs } = timeWindow;
    if (startMs === undefined || endMs === undefined) return true;
    const ts = t ?? 0;
    return ts >= startMs && ts <= endMs;
  };

  // 1. Filter rows by time window, source scope and node scope.
  const rows = traceroutes.filter((tr) => {
    if (!inWindow(tr.timestamp)) return false;
    if (focus) {
      if (selectedSourceId && tr.sourceId !== selectedSourceId) return false;
      const route = parseNumArray(tr.route);
      const routeBack = parseNumArray(tr.routeBack);
      const all = [
        Number(tr.fromNodeNum),
        Number(tr.toNodeNum),
        ...route,
        ...routeBack,
      ];
      if (!all.includes(selectedNodeNum as number)) return false;
    }
    return true;
  });

  // 2. Aggregate directed hops.
  const acc = new Map<string, Accum>();
  for (const tr of rows) {
    for (const seg of segmentsForTraceroute(tr)) {
      if (INVALID_NODE_NUMS.has(seg.from) || INVALID_NODE_NUMS.has(seg.to)) continue;
      if (seg.from === seg.to) continue;

      // Node-centric: only keep hops incident to the selected node.
      if (focus && seg.from !== selectedNodeNum && seg.to !== selectedNodeNum) {
        continue;
      }
      // Search filter: both endpoints must be visible.
      if (visibleNodeNums) {
        if (!visibleNodeNums.has(seg.from) || !visibleNodeNums.has(seg.to)) continue;
      }

      const key = aggregateKey(seg);
      let a = acc.get(key);
      if (!a) {
        a = {
          sourceId: seg.sourceId,
          from: seg.from,
          to: seg.to,
          occurrences: 0,
          snrSum: 0,
          snrCount: 0,
          hasUnknown: false,
        };
        acc.set(key, a);
      }
      a.occurrences += 1;
      if (seg.snr === undefined || isUnknownSnr(seg.snr)) {
        a.hasUnknown = true;
      } else {
        a.snrSum += seg.snr;
        a.snrCount += 1;
      }
    }
  }

  // 3. Build segments, apply weak-link + direction filters.
  const segments: AnalyzedSegment[] = [];
  for (const a of acc.values()) {
    const avgSnr = a.snrCount > 0 ? a.snrSum / a.snrCount : null;

    // Weak-link filters.
    if (a.occurrences < options.minOccurrences) continue;
    if (options.minSnr !== null) {
      if (avgSnr === null || avgSnr < options.minSnr) continue;
    }

    let direction: SegmentDirection = 'neutral';
    let neighborNum = a.from;
    if (focus) {
      if (a.to === selectedNodeNum) {
        direction = 'inbound';
        neighborNum = a.from;
      } else {
        direction = 'outbound';
        neighborNum = a.to;
      }
      if (options.directionMode !== 'both' && options.directionMode !== direction) {
        continue;
      }
    }

    const fromPos = positionByKey.get(`${a.sourceId}:${a.from}`);
    const toPos = positionByKey.get(`${a.sourceId}:${a.to}`);
    if (!fromPos || !toPos) continue;

    segments.push({
      key: `${a.sourceId}:${a.from}->${a.to}`,
      sourceId: a.sourceId,
      from: a.from,
      to: a.to,
      fromPos,
      toPos,
      direction,
      neighborNum,
      avgSnr,
      occurrences: a.occurrences,
      isMqtt: a.hasUnknown && a.snrCount === 0,
    });
  }

  // 4. Summary (only meaningful when focused on a selected node).
  let summary: TracerouteSummary | null = null;
  if (focus) {
    const neighbors = new Set<number>();
    const outbound = new Set<number>();
    const inbound = new Set<number>();
    let totalObservations = 0;
    let snrSum = 0;
    let snrCount = 0;
    for (const s of segments) {
      neighbors.add(s.neighborNum);
      totalObservations += s.occurrences;
      if (s.direction === 'outbound') outbound.add(s.neighborNum);
      if (s.direction === 'inbound') inbound.add(s.neighborNum);
      if (s.avgSnr !== null) {
        snrSum += s.avgSnr;
        snrCount += 1;
      }
    }
    summary = {
      distinctLinks: neighbors.size,
      totalObservations,
      avgSnr: snrCount > 0 ? snrSum / snrCount : null,
      outboundLinks: outbound.size,
      inboundLinks: inbound.size,
    };
  }

  return { segments, summary };
}

/** React wrapper: memoises analyzeTraceroutes over its inputs. */
export function useTracerouteAnalysis(params: AnalyzeParams): AnalyzeResult {
  const {
    traceroutes,
    positionByKey,
    selectedNodeNum,
    selectedSourceId,
    options,
    visibleNodeNums,
    timeWindow,
  } = params;
  return useMemo(
    () =>
      analyzeTraceroutes({
        traceroutes,
        positionByKey,
        selectedNodeNum,
        selectedSourceId,
        options,
        visibleNodeNums,
        timeWindow,
      }),
    [
      traceroutes,
      positionByKey,
      selectedNodeNum,
      selectedSourceId,
      options,
      visibleNodeNums,
      timeWindow,
    ],
  );
}
