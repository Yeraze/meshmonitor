/**
 * Tests for the shared Coverage Report receiver position cache (#5277 P2,
 * §2.2 / §3, Decision D11). Covers TTL hit/miss, the override-aware
 * position rule, the failure-TTL / stale-value-survives-a-failure carry-over
 * fix (b), the LRU bound, single-flight loading, and key isolation across
 * sources.
 *
 * Also covers the optional `loader` constructor override (#5277 P3, §2.3),
 * which lets a MeshCore Observer source resolve a 64-hex public-key
 * receiver instead of a Meshtastic `nodeNum`. A custom loader shares every
 * other piece of machinery (TTL, failure TTL, LRU, single-flight) with the
 * default one unchanged — see `coverageMeshCore.ts` for the real MeshCore
 * loader that plugs in here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getNodeMock } = vi.hoisted(() => ({
  getNodeMock: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    nodes: {
      getNode: getNodeMock,
    },
  },
}));

import {
  CoverageReceiverPositionCache,
  nodeCoveragePosition,
} from './coverageReceiverPositionCache.js';

const SOURCE_A = 'src-a';
const SOURCE_B = 'src-b';
const NODE_NUM = 0x11111111;

describe('nodeCoveragePosition', () => {
  it('returns null lat/lon for a null node', () => {
    expect(nodeCoveragePosition(null)).toEqual({ lat: null, lon: null });
  });

  it('returns the live position when no override is set', () => {
    expect(
      nodeCoveragePosition({
        latitude: 39.9,
        longitude: -75.1,
        positionOverrideEnabled: false,
        latitudeOverride: null,
        longitudeOverride: null,
      } as any),
    ).toEqual({ lat: 39.9, lon: -75.1 });
  });

  it('prefers the override when fully populated and enabled', () => {
    expect(
      nodeCoveragePosition({
        latitude: 39.9,
        longitude: -75.1,
        positionOverrideEnabled: true,
        latitudeOverride: 40.0,
        longitudeOverride: -76.0,
      } as any),
    ).toEqual({ lat: 40.0, lon: -76.0 });
  });

  it('ignores a partial override (missing longitude)', () => {
    expect(
      nodeCoveragePosition({
        latitude: 39.9,
        longitude: -75.1,
        positionOverrideEnabled: true,
        latitudeOverride: 40.0,
        longitudeOverride: null,
      } as any),
    ).toEqual({ lat: 39.9, lon: -75.1 });
  });
});

describe('CoverageReceiverPositionCache', () => {
  beforeEach(() => {
    getNodeMock.mockReset();
    getNodeMock.mockResolvedValue({
      latitude: 39.9,
      longitude: -75.1,
      positionOverrideEnabled: false,
      latitudeOverride: null,
      longitudeOverride: null,
    });
  });

  describe('TTL hit/miss', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('serves a cache hit within the TTL without a second lookup', async () => {
      const cache = new CoverageReceiverPositionCache({ ttlMs: 60_000 });
      await cache.get(SOURCE_A, NODE_NUM);
      await cache.get(SOURCE_A, NODE_NUM);
      expect(getNodeMock).toHaveBeenCalledTimes(1);
    });

    it('reloads once the TTL has expired', async () => {
      const cache = new CoverageReceiverPositionCache({ ttlMs: 60_000 });
      await cache.get(SOURCE_A, NODE_NUM);
      vi.setSystemTime(new Date('2024-01-01T00:01:01.000Z')); // +61s
      await cache.get(SOURCE_A, NODE_NUM);
      expect(getNodeMock).toHaveBeenCalledTimes(2);
    });
  });

  it('a failed lookup with no prior value returns null coordinates and is not retried inside failureTtlMs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    try {
      getNodeMock.mockRejectedValue(new Error('db unavailable'));
      const cache = new CoverageReceiverPositionCache({ failureTtlMs: 60_000 });

      const first = await cache.get(SOURCE_A, NODE_NUM);
      expect(first).toEqual({ lat: null, lon: null });
      expect(getNodeMock).toHaveBeenCalledTimes(1);

      // Within failureTtlMs: cached failure, no retry.
      vi.setSystemTime(new Date('2024-01-01T00:00:30.000Z'));
      const second = await cache.get(SOURCE_A, NODE_NUM);
      expect(second).toEqual({ lat: null, lon: null });
      expect(getNodeMock).toHaveBeenCalledTimes(1);

      // Past failureTtlMs: retried.
      vi.setSystemTime(new Date('2024-01-01T00:01:01.000Z'));
      await cache.get(SOURCE_A, NODE_NUM);
      expect(getNodeMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a good older value survives a failure (keeps serving it, does not blank to null)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    try {
      const cache = new CoverageReceiverPositionCache({ ttlMs: 60_000, failureTtlMs: 60_000 });

      const good = await cache.get(SOURCE_A, NODE_NUM);
      expect(good).toEqual({ lat: 39.9, lon: -75.1 });

      vi.setSystemTime(new Date('2024-01-01T00:01:01.000Z')); // +61s, TTL expired
      getNodeMock.mockRejectedValueOnce(new Error('db unavailable'));
      const afterFailure = await cache.get(SOURCE_A, NODE_NUM);

      expect(afterFailure).toEqual({ lat: 39.9, lon: -75.1 });
      expect(getNodeMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds memory via the LRU cap', async () => {
    const cache = new CoverageReceiverPositionCache({ maxEntries: 2 });
    await cache.get(SOURCE_A, 1);
    await cache.get(SOURCE_A, 2);
    await cache.get(SOURCE_A, 3); // evicts node 1

    getNodeMock.mockClear();
    await cache.get(SOURCE_A, 1); // must reload — evicted
    expect(getNodeMock).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent gets for the same key into one loader call', async () => {
    let resolveLoad: (v: unknown) => void = () => {};
    getNodeMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveLoad = resolve; }),
    );
    const cache = new CoverageReceiverPositionCache();

    const gets = [
      cache.get(SOURCE_A, NODE_NUM),
      cache.get(SOURCE_A, NODE_NUM),
      cache.get(SOURCE_A, NODE_NUM),
      cache.get(SOURCE_A, NODE_NUM),
      cache.get(SOURCE_A, NODE_NUM),
    ];
    resolveLoad({ latitude: 1, longitude: 2, positionOverrideEnabled: false, latitudeOverride: null, longitudeOverride: null });
    const results = await Promise.all(gets);

    expect(getNodeMock).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r).toEqual({ lat: 1, lon: 2 });
    }
  });

  it('isolates cache keys across sources with the same nodeNum', async () => {
    getNodeMock.mockImplementation(async (_nodeNum: number, sourceId?: string) => {
      if (sourceId === SOURCE_A) {
        return { latitude: 1, longitude: 1, positionOverrideEnabled: false, latitudeOverride: null, longitudeOverride: null };
      }
      return { latitude: 2, longitude: 2, positionOverrideEnabled: false, latitudeOverride: null, longitudeOverride: null };
    });
    const cache = new CoverageReceiverPositionCache();

    const a = await cache.get(SOURCE_A, NODE_NUM);
    const b = await cache.get(SOURCE_B, NODE_NUM);

    expect(a).toEqual({ lat: 1, lon: 1 });
    expect(b).toEqual({ lat: 2, lon: 2 });
    expect(getNodeMock).toHaveBeenCalledTimes(2);
  });
});

describe('custom loader (#5277 P3, §2.3)', () => {
  const PUBLIC_KEY = 'ab'.repeat(32);

  beforeEach(() => {
    getNodeMock.mockReset();
  });

  it('uses the injected loader instead of the Meshtastic default, keyed by a string', async () => {
    const customLoader = vi.fn().mockResolvedValue({ lat: 10, lon: 20 });
    const cache = new CoverageReceiverPositionCache({ loader: customLoader });

    const pos = await cache.get(SOURCE_A, PUBLIC_KEY);

    expect(pos).toEqual({ lat: 10, lon: 20 });
    expect(customLoader).toHaveBeenCalledWith(SOURCE_A, PUBLIC_KEY);
    expect(getNodeMock).not.toHaveBeenCalled();
  });

  it('stringifies a numeric key the same way as its string form (same cache entry)', async () => {
    const customLoader = vi.fn().mockResolvedValue({ lat: 5, lon: 6 });
    const cache = new CoverageReceiverPositionCache({ loader: customLoader });

    await cache.get(SOURCE_A, '123');
    await cache.get(SOURCE_A, 123);

    expect(customLoader).toHaveBeenCalledTimes(1);
  });

  it('shares TTL, failure-TTL, LRU and single-flight machinery with a custom loader', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    try {
      const customLoader = vi.fn().mockResolvedValue({ lat: 1, lon: 2 });
      const cache = new CoverageReceiverPositionCache({ loader: customLoader, ttlMs: 60_000 });

      await cache.get(SOURCE_A, PUBLIC_KEY);
      await cache.get(SOURCE_A, PUBLIC_KEY); // within TTL, no reload
      expect(customLoader).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2024-01-01T00:01:01.000Z')); // +61s
      await cache.get(SOURCE_A, PUBLIC_KEY);
      expect(customLoader).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failing custom loader resolves to null coordinates rather than throwing', async () => {
    const customLoader = vi.fn().mockRejectedValue(new Error('meshcore lookup failed'));
    const cache = new CoverageReceiverPositionCache({ loader: customLoader });

    await expect(cache.get(SOURCE_A, PUBLIC_KEY)).resolves.toEqual({ lat: null, lon: null });
  });

  it('the default loader is unaffected when no custom loader is supplied', async () => {
    getNodeMock.mockResolvedValue({
      latitude: 39.9,
      longitude: -75.1,
      positionOverrideEnabled: false,
      latitudeOverride: null,
      longitudeOverride: null,
    });
    const cache = new CoverageReceiverPositionCache();

    const pos = await cache.get(SOURCE_A, NODE_NUM);

    expect(pos).toEqual({ lat: 39.9, lon: -75.1 });
    expect(getNodeMock).toHaveBeenCalledWith(NODE_NUM, SOURCE_A);
  });
});
