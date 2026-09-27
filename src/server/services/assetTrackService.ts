/**
 * Asset track builder (#5354, Asset Tracking Phase 2).
 *
 * Streams a tracked asset's position telemetry, oldest first, one bounded page
 * at a time, pivots each page into fixes, and feeds them to a `TrackThinner`.
 * Memory stays bounded by the page size plus the thinner's buffers; the whole
 * window is never held at once.
 *
 * Results are cached for 60 s (small LRU), keyed by nodeNum, hours and the
 * exact source list read, because the client refetches on every node poll.
 * In-flight builds are shared, so a burst of identical requests reads once.
 *
 * Read-only: no mesh traffic.
 */
import databaseService from '../../services/database.js';
import { pivotPositionHistory, type PivotedPosition } from '../utils/positionHistoryPivot.js';
import { TrackThinner } from '../../utils/trackThinning.js';
import type { PositionTelemetryPageRow } from '../../db/repositories/telemetry.js';

/** Telemetry rows per page (spec: 10,000). */
export const ASSET_TRACK_PAGE_ROWS = 10_000;
export const ASSET_TRACK_CACHE_TTL_MS = 60_000;
export const ASSET_TRACK_CACHE_MAX = 16;

export interface AssetTrack {
  totalFixes: number;
  segments: PivotedPosition[][];
}

export interface BuildAssetTrackOptions {
  nodeNum: number;
  sourceIds: string[];
  windowStartMs: number;
  windowEndMs: number;
  pageRows?: number;
}

/**
 * Read and thin one asset's track. Rows sharing the last timestamp of a full
 * page are held back until the next page, so the pivot never sees half a fix.
 */
export async function buildAssetTrack(opts: BuildAssetTrackOptions): Promise<AssetTrack> {
  const { nodeNum, sourceIds, windowStartMs, windowEndMs } = opts;
  const pageRows = opts.pageRows ?? ASSET_TRACK_PAGE_ROWS;
  const thinner = new TrackThinner<PivotedPosition>({ windowEndMs });
  if (sourceIds.length === 0) return thinner.finish();

  let afterTs: number | undefined;
  let afterId: number | undefined;
  let carry: PositionTelemetryPageRow[] = [];

  for (;;) {
    const page = await databaseService.telemetry.getPositionRowsForNodeNumPage({
      nodeNum, sourceIds, sinceMs: windowStartMs, afterTs, afterId, limit: pageRows,
    });
    const full = page.length === pageRows;
    const rows = carry.length > 0 ? carry.concat(page) : page;

    let ready: PositionTelemetryPageRow[];
    if (full) {
      const lastTs = page[page.length - 1].timestamp;
      const split = rows.findIndex((r) => r.timestamp === lastTs);
      ready = rows.slice(0, split);
      carry = rows.slice(split);
      afterTs = lastTs;
      afterId = page[page.length - 1].id;
    } else {
      ready = rows;
      carry = [];
    }

    for (const fix of pivotPositionHistory(ready)) thinner.push(fix);
    if (!full) break;
  }
  return thinner.finish();
}

interface CacheEntry {
  expiresAt: number;
  value: Promise<AssetTrack>;
}

const cache = new Map<string, CacheEntry>();

export function assetTrackCacheKey(nodeNum: number, hours: number, sourceIds: string[]): string {
  return `${nodeNum}|${hours}|${[...sourceIds].sort().join(',')}`;
}

/**
 * `buildAssetTrack` behind the 60 s LRU cache. `windowStartMs` belongs to
 * the build that filled the entry, so a cached answer can be up to 60 s old.
 */
export async function getAssetTrackCached(
  key: string,
  build: () => Promise<AssetTrack>,
  nowMs: number = Date.now(),
): Promise<AssetTrack> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > nowMs) {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
  }
  if (hit) cache.delete(key);

  const value = build();
  cache.set(key, { expiresAt: nowMs + ASSET_TRACK_CACHE_TTL_MS, value });
  while (cache.size > ASSET_TRACK_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  // A failed build must not be served from cache.
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

/** Drop cached tracks for one node (its flag or retention changed), or all. */
export function clearAssetTrackCache(nodeNum?: number): void {
  if (nodeNum === undefined) {
    cache.clear();
    return;
  }
  const prefix = `${nodeNum}|`;
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

/** Test hook: current number of cache entries. */
export function assetTrackCacheSize(): number {
  return cache.size;
}
