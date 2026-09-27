/**
 * Streaming track thinning for tracked assets (#5354, Phase 2).
 *
 * An asset can keep a year of fixes, far more than a map can draw. The server
 * feeds its fixes, oldest first, into a `TrackThinner`, which returns at most
 * `TRACK_POINT_BUDGET` points split into gap segments:
 *
 *  - **Dedupe.** An asset heard by several sources arrives once per source. A
 *    fix within `TRACK_DEDUPE_MS` of an already-kept fix at the same lat/lon
 *    (5 decimals, about 1 m) is the same fix and is dropped.
 *  - **Gaps.** Two consecutive kept fixes more than `TRACK_GAP_MS` apart start
 *    a new segment, so a map draws no straight line across town.
 *  - **Buckets.** The span from the first fix to the window end is split into
 *    `TRACK_BUCKET_COUNT` equal time buckets. A bucket that spans a gap is cut
 *    in two, so each "unit" belongs to one segment. Each unit keeps its first
 *    fix, its last fix, and the fix farthest from the first-to-last chord, so
 *    turns and out-and-back trips survive.
 *  - **Budget.** Segment endpoints are always kept first. If units plus
 *    endpoints still exceed the budget, the farthest points and then the unit
 *    ends of the densest units are dropped. Only if the endpoints alone are
 *    over budget (a very sparse node, where every fix is its own segment) are
 *    they sampled evenly.
 *
 * Memory: only the current unit's fixes are buffered (one bucket's worth, at
 * most 1/667 of the window) plus up to three kept points per unit. Pure: no
 * IO, no clock.
 */

/** A position fix. Extra fields (SNR, hops) ride along untouched. */
export interface TrackFix {
  timestamp: number;
  latitude: number;
  longitude: number;
}

/** Most points the thinned track may hold (decision D1). */
export const TRACK_POINT_BUDGET = 2000;
/** Consecutive fixes further apart than this start a new segment (decision D3). */
export const TRACK_GAP_MS = 30 * 60 * 1000;
/** Same-position fixes this close in time are one fix heard twice. */
export const TRACK_DEDUPE_MS = 5000;
/** Equal time buckets across the window; each keeps up to three points. */
export const TRACK_BUCKET_COUNT = Math.ceil(TRACK_POINT_BUDGET / 3);

export interface TrackThinnerOptions {
  /** End of the window (normally "now"). Buckets span first fix → this. */
  windowEndMs: number;
  budget?: number;
  gapMs?: number;
  dedupeMs?: number;
  bucketCount?: number;
}

export interface ThinnedTrack<T extends TrackFix> {
  /** Distinct fixes seen, after cross-source dedupe and before thinning. */
  totalFixes: number;
  /** Gap segments, oldest first; each holds its points oldest first. */
  segments: T[][];
}

/** Priority for the budget pass: lower survives longer. */
const PRIORITY_SEGMENT_END = 0;
const PRIORITY_UNIT_END = 1;
const PRIORITY_FARTHEST = 2;

interface Kept<T> {
  fix: T;
  segment: number;
  priority: number;
  /** Raw fixes in the unit this point came from ("density"). */
  unitSize: number;
  /** Arrival order, to restore time order after the budget pass. */
  order: number;
}

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQUATOR = 111_320;

/**
 * Distance in metres from `p` to the segment `a`–`b`, on a local
 * equirectangular projection (accurate to well under 1% at bucket scale).
 * A zero-length chord (the asset came back to where it started) measures the
 * distance from `a`, so the far end of an out-and-back trip is kept.
 */
export function distanceFromChordMeters(p: TrackFix, a: TrackFix, b: TrackFix): number {
  const cosLat = Math.cos((a.latitude * Math.PI) / 180);
  const kx = M_PER_DEG_LON_EQUATOR * cosLat;
  const px = (p.longitude - a.longitude) * kx;
  const py = (p.latitude - a.latitude) * M_PER_DEG_LAT;
  const bx = (b.longitude - a.longitude) * kx;
  const by = (b.latitude - a.latitude) * M_PER_DEG_LAT;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}

function positionKey(fix: TrackFix): string {
  return `${fix.latitude.toFixed(5)},${fix.longitude.toFixed(5)}`;
}

/** Evenly pick `n` items from `items`, keeping the first and last. */
function pickEvenly<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items.slice();
  if (n <= 0) return [];
  if (n === 1) return [items[items.length - 1]];
  const last = items.length - 1;
  const step = last / (n - 1);
  const out: T[] = [];
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const idx = Math.round(i * step);
    if (idx === prev) continue;
    out.push(items[idx]);
    prev = idx;
  }
  return out;
}

/**
 * Streaming thinner. Call `push()` with fixes in non-decreasing timestamp
 * order, then `finish()` once.
 */
export class TrackThinner<T extends TrackFix> {
  private readonly budget: number;
  private readonly gapMs: number;
  private readonly dedupeMs: number;
  private readonly bucketCount: number;
  private readonly windowEndMs: number;

  private totalFixes = 0;
  private bucketStartMs: number | null = null;
  private bucketWidthMs = 1;

  /** Recently kept fixes, for the cross-source dedupe window. */
  private recent: Array<{ timestamp: number; key: string }> = [];
  private lastTimestamp: number | null = null;

  private segment = -1;
  private unit: T[] = [];
  private unitBucket = -1;
  private unitIsSegmentStart = false;

