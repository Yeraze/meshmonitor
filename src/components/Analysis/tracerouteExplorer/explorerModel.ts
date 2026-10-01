/**
 * Traceroute Explorer (#5511) — pure data model.
 *
 * Turns the `/api/traceroutes/explorer` wire rows into display runs, then
 * filters, groups and aggregates them. Everything the table, map and detail
 * drawer show is derived here, so it stays testable without a DOM.
 */
import {
  buildLegHopLinks,
  hasReturnPath,
  hasRouteData,
  parseHopArray,
} from '../../../utils/tracerouteSegments';
import { classifyNodeTransport, type NodeTransportClass } from '../../../utils/nodeTransport';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface ExplorerRunWire {
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
}

export interface ExplorerNodeWire {
  nodeNum: number;
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
}

// ---------------------------------------------------------------------------
// Display model
// ---------------------------------------------------------------------------

export interface ExplorerRun {
  /** Stable row key: the first wire row's id. */
  key: string;
  wire: ExplorerRunWire;
  timestamp: number;
  fromNodeNum: number;
  toNodeNum: number;
  /** Every source that stored this traceroute (same packet seen twice). */
  sourceIds: string[];
  pairKey: string;
  /** The destination answered with a forward route. */
  answered: boolean;
  /** Full forward node sequence, endpoints included; null when unanswered. */
  forward: number[] | null;
  /** Arrival SNR (dB) at each forward node after the first; null = unknown. */
  forwardSnr: Array<number | null>;
  /** Full return sequence (destination → origin); null when absent. */
  back: number[] | null;
  backSnr: Array<number | null>;
  /** Relay count on the forward path; null when unanswered. */
  hops: number | null;
  transport: NodeTransportClass;
  /** Forward path differs from the pair's previous answered run. */
  routeChanged: boolean;
  /** Return path is not the forward path reversed. */
  asymmetric: boolean;
}

function legSequence(
  leg: 'forward' | 'return',
  start: number,
  hops: number[],
  end: number,
  snrRaw: number[],
): { nodes: number[]; snr: Array<number | null> } {
  const links = buildLegHopLinks(leg, start, hops, end, snrRaw);
  if (links.length === 0) return { nodes: [start, end], snr: [null] };
  return {
    nodes: [links[0].fromNodeNum, ...links.map(l => l.toNodeNum)],
    snr: links.map(l => l.snrDb),
  };
}

export function pathKey(nodes: number[] | null): string {
  return nodes ? nodes.join('>') : '';
}

/**
 * Build display runs from wire rows. Rows that share a packet id and
 * endpoints are one traceroute stored by several sources; they collapse into
 * one run that lists every source. Output is newest first.
 */
