/**
 * Traceroute Explorer (#5511) — pure data model.
 *
 * Turns the `/api/traceroutes/explorer` wire rows into display runs, then
 * filters, groups and aggregates them. Everything the table, map and detail
 * drawer show is derived here, so it stays testable without a DOM.
 */
import {
  buildLegHopLinks,
  type TracerouteRenderSegment,
  hasReturnPath,
  hasRouteData,
  parseHopArray,
} from '../../../utils/tracerouteSegments';
import { classifyNodeTransport, type NodeTransportClass } from '../../../utils/nodeTransport';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export type ExplorerProtocol = 'meshtastic' | 'meshcore';

/** One path hop of a MeshCore run: `mc:<pk>` when resolved, else `mch:<hash>`. */
export interface ExplorerHopMeta {
  key: string;
  hash: string | null;
  /** Contacts that matched the hash: 1 = resolved, 0 = unknown, >1 = ambiguous. */
  candidates: number;
}

export interface ExplorerRunWire {
  /** Absent on rows from an older server: read as Meshtastic. */
  protocol?: ExplorerProtocol;
  id: number;
  sourceId: string;
  timestamp: number;
  fromNodeNum: number;
  toNodeNum: number;
  route: string | null;
  routeBack: string | null;
  snrTowards: string | null;
  snrBack: string | null;
  channel: number | null;
  packetId: number | null;
  transportMechanism: number | null;
  // MeshCore runs only (#6276). Identity keys are `mc:<pk>` / `mch:<hash>` /
  // `src:<sourceId>`; the numeric fields above are synthetic and display-only.
  fromKey?: string;
  toKey?: string;
  /** Full outbound leg, endpoints included (stops at the turnaround). */
  routeKeys?: string[] | null;
  /** Full return leg `[turnaround .. from]`; null when not recorded. */
  routeBackKeys?: string[] | null;
  turnaroundKey?: string;
  /** False when the known target does not appear on the wire (a Companion). */
  reachedTarget?: boolean;
  hopMeta?: ExplorerHopMeta[];
  traceTag?: number;
  hashBytes?: number;
  status?: 'answered' | 'timeout' | 'failed';
}

export interface ExplorerNodeWire {
  nodeNum: number;
  /** `mt:<n>` / `mc:<pk>`; absent on rows from an older server. */
  nodeKey?: string;
  protocol?: ExplorerProtocol;
  publicKey?: string;
  meshcoreType?: number | null;
  nodeId: string;
  shortName: string | null;
  longName: string | null;
  role: number | null;
  hwModel: number | null;
  latitude: number | null;
  longitude: number | null;
}

export interface ExplorerResponse {
  sources: Array<{ id: string; name: string }>;
  runs: ExplorerRunWire[];
  nodes: ExplorerNodeWire[];
  truncated: boolean;
  scanLimit: number;
  retentionPerPair: number;
  /** Days of MeshCore trace history kept (absent without MeshCore data). */
  meshcoreRetentionDays?: number;
}

// ---------------------------------------------------------------------------
// Identity keys
// ---------------------------------------------------------------------------
//
// Runs and nodes are keyed by the unified node key (`mt:<nodeNum>` /
// `mc:<publicKey>`), never by the synthetic MeshCore nodeNum, so a MeshCore
// node and a Meshtastic node can never collide. Unresolved MeshCore hops are
// `mch:<hash>`; an unknown local radio is `src:<sourceId>`.

export const mtKey = (nodeNum: number): string => `mt:${nodeNum}`;

export function nodeKeyOf(n: ExplorerNodeWire): string {
  return n.nodeKey ?? mtKey(n.nodeNum);
}