  private kept: Kept<T>[] = [];
  private order = 0;
  private finished = false;

  constructor(opts: TrackThinnerOptions) {
    this.windowEndMs = opts.windowEndMs;
    this.budget = Math.max(2, Math.floor(opts.budget ?? TRACK_POINT_BUDGET));
    this.gapMs = opts.gapMs ?? TRACK_GAP_MS;
    this.dedupeMs = opts.dedupeMs ?? TRACK_DEDUPE_MS;
    this.bucketCount = Math.max(1, Math.floor(opts.bucketCount ?? Math.ceil(this.budget / 3)));
  }

  push(fix: T): void {
    if (this.finished) throw new Error('TrackThinner.push after finish');
    if (!Number.isFinite(fix.timestamp) || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) return;

    // Cross-source dedupe against kept fixes inside the window.
    const key = positionKey(fix);
    const floor = fix.timestamp - this.dedupeMs;
    while (this.recent.length > 0 && this.recent[0].timestamp < floor) this.recent.shift();
    if (this.recent.some((r) => r.key === key && Math.abs(fix.timestamp - r.timestamp) <= this.dedupeMs)) return;
    this.recent.push({ timestamp: fix.timestamp, key });

    this.totalFixes++;

    if (this.bucketStartMs === null) {
      // Buckets span the data actually present (first fix → window end), so a
      // node with only a few days of data still gets the full point budget.
      this.bucketStartMs = fix.timestamp;
      this.bucketWidthMs = Math.max(1, (this.windowEndMs - fix.timestamp) / this.bucketCount);
    }
    const bucket = Math.min(
      this.bucketCount - 1,
      Math.max(0, Math.floor((fix.timestamp - this.bucketStartMs) / this.bucketWidthMs)),
    );

    const isGap = this.lastTimestamp === null || fix.timestamp - this.lastTimestamp > this.gapMs;
    this.lastTimestamp = fix.timestamp;

    if (isGap) {
      this.closeUnit(true);
      this.segment++;
      this.unitIsSegmentStart = true;
      this.unitBucket = bucket;
    } else if (bucket !== this.unitBucket) {
      this.closeUnit(false);
      this.unitIsSegmentStart = false;
      this.unitBucket = bucket;
    }
    this.unit.push(fix);
  }

  finish(): ThinnedTrack<T> {
    if (!this.finished) {
      this.closeUnit(true);
      this.finished = true;
    }
    const survivors = this.applyBudget();
    const segments: T[][] = [];
    let current = -1;
    for (const k of survivors) {
      if (k.segment !== current) {
        segments.push([]);
        current = k.segment;
      }
      segments[segments.length - 1].push(k.fix);
    }
    return { totalFixes: this.totalFixes, segments };
  }

  /** Reduce the current unit to its first / farthest / last fixes. */
  private closeUnit(isSegmentEnd: boolean): void {
    const fixes = this.unit;
    if (fixes.length === 0) return;
    this.unit = [];
    const size = fixes.length;
    const first = fixes[0];
    const last = fixes[size - 1];

    // A one-fix unit's only fix is also its last, so it can end a segment too.
    const firstIsEndpoint = this.unitIsSegmentStart || (size === 1 && isSegmentEnd);
    this.keep(first, firstIsEndpoint ? PRIORITY_SEGMENT_END : PRIORITY_UNIT_END, size);
    if (size >= 3) {
      let best = -1;
      let bestIdx = -1;
      for (let i = 1; i < size - 1; i++) {
        const d = distanceFromChordMeters(fixes[i], first, last);
        if (d > best) {
          best = d;
          bestIdx = i;
        }
      }
      // A straight or stationary stretch has nothing worth a third point.
      if (bestIdx > 0 && best > 0) this.keep(fixes[bestIdx], PRIORITY_FARTHEST, size);
    }
    if (size >= 2) this.keep(last, isSegmentEnd ? PRIORITY_SEGMENT_END : PRIORITY_UNIT_END, size);
  }

  private keep(fix: T, priority: number, unitSize: number): void {
    this.kept.push({ fix, segment: this.segment, priority, unitSize, order: this.order++ });
  }

  private applyBudget(): Kept<T>[] {
    const kept = this.kept;
    if (kept.length <= this.budget) return kept;

    // Drop farthest points first, then unit ends; densest units go first.
    const droppable = kept
      .filter((k) => k.priority !== PRIORITY_SEGMENT_END)
      .sort((a, b) => b.priority - a.priority || b.unitSize - a.unitSize || a.order - b.order);
    const excess = kept.length - this.budget;
    if (droppable.length >= excess) {
      const dropped = new Set(droppable.slice(0, excess));
      return kept.filter((k) => !dropped.has(k));
    }

    // Segment endpoints alone exceed the budget: sample them evenly.
    const endpoints = kept.filter((k) => k.priority === PRIORITY_SEGMENT_END);
    return pickEvenly(endpoints, this.budget);
  }
}

/** Convenience wrapper for an in-memory, time-ordered fix list. */
export function thinTrack<T extends TrackFix>(fixes: Iterable<T>, opts: TrackThinnerOptions): ThinnedTrack<T> {
  const thinner = new TrackThinner<T>(opts);
  for (const f of fixes) thinner.push(f);
  return thinner.finish();
}