export function buildRuns(wire: ExplorerRunWire[]): ExplorerRun[] {
  const merged = new Map<string, ExplorerRun>();
  const order: ExplorerRun[] = [];

  for (const w of wire) {
    const dedupeKey =
      w.packetId != null ? `p:${w.packetId}:${w.fromNodeNum}:${w.toNodeNum}` : `r:${w.sourceId}:${w.id}`;
    const existing = merged.get(dedupeKey);
    const answered = hasRouteData(w.route);

    if (existing) {
      if (!existing.sourceIds.includes(w.sourceId)) existing.sourceIds.push(w.sourceId);
      // Prefer the copy that carries a route.
      if (existing.answered || !answered) continue;
    }

    let forward: number[] | null = null;
    let forwardSnr: Array<number | null> = [];
    if (answered) {
      const seq = legSequence('forward', w.fromNodeNum, parseHopArray(w.route), w.toNodeNum, parseHopArray(w.snrTowards));
      forward = seq.nodes;
      forwardSnr = seq.snr;
    }

    let back: number[] | null = null;
    let backSnr: Array<number | null> = [];
    const routeBack = parseHopArray(w.routeBack);
    if (hasReturnPath(routeBack, w.snrBack)) {
      const seq = legSequence('return', w.toNodeNum, routeBack, w.fromNodeNum, parseHopArray(w.snrBack));
      back = seq.nodes;
      backSnr = seq.snr;
    }

    const run: ExplorerRun = {
      key: existing?.key ?? `${w.sourceId}:${w.id}`,
      wire: w,
      timestamp: w.timestamp,
      fromNodeNum: w.fromNodeNum,
      toNodeNum: w.toNodeNum,
      sourceIds: existing?.sourceIds ?? [w.sourceId],
      pairKey: `${w.fromNodeNum}>${w.toNodeNum}`,
      answered,
      forward,
      forwardSnr,
      back,
      backSnr,
      hops: forward ? forward.length - 2 : null,
      transport: classifyNodeTransport({ transportMechanism: w.transportMechanism }),
      routeChanged: false,
      asymmetric: !!forward && !!back && pathKey([...back].reverse()) !== pathKey(forward),
    };

    if (existing) {
      order[order.indexOf(existing)] = run;
    } else {
      order.push(run);
    }
    merged.set(dedupeKey, run);
  }

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

export interface ExplorerFilters {
  result: ResultFilter;
  transports: NodeTransportClass[];
  /** Node chosen on the map: endpoint or relay on either leg. */
  nodeNum: number | null;
  /** Free-text node search (name, short name, or !id). */
  search: string;
  /** Forward relay count cap; null = any. Unanswered runs always pass. */
  maxHops: number | null;
}

export const DEFAULT_FILTERS: ExplorerFilters = {
  result: 'all',
  transports: ['rf', 'mqtt', 'udp'],
  nodeNum: null,
  search: '',
  maxHops: null,
};

export function runNodes(run: ExplorerRun): number[] {
  return [run.fromNodeNum, run.toNodeNum, ...(run.forward ?? []), ...(run.back ?? [])];
}

export function nodeMatchesSearch(node: ExplorerNodeWire | undefined, nodeNum: number, q: string): boolean {
  const hex = `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
  if (hex.includes(q)) return true;
  if (!node) return false;
  return [node.longName, node.shortName, node.nodeId].some(v => !!v && v.toLowerCase().includes(q));
}

export function filterRuns(
  runs: ExplorerRun[],
  filters: ExplorerFilters,
  nodes: Map<number, ExplorerNodeWire>,
): ExplorerRun[] {
  const q = filters.search.trim().toLowerCase();
  return runs.filter(run => {
    if (filters.result === 'answered' && !run.answered) return false;
    if (filters.result === 'failed' && run.answered) return false;
    if (!filters.transports.includes(run.transport)) return false;
    if (filters.maxHops != null && run.hops != null && run.hops > filters.maxHops) return false;
    if (filters.nodeNum != null && !runNodes(run).includes(filters.nodeNum)) return false;
    if (q && !runNodes(run).some(n => nodeMatchesSearch(nodes.get(n), n, q))) return false;
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
  fromNodeNum: number;
  toNodeNum: number;
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
      fromNodeNum: list[0].fromNodeNum,
      toNodeNum: list[0].toNodeNum,
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
  path: number[];
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
  a: number;
  b: number;
  /** Times a traceroute hop crossed this link, either leg, either direction. */
  count: number;
  medianSnr: number | null;
}

/** Undirected link usage across the answered runs' forward and return legs. */
export function aggregateLinks(runs: ExplorerRun[]): LinkUsage[] {
  const map = new Map<string, { a: number; b: number; count: number; snr: number[] }>();
  const add = (x: number, y: number, snr: number | null) => {
    if (x === y) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = `${a}-${b}`;
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

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function nodeLabel(nodes: Map<number, ExplorerNodeWire>, nodeNum: number): string {
  const n = nodes.get(nodeNum);
  return n?.shortName?.trim() || `!${(nodeNum >>> 0).toString(16).padStart(8, '0').slice(-4)}`;
}

export function nodeLongLabel(nodes: Map<number, ExplorerNodeWire>, nodeNum: number): string {
  const n = nodes.get(nodeNum);
  return n?.longName?.trim() || n?.shortName?.trim() || n?.nodeId || `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
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