const hex8 = (nodeNum: number): string => `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;

/** True for a key that names a real node (not an unresolved hash or unknown radio). */
export const isNodeKey = (key: string): boolean => key.startsWith('mt:') || key.startsWith('mc:');

// ---------------------------------------------------------------------------
// Display model
// ---------------------------------------------------------------------------

export interface ExplorerRun {
  /** Stable row key: the first wire row's id. */
  key: string;
  wire: ExplorerRunWire;
  protocol: ExplorerProtocol;
  timestamp: number;
  /** Synthetic for MeshCore; display only (strip, copy links). */
  fromNodeNum: number;
  toNodeNum: number;
  fromKey: string;
  toKey: string;
  /** Every source that stored this traceroute (same packet seen twice). */
  sourceIds: string[];
  pairKey: string;
  /** The destination answered with a forward route. */
  answered: boolean;
  /** Full forward node-key sequence, endpoints included; null when unanswered. */
  forward: string[] | null;
  /** Arrival SNR (dB) at each forward node after the first; null = unknown. */
  forwardSnr: Array<number | null>;
  /** Full return sequence (destination → origin); null when absent. */
  back: string[] | null;
  backSnr: Array<number | null>;
  /** Relay count on the forward path; null when unanswered. */
  hops: number | null;
  transport: NodeTransportClass;
  /** Forward path differs from the pair's previous answered run. */
  routeChanged: boolean;
  /** Return path is not the forward path reversed. */
  asymmetric: boolean;
  /** MeshCore: the known target forwarded the trace (false = turned earlier). */
  reachedTarget: boolean;
  /** MeshCore: the hop where the trace turned around. */
  turnaroundKey: string | null;
}

function legSequence(
  leg: 'forward' | 'return',
  start: number,
  hops: number[],
  end: number,
  snrRaw: number[],
): { nodes: string[]; snr: Array<number | null> } {
  const links = buildLegHopLinks(leg, start, hops, end, snrRaw);
  if (links.length === 0) return { nodes: [mtKey(start), mtKey(end)], snr: [null] };
  return {
    nodes: [mtKey(links[0].fromNodeNum), ...links.map(l => mtKey(l.toNodeNum))],
    snr: links.map(l => l.snrDb),
  };
}

export function pathKey(nodes: string[] | null): string {
  return nodes ? nodes.join('>') : '';
}

/** MeshCore SNR arrays are dB*4; -128 is "no SNR". */
const meshcoreSnr = (q: number): number | null => (q === -128 ? null : q / 4);

/** The first `count` / last `count` entries of a MeshCore dB*4 array as dB. */
function meshcoreSnrSlice(json: string | null, count: number, from: 'start' | 'end'): Array<number | null> {
  const all = parseHopArray(json).map(meshcoreSnr);
  if (count <= 0) return [];
  const part = from === 'start' ? all.slice(0, count) : all.slice(Math.max(0, all.length - count));
  while (part.length < count) part.push(null);
  return part;
}

/**
 * Build display runs from wire rows. Meshtastic rows that share a packet id
 * and endpoints are one traceroute stored by several sources; they collapse
 * into one run that lists every source. A MeshCore run is one trace on one
 * source and never merges. Output is newest first.
 */
export function buildRuns(wire: ExplorerRunWire[]): ExplorerRun[] {
  const merged = new Map<string, ExplorerRun>();
  const indexOf = new Map<string, number>();
  const order: ExplorerRun[] = [];

  for (const w of wire) {
    const protocol: ExplorerProtocol = w.protocol ?? 'meshtastic';
    const isMc = protocol === 'meshcore';
    const dedupeKey = isMc
      ? `mc:${w.sourceId}:${w.traceTag ?? ''}:${w.id}`
      : w.packetId != null
        ? `p:${w.packetId}:${w.fromNodeNum}:${w.toNodeNum}`
        : `r:${w.sourceId}:${w.id}`;
    const existing = merged.get(dedupeKey);
    const answered = isMc
      ? (w.status ? w.status === 'answered' : true) && (w.routeKeys?.length ?? 0) >= 2
      : hasRouteData(w.route);

    if (existing) {
      if (!existing.sourceIds.includes(w.sourceId)) existing.sourceIds.push(w.sourceId);
      // Prefer the copy that carries a route.
      if (existing.answered || !answered) continue;
    }

    let forward: string[] | null = null;
    let forwardSnr: Array<number | null> = [];
    let back: string[] | null = null;
    let backSnr: Array<number | null> = [];
    if (isMc) {
      if (answered && w.routeKeys) {
        forward = w.routeKeys;
        forwardSnr = meshcoreSnrSlice(w.snrTowards, forward.length - 1, 'start');
      }
      if (answered && w.routeBackKeys && w.routeBackKeys.length >= 2) {
        back = w.routeBackKeys;
        // A turnaround before the target leaves a leading "no SNR" pad: align to the end.
        backSnr = meshcoreSnrSlice(w.snrBack, back.length - 1, 'end');
      }
    } else {
      if (answered) {
        const seq = legSequence('forward', w.fromNodeNum, parseHopArray(w.route), w.toNodeNum, parseHopArray(w.snrTowards));
        forward = seq.nodes;
        forwardSnr = seq.snr;
      }
      const routeBack = parseHopArray(w.routeBack);
      if (hasReturnPath(routeBack, w.snrBack)) {
        const seq = legSequence('return', w.toNodeNum, routeBack, w.fromNodeNum, parseHopArray(w.snrBack));
        back = seq.nodes;
        backSnr = seq.snr;
      }
    }

    const fromKey = isMc ? (w.fromKey ?? mtKey(w.fromNodeNum)) : mtKey(w.fromNodeNum);
    const toKey = isMc ? (w.toKey ?? mtKey(w.toNodeNum)) : mtKey(w.toNodeNum);
    const run: ExplorerRun = {
      key: existing?.key ?? `${w.sourceId}:${w.id}`,
      wire: w,
      protocol,
      timestamp: w.timestamp,
      fromNodeNum: w.fromNodeNum,
      toNodeNum: w.toNodeNum,
      fromKey,
      toKey,
      sourceIds: existing?.sourceIds ?? [w.sourceId],
      pairKey: `${fromKey}>${toKey}`,
      answered,
      forward,
      forwardSnr,
      back,
      backSnr,
      hops: forward ? forward.length - 2 : null,
      transport: isMc ? 'rf' : classifyNodeTransport({ transportMechanism: w.transportMechanism }),
      routeChanged: false,
      asymmetric: !!forward && !!back && pathKey([...back].reverse()) !== pathKey(forward),
      reachedTarget: isMc ? w.reachedTarget !== false : true,
      turnaroundKey: isMc ? (w.turnaroundKey ?? null) : null,
    };

    if (existing) {
      order[indexOf.get(dedupeKey)!] = run;
    } else {
      indexOf.set(dedupeKey, order.length);
      order.push(run);
    }
    merged.set(dedupeKey, run);
  }

  // Sort after every merge so the route-change walk below sees true time order.
  order.sort((a, b) => b.timestamp - a.timestamp);

  // Route-change flag: walk each pair oldest → newest over answered runs.
  const lastPath = new Map<string, string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const run = order[i];
    if (!run.forward) continue;
    const key = pathKey(run.forward);
    const prev = lastPath.get(run.pairKey);
    run.routeChanged = prev !== undefined && prev !== key;
    lastPath.set(run.pairKey, key);
  }
  return order;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type ResultFilter = 'all' | 'answered' | 'failed';
export type ProtocolFilter = 'all' | ExplorerProtocol;

export interface ExplorerFilters {
  result: ResultFilter;
  transports: NodeTransportClass[];
  protocol: ProtocolFilter;
  /** Node (key) chosen on the map: endpoint or relay on either leg. */
  nodeKey: string | null;
  /** Free-text node search (name, short name, !id, public-key prefix or hash). */
  search: string;
  /** Forward relay count cap; null = any. Unanswered runs always pass. */
  maxHops: number | null;
}

export const DEFAULT_FILTERS: ExplorerFilters = {
  result: 'all',
  transports: ['rf', 'mqtt', 'udp'],
  protocol: 'all',
  nodeKey: null,
  search: '',
  maxHops: null,
};

export function runNodes(run: ExplorerRun): string[] {
  return [run.fromKey, run.toKey, ...(run.forward ?? []), ...(run.back ?? [])];
}

/** `q` is trimmed and lower-cased by the caller. */
export function nodeMatchesSearch(node: ExplorerNodeWire | undefined, key: string, q: string): boolean {
  if (key.startsWith('mt:')) {
    if (hex8(Number(key.slice(3))).includes(q)) return true;
  } else if (key.startsWith('mc:')) {
    if (key.slice(3).includes(q)) return true;
  } else if (key.startsWith('mch:') && key.slice(4).includes(q)) {
    return true;
  }
  if (!node) return false;
  return [node.longName, node.shortName, node.nodeId].some(v => !!v && v.toLowerCase().includes(q));
}

export function filterRuns(
  runs: ExplorerRun[],
  filters: ExplorerFilters,
  nodes: Map<string, ExplorerNodeWire>,
): ExplorerRun[] {
  const q = filters.search.trim().toLowerCase();
  return runs.filter(run => {
    if (filters.protocol !== 'all' && run.protocol !== filters.protocol) return false;
    if (filters.result === 'answered' && !run.answered) return false;
    if (filters.result === 'failed' && run.answered) return false;
    if (!filters.transports.includes(run.transport)) return false;
    if (filters.maxHops != null && run.hops != null && run.hops > filters.maxHops) return false;
    if (filters.nodeKey != null && !runNodes(run).includes(filters.nodeKey)) return false;
    if (q && !runNodes(run).some(k => nodeMatchesSearch(nodes.get(k), k, q))) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface ExplorerSummary {
  total: number;
  pairs: number;
  answeredPct: number | null;
  medianHops: number | null;
  routeChanges: number;
}

export function summarize(runs: ExplorerRun[]): ExplorerSummary {
  const answered = runs.filter(r => r.answered);
  return {
    total: runs.length,
    pairs: new Set(runs.map(r => r.pairKey)).size,
    answeredPct: runs.length ? Math.round((answered.length / runs.length) * 100) : null,
    medianHops: median(answered.map(r => r.hops ?? 0)),
    routeChanges: runs.filter(r => r.routeChanged).length,
  };
}

export interface ExplorerPair {
  key: string;
  protocol: ExplorerProtocol;
  fromKey: string;
  toKey: string;
  /** Newest first. */
  runs: ExplorerRun[];
  answeredCount: number;
  latestAnswered: ExplorerRun | null;
  distinctPaths: number;
  medianHops: number | null;
  sourceIds: string[];
}

/** Group runs by from→to pair, in order of each pair's newest run. */
export function groupByPair(runs: ExplorerRun[]): ExplorerPair[] {
  const map = new Map<string, ExplorerRun[]>();
  for (const run of runs) {
    const list = map.get(run.pairKey);
    if (list) list.push(run);
    else map.set(run.pairKey, [run]);
  }
  return [...map.entries()].map(([key, list]) => {
    const answered = list.filter(r => r.answered);
    return {
      key,
      protocol: list[0].protocol,
      fromKey: list[0].fromKey,
      toKey: list[0].toKey,
      runs: list,
      answeredCount: answered.length,
      latestAnswered: answered[0] ?? null,
      distinctPaths: new Set(answered.map(r => pathKey(r.forward))).size,
      medianHops: median(answered.map(r => r.hops ?? 0)),
      sourceIds: [...new Set(list.flatMap(r => r.sourceIds))],
    };
  });
}

export interface PathVariant {
  path: string[];
  count: number;
}

/** Forward paths a pair has used, most common first. */
export function pathVariants(runs: ExplorerRun[]): PathVariant[] {
  const counts = new Map<string, PathVariant>();
  for (const run of runs) {
    if (!run.forward) continue;
    const key = pathKey(run.forward);
    const v = counts.get(key);
    if (v) v.count++;
    else counts.set(key, { path: run.forward, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

export interface LinkUsage {
  key: string;
  a: string;
  b: string;
  /** Times a traceroute hop crossed this link, either leg, either direction. */
  count: number;
  medianSnr: number | null;
}

/**
 * Undirected link usage across the answered runs' forward and return legs.
 * A link with an unresolved (`mch:`) or unknown (`src:`) end is not counted:
 * it has no identity to aggregate on and no position to draw.
 */
export function aggregateLinks(runs: ExplorerRun[]): LinkUsage[] {
  const map = new Map<string, { a: string; b: string; count: number; snr: number[] }>();
  const add = (x: string, y: string, snr: number | null) => {
    if (x === y || !isNodeKey(x) || !isNodeKey(y)) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = `${a}|${b}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { a, b, count: 0, snr: [] };
      map.set(key, entry);
    }
    entry.count++;
    if (snr != null) entry.snr.push(snr);
  };
  for (const run of runs) {
    for (const [seq, snr] of [
      [run.forward, run.forwardSnr],
      [run.back, run.backSnr],
    ] as const) {
      if (!seq) continue;
      for (let i = 0; i < seq.length - 1; i++) add(seq[i], seq[i + 1], snr[i] ?? null);
    }
  }
  return [...map.entries()].map(([key, e]) => ({ key, a: e.a, b: e.b, count: e.count, medianSnr: median(e.snr) }));
}

