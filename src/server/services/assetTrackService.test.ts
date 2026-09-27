/**
 * assetTrackService (#5354 Phase 2): paging carry-over and the 60 s cache.
 * The repository read is faked with an in-memory cursor over a row list, so
 * the page size can be tiny and every page boundary falls inside a fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PositionTelemetryPageRow } from '../../db/repositories/telemetry.js';

const rows: PositionTelemetryPageRow[] = [];
const getPage = vi.fn(async (opts: {
  nodeNum: number; sourceIds: string[]; sinceMs: number; afterTs?: number; afterId?: number; limit: number;
}) => {
  return rows
    .filter((r) => opts.sourceIds.includes(r.sourceId ?? '') && r.timestamp >= opts.sinceMs)
    .filter((r) => opts.afterTs === undefined
      || r.timestamp > opts.afterTs
      || (r.timestamp === opts.afterTs && opts.afterId !== undefined && r.id > opts.afterId))
    .sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)
    .slice(0, opts.limit);
});

vi.mock('../../services/database.js', () => ({
  default: { telemetry: { getPositionRowsForNodeNumPage: (o: never) => getPage(o) } },
}));

const {
  buildAssetTrack,
  getAssetTrackCached,
  clearAssetTrackCache,
  assetTrackCacheKey,
  assetTrackCacheSize,
  ASSET_TRACK_CACHE_MAX,
  ASSET_TRACK_CACHE_TTL_MS,
} = await import('./assetTrackService.js');

const T0 = 1_760_000_000_000;
let nextId = 1;

function addFix(ts: number, lat: number, lon: number, sourceId = 'a', withAlt = true): void {
  rows.push({ id: nextId++, sourceId, telemetryType: 'latitude', timestamp: ts, value: lat, rxSnr: 6, hopStart: 3, hopLimit: 3 });
  rows.push({ id: nextId++, sourceId, telemetryType: 'longitude', timestamp: ts, value: lon, rxSnr: 6, hopStart: 3, hopLimit: 3 });
  if (withAlt) rows.push({ id: nextId++, sourceId, telemetryType: 'altitude', timestamp: ts, value: 100, rxSnr: null, hopStart: null, hopLimit: null });
}

describe('buildAssetTrack', () => {
  beforeEach(() => {
    rows.length = 0;
    nextId = 1;
    getPage.mockClear();
    clearAssetTrackCache();
  });

  it('assembles every fix whole when pages end inside a timestamp', async () => {
    for (let i = 0; i < 10; i++) addFix(T0 + i * 60_000, 40 + i * 0.001, -75);
    const track = await buildAssetTrack({
      nodeNum: 1, sourceIds: ['a'], windowStartMs: T0 - 1, windowEndMs: T0 + 10 * 60_000, pageRows: 4,
    });
    expect(getPage.mock.calls.length).toBeGreaterThan(5);
    expect(track.totalFixes).toBe(10);
    const pts = track.segments.flat();
    expect(pts).toHaveLength(10);
    for (const p of pts) {
      expect(p.altitude).toBe(100);
      expect(p.snr).toBe(6);
    }
  });

  it('reads nothing for no sources', async () => {
    addFix(T0, 40, -75);
    const track = await buildAssetTrack({ nodeNum: 1, sourceIds: [], windowStartMs: 0, windowEndMs: T0 });
    expect(track).toEqual({ totalFixes: 0, segments: [] });
    expect(getPage).not.toHaveBeenCalled();
  });

  it('dedupes across sources on the paged path', async () => {
    addFix(T0, 40, -75, 'a');
    addFix(T0 + 300, 40, -75, 'b');
    addFix(T0 + 60_000, 40.001, -75, 'b');
    const track = await buildAssetTrack({
      nodeNum: 1, sourceIds: ['a', 'b'], windowStartMs: 0, windowEndMs: T0 + 120_000, pageRows: 2,
    });
    expect(track.totalFixes).toBe(2);
  });
});

describe('getAssetTrackCached', () => {
  beforeEach(() => clearAssetTrackCache());

  it('sorts sources in the key', () => {
    expect(assetTrackCacheKey(5, 24, ['b', 'a'])).toBe(assetTrackCacheKey(5, 24, ['a', 'b']));
    expect(assetTrackCacheKey(5, 24, ['a'])).not.toBe(assetTrackCacheKey(5, 12, ['a']));
  });

  it('shares a build within the TTL and rebuilds after it', async () => {
    const build = vi.fn(async () => ({ totalFixes: 1, segments: [] }));
    await getAssetTrackCached('k', build, 1000);
    await getAssetTrackCached('k', build, 1000 + ASSET_TRACK_CACHE_TTL_MS - 1);
    expect(build).toHaveBeenCalledTimes(1);
    await getAssetTrackCached('k', build, 1000 + ASSET_TRACK_CACHE_TTL_MS + 1);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight build between concurrent callers', async () => {
    let resolve!: (v: { totalFixes: number; segments: never[] }) => void;
    const build = vi.fn(() => new Promise<{ totalFixes: number; segments: never[] }>((r) => { resolve = r; }));
    const a = getAssetTrackCached('k', build, 0);
    const b = getAssetTrackCached('k', build, 0);
    resolve({ totalFixes: 2, segments: [] });
    expect((await a).totalFixes).toBe(2);
    expect((await b).totalFixes).toBe(2);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure', async () => {
    const bad = vi.fn(async () => { throw new Error('db down'); });
    await expect(getAssetTrackCached('k', bad, 0)).rejects.toThrow('db down');
    await Promise.resolve();
    const good = vi.fn(async () => ({ totalFixes: 3, segments: [] }));
    expect((await getAssetTrackCached('k', good, 1)).totalFixes).toBe(3);
  });

  it('evicts the least recently used entry past the cap', async () => {
    const build = async () => ({ totalFixes: 0, segments: [] });
    for (let i = 0; i < ASSET_TRACK_CACHE_MAX + 5; i++) await getAssetTrackCached(`k${i}`, build, 0);
    expect(assetTrackCacheSize()).toBe(ASSET_TRACK_CACHE_MAX);
  });

  it('clears one node\'s entries only', async () => {
    const build = async () => ({ totalFixes: 0, segments: [] });
    await getAssetTrackCached(assetTrackCacheKey(1, 24, ['a']), build, 0);
    await getAssetTrackCached(assetTrackCacheKey(1, 48, ['a']), build, 0);
    await getAssetTrackCached(assetTrackCacheKey(11, 24, ['a']), build, 0);
    clearAssetTrackCache(1);
    expect(assetTrackCacheSize()).toBe(1);
  });
});
