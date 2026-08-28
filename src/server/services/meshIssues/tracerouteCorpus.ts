/**
 * Traceroute corpus sampler for Mesh Issues Analysis (#4964, Phase 1 WP2).
 *
 * Implements the epic's locked three-stage pipeline: a validity filter, an
 * exact cross-source dedup by `(packetId, fromNodeNum)`, then a stratified
 * cap of one sample per `(unordered pair, time bucket)` so high-frequency
 * pairs don't dominate the statistics. No recency decay — the cap already
 * flattens frequency bias (epic, locked).
 *
 * Pure — no I/O, no `databaseService` import. All route/SNR parsing goes
 * through `src/utils/tracerouteSegments.ts`; this module never `JSON.parse`s
 * a route/SNR column itself.
 *
 * Phase 1 has no rule consuming `samples` directly — the service computes the
 * corpus so `stats` can be surfaced on the status endpoint (a live consumer
 * proving the pipeline end-to-end), and Phase 2's Tier B graph builder can
 * drop straight in on top of `samples`.
 */
import type { TracerouteRow } from '../../../db/repositories/analysis.js'; // type-only
import {
  parseHopArray,
  hasRouteData,
  isValidRouteNode,
} from '../../../utils/tracerouteSegments.js';

export interface TracerouteSample extends TracerouteRow {
  routeHops: number[];
  routeBackHops: number[];
  snrTowardsValues: number[];
  snrBackValues: number[];
  /** `${min(from,to)}-${max(from,to)}` */
  pairKey: string;
  /** floor(timestamp / bucketMs) */
  bucket: number;
}

export interface TracerouteCorpusStats {
  rawCount: number;
  validCount: number;
  dedupedCount: number;
  sampledCount: number;
  distinctPairCount: number;
  /** True when the caller stopped paginating at the page cap. */
  truncated: boolean;
}

export interface BuildTracerouteCorpusOptions {
  /** Hours per stratification bucket. Clamped 1..24 by the caller (the
   *  scheduler), not by this function — pass it through as given. */
  pairBucketHours: number;
  /** Passed through into stats, unchanged. */
  truncated?: boolean;
}

/**
 * Stage 1 — validity filter. `isValidRouteNode` already excludes
 * `BROADCAST_ADDR` (it is one of the reserved values the predicate rejects),
 * so a single call covers both the "valid route node" and "not broadcast"
 * clauses for every endpoint and hop.
 */
function isValidTracerouteRow(row: TracerouteRow): boolean {
  if (!hasRouteData(row.route)) return false;
  if (!isValidRouteNode(row.fromNodeNum)) return false;
  if (!isValidRouteNode(row.toNodeNum)) return false;
  if (row.fromNodeNum === row.toNodeNum) return false; // no self-traces

  for (const hop of parseHopArray(row.route)) {
    if (!isValidRouteNode(hop)) return false;
  }
  for (const hop of parseHopArray(row.routeBack)) {
    if (!isValidRouteNode(hop)) return false;
  }
  return true;
}

function pairKeyFor(fromNodeNum: number, toNodeNum: number): string {
  return fromNodeNum <= toNodeNum ? `${fromNodeNum}-${toNodeNum}` : `${toNodeNum}-${fromNodeNum}`;
}

function buildSample(row: TracerouteRow, bucketMs: number): TracerouteSample {
  return {
    ...row,
    routeHops: parseHopArray(row.route),
    routeBackHops: parseHopArray(row.routeBack),
    snrTowardsValues: parseHopArray(row.snrTowards),
    snrBackValues: parseHopArray(row.snrBack),
    pairKey: pairKeyFor(row.fromNodeNum, row.toNodeNum),
    bucket: Math.floor(row.timestamp / bucketMs),
  };
}

function nonEmptySnrArrayCount(sample: TracerouteSample): number {
  return (sample.snrTowardsValues.length > 0 ? 1 : 0) + (sample.snrBackValues.length > 0 ? 1 : 0);
}

/**
 * "Most complete" comparator, shared by stage 2 (exact dedup) and stage 3
 * (stratified cap) — module-private per the spec. Positive => `a` wins;
 * negative => `b` wins. Ranking, in order:
 *   1. `routeBack` present and non-empty;
 *   2. more non-empty SNR arrays (0-2);
 *   3. longer `routeHops`;
 *   4. newest `timestamp`;
 *   5. highest `id` (deterministic final tiebreak).
 */
function compareCompleteness(a: TracerouteSample, b: TracerouteSample): number {
  const aHasBack = a.routeBackHops.length > 0 ? 1 : 0;
  const bHasBack = b.routeBackHops.length > 0 ? 1 : 0;
  if (aHasBack !== bHasBack) return aHasBack - bHasBack;

  const snrDiff = nonEmptySnrArrayCount(a) - nonEmptySnrArrayCount(b);
  if (snrDiff !== 0) return snrDiff;

  const lenDiff = a.routeHops.length - b.routeHops.length;
  if (lenDiff !== 0) return lenDiff;

  const tsDiff = a.timestamp - b.timestamp;
  if (tsDiff !== 0) return tsDiff;

  return a.id - b.id;
}

function pickWinner(a: TracerouteSample, b: TracerouteSample): TracerouteSample {
  return compareCompleteness(a, b) >= 0 ? a : b;
}

export function buildTracerouteCorpus(
  rows: TracerouteRow[],
  opts: BuildTracerouteCorpusOptions,
): { samples: TracerouteSample[]; stats: TracerouteCorpusStats } {
  const rawCount = rows.length;
  const bucketMs = opts.pairBucketHours * 3600_000;

  const validRows = rows.filter(isValidTracerouteRow);
  const validCount = validRows.length;
  const candidates = validRows.map((row) => buildSample(row, bucketMs));

  // Stage 2 — exact dedup by (packetId, fromNodeNum). A null packetId cannot
  // be correlated across sources, so each such row gets its own group key
  // (never merged, never dropped).
  const dedupGroups = new Map<string, TracerouteSample>();
  for (const sample of candidates) {
    const key = sample.packetId == null ? `row:${sample.id}` : `${sample.packetId}:${sample.fromNodeNum}`;
    const existing = dedupGroups.get(key);
    dedupGroups.set(key, existing ? pickWinner(existing, sample) : sample);
  }
  const deduped = Array.from(dedupGroups.values());
  const dedupedCount = deduped.length;

  // Stage 3 — stratified cap: 1 winner per (unordered pair, time bucket).
  const cellWinners = new Map<string, TracerouteSample>();
  for (const sample of deduped) {
    const key = `${sample.pairKey}|${sample.bucket}`;
    const existing = cellWinners.get(key);
    cellWinners.set(key, existing ? pickWinner(existing, sample) : sample);
  }

  const samples = Array.from(cellWinners.values()).sort((a, b) => {
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    return b.id - a.id;
  });

  const distinctPairCount = new Set(samples.map((s) => s.pairKey)).size;

  return {
    samples,
    stats: {
      rawCount,
      validCount,
      dedupedCount,
      sampledCount: samples.length,
      distinctPairCount,
      truncated: opts.truncated ?? false,
    },
  };
}