/**
 * Render segments for a MeshCore run, from its key legs: one per consecutive
 * pair whose two ends both have a position. Unresolved (`mch:`) hops have no
 * position, so the pair they touch is skipped.
 */
export function runToKeySegments(
  run: ExplorerRun,
  pos: (key: string) => [number, number] | null,
): TracerouteRenderSegment[] {
  const out: TracerouteRenderSegment[] = [];
  for (const [leg, seq, snr] of [
    ['forward', run.forward, run.forwardSnr],
    ['return', run.back, run.backSnr],
  ] as const) {
    if (!seq) continue;
    for (let i = 0; i < seq.length - 1; i++) {
      const from = isNodeKey(seq[i]) ? pos(seq[i]) : null;
      const to = isNodeKey(seq[i + 1]) ? pos(seq[i + 1]) : null;
      if (!from || !to) continue;
      out.push({
        key: `${run.key}:${leg}:${i}`,
        from,
        to,
        fromKey: seq[i],
        toKey: seq[i + 1],
        leg,
        avgSnr: snr[i] ?? null,
        isMqtt: false,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function nodeLabel(nodes: Map<string, ExplorerNodeWire>, key: string): string {
  const n = nodes.get(key);
  const short = n?.shortName?.trim();
  if (short) return short;
  if (key.startsWith('mt:')) return hex8(Number(key.slice(3))).slice(-4).replace(/^/, '!');
  if (key.startsWith('mc:')) return n?.longName?.trim() || key.slice(3, 11);
  if (key.startsWith('mch:')) return `?${key.slice(4)}`;
  return '?';
}

export function nodeLongLabel(nodes: Map<string, ExplorerNodeWire>, key: string): string {
  const n = nodes.get(key);
  const named = n?.longName?.trim() || n?.shortName?.trim();
  if (named) return named;
  if (key.startsWith('mt:')) return n?.nodeId || hex8(Number(key.slice(3)));
  if (key.startsWith('mc:')) return key.slice(3, 11);
  if (key.startsWith('mch:')) return `?${key.slice(4)}`;
  return '?';
}

export type SnrBand = 'good' | 'fair' | 'poor' | 'unknown';

/** Same breakpoints the design uses: ≥ 0 dB good, −7…0 fair, below −7 poor. */
export function snrBand(snr: number | null): SnrBand {
  if (snr == null) return 'unknown';
  if (snr >= 0) return 'good';
  if (snr >= -7) return 'fair';
  return 'poor';
}

export function formatSnr(snr: number | null): string {
  if (snr == null) return '?';
  const v = Math.round(snr * 100) / 100;
  return `${v > 0 ? '+' : ''}${v}`;
}
