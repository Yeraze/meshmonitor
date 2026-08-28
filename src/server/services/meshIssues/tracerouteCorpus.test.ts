import { describe, it, expect } from 'vitest';
import { buildTracerouteCorpus } from './tracerouteCorpus.js';
import type { TracerouteRow } from '../../../db/repositories/analysis.js';
import { BROADCAST_ADDR } from '../../../utils/tracerouteSegments.js';

let nextId = 1;

function makeRow(overrides: Partial<TracerouteRow> = {}): TracerouteRow {
  return {
    id: nextId++,
    fromNodeNum: 100,
    toNodeNum: 200,
    sourceId: 'src-a',
    route: '[]',
    routeBack: null,
    snrTowards: null,
    snrBack: null,
    timestamp: 1_000_000,
    createdAt: 1_000_000,
    packetId: 1,
    ...overrides,
  };
}

const DEFAULT_OPTS = { pairBucketHours: 6 };

describe('buildTracerouteCorpus — validity filter', () => {
  it('drops a row with no route data', () => {
    const { samples, stats } = buildTracerouteCorpus([makeRow({ route: null })], DEFAULT_OPTS);
    expect(samples).toHaveLength(0);
    expect(stats.validCount).toBe(0);
  });

  it('drops a row where the route is the string "null"', () => {
    const { stats } = buildTracerouteCorpus([makeRow({ route: 'null' })], DEFAULT_OPTS);
    expect(stats.validCount).toBe(0);
  });

  it('drops a row whose fromNodeNum is BROADCAST_ADDR', () => {
    const { stats } = buildTracerouteCorpus([makeRow({ fromNodeNum: BROADCAST_ADDR })], DEFAULT_OPTS);
    expect(stats.validCount).toBe(0);
  });

  it('drops a row whose toNodeNum is BROADCAST_ADDR', () => {
    const { stats } = buildTracerouteCorpus([makeRow({ toNodeNum: BROADCAST_ADDR })], DEFAULT_OPTS);
    expect(stats.validCount).toBe(0);
  });

  it('drops a row with an invalid (reserved) endpoint node number', () => {
    const { stats } = buildTracerouteCorpus([makeRow({ fromNodeNum: 1 })], DEFAULT_OPTS);
    expect(stats.validCount).toBe(0);
  });

  it('drops a self-trace (fromNodeNum === toNodeNum)', () => {
    const { stats } = buildTracerouteCorpus([makeRow({ fromNodeNum: 100, toNodeNum: 100 })], DEFAULT_OPTS);
    expect(stats.validCount).toBe(0);
  });

  it('drops a row with an invalid hop inside route', () => {
    const { stats } = buildTracerouteCorpus([makeRow({ route: JSON.stringify([1, 300]) })], DEFAULT_OPTS);
    expect(stats.validCount).toBe(0);
  });

  it('drops a row with an invalid hop inside routeBack', () => {
    const { stats } = buildTracerouteCorpus(
      [makeRow({ route: '[]', routeBack: JSON.stringify([65535]) })],
      DEFAULT_OPTS
    );
    expect(stats.validCount).toBe(0);
  });

  it('keeps a valid row and reflects it in rawCount/validCount', () => {
    const { samples, stats } = buildTracerouteCorpus([makeRow()], DEFAULT_OPTS);
    expect(samples).toHaveLength(1);
    expect(stats.rawCount).toBe(1);
    expect(stats.validCount).toBe(1);
  });
});

describe('buildTracerouteCorpus — stage 2 dedup by (packetId, fromNodeNum)', () => {
  it('prefers the row with a non-empty routeBack', () => {
    const withoutBack = makeRow({ packetId: 42, routeBack: null, timestamp: 1000 });
    const withBack = makeRow({ packetId: 42, routeBack: JSON.stringify([150]), timestamp: 1000 });
    const { samples } = buildTracerouteCorpus([withoutBack, withBack], DEFAULT_OPTS);
    expect(samples).toHaveLength(1);
    expect(samples[0].id).toBe(withBack.id);
  });

  it('breaks a routeBack tie on more non-empty SNR arrays', () => {
    const oneSnr = makeRow({
      packetId: 42,
      routeBack: JSON.stringify([150]),
      snrTowards: JSON.stringify([10]),
      snrBack: null,
      timestamp: 1000,
    });
    const twoSnr = makeRow({
      packetId: 42,
      routeBack: JSON.stringify([150]),
      snrTowards: JSON.stringify([10]),
      snrBack: JSON.stringify([12]),
      timestamp: 1000,
    });
    const { samples } = buildTracerouteCorpus([oneSnr, twoSnr], DEFAULT_OPTS);
    expect(samples).toHaveLength(1);
    expect(samples[0].id).toBe(twoSnr.id);
  });

  it('breaks an SNR-count tie on longer route', () => {
    const shortRoute = makeRow({ packetId: 42, route: JSON.stringify([50]), timestamp: 1000 });
    const longRoute = makeRow({ packetId: 42, route: JSON.stringify([50, 60]), timestamp: 1000 });
    const { samples } = buildTracerouteCorpus([shortRoute, longRoute], DEFAULT_OPTS);
    expect(samples).toHaveLength(1);
    expect(samples[0].id).toBe(longRoute.id);
  });

  it('breaks a route-length tie on newest timestamp', () => {
    const older = makeRow({ packetId: 42, timestamp: 1000 });
    const newer = makeRow({ packetId: 42, timestamp: 2000 });
    const { samples } = buildTracerouteCorpus([older, newer], DEFAULT_OPTS);
    expect(samples).toHaveLength(1);
    expect(samples[0].id).toBe(newer.id);
  });

  it('breaks a full tie on highest id', () => {
    const first = makeRow({ packetId: 42, timestamp: 1000 });
    const second = makeRow({ packetId: 42, timestamp: 1000 });
    expect(second.id).toBeGreaterThan(first.id);
    const { samples } = buildTracerouteCorpus([first, second], DEFAULT_OPTS);
    expect(samples).toHaveLength(1);
    expect(samples[0].id).toBe(second.id);
  });

  it('never merges rows with a null packetId, even with identical fromNodeNum', () => {
    const a = makeRow({ packetId: null, timestamp: 1000 });
    const b = makeRow({ packetId: null, timestamp: 1000 });
    const { samples, stats } = buildTracerouteCorpus([a, b], DEFAULT_OPTS);
    // Both survive stage 2; stage 3 may still cap them into 1 bucket cell —
    // use distinct pairs to isolate stage 2 behavior via dedupedCount.
    expect(stats.dedupedCount).toBe(2);
    expect(samples.length).toBeLessThanOrEqual(2);
  });
});

describe('buildTracerouteCorpus — stage 3 stratified cap', () => {
  const HOUR_MS = 3_600_000;

  it('caps 3 traceroutes for one pair inside one 6h bucket to 1 sample', () => {
    const rows = [
      makeRow({ packetId: 1, fromNodeNum: 100, toNodeNum: 200, timestamp: 0 }),
      makeRow({ packetId: 2, fromNodeNum: 100, toNodeNum: 200, timestamp: HOUR_MS }),
      makeRow({ packetId: 3, fromNodeNum: 100, toNodeNum: 200, timestamp: 2 * HOUR_MS }),
    ];
    const { samples, stats } = buildTracerouteCorpus(rows, { pairBucketHours: 6 });
    expect(samples).toHaveLength(1);
    expect(stats.sampledCount).toBe(1);
    expect(stats.distinctPairCount).toBe(1);
  });

  it('keeps 2 samples when the same pair spans two 6h buckets', () => {
    const rows = [
      makeRow({ packetId: 1, fromNodeNum: 100, toNodeNum: 200, timestamp: 0 }),
      makeRow({ packetId: 2, fromNodeNum: 100, toNodeNum: 200, timestamp: 6 * HOUR_MS }),
    ];
    const { samples } = buildTracerouteCorpus(rows, { pairBucketHours: 6 });
    expect(samples).toHaveLength(2);
  });

  it('shares a pairKey for reversed endpoints, capping them together', () => {
    const rows = [
      makeRow({ packetId: 1, fromNodeNum: 100, toNodeNum: 200, timestamp: 0 }),
      makeRow({ packetId: 2, fromNodeNum: 200, toNodeNum: 100, timestamp: HOUR_MS }),
    ];
    const { samples } = buildTracerouteCorpus(rows, { pairBucketHours: 6 });
    expect(samples).toHaveLength(1);
    expect(samples[0].pairKey).toBe('100-200');
  });

  it('sorts output by (timestamp desc, id desc)', () => {
    const rows = [
      makeRow({ packetId: 1, fromNodeNum: 100, toNodeNum: 200, timestamp: 0 }),
      makeRow({ packetId: 2, fromNodeNum: 300, toNodeNum: 400, timestamp: 5000 }),
      makeRow({ packetId: 3, fromNodeNum: 500, toNodeNum: 600, timestamp: 2000 }),
    ];
    const { samples } = buildTracerouteCorpus(rows, { pairBucketHours: 6 });
    expect(samples.map((s) => s.timestamp)).toEqual([5000, 2000, 0]);
  });
});

describe('buildTracerouteCorpus — stats arithmetic and truncated passthrough', () => {
  it('computes rawCount/validCount/dedupedCount/sampledCount/distinctPairCount on a mixed fixture', () => {
    const HOUR_MS = 3_600_000;
    const rows = [
      // Dropped by the validity filter.
      makeRow({ route: null }),
      // Two rows that dedup to 1 (same packetId+from).
      makeRow({ packetId: 10, fromNodeNum: 100, toNodeNum: 200, timestamp: 0 }),
      makeRow({ packetId: 10, fromNodeNum: 100, toNodeNum: 200, timestamp: 0 }),
      // A distinct pair, own bucket.
      makeRow({ packetId: 20, fromNodeNum: 300, toNodeNum: 400, timestamp: 0 }),
      // Same pair as the row above but a different bucket -> 2nd sample for that pair.
      makeRow({ packetId: 21, fromNodeNum: 300, toNodeNum: 400, timestamp: 6 * HOUR_MS }),
    ];
    const { stats } = buildTracerouteCorpus(rows, { pairBucketHours: 6 });
    expect(stats.rawCount).toBe(5);
    expect(stats.validCount).toBe(4);
    expect(stats.dedupedCount).toBe(3);
    expect(stats.sampledCount).toBe(3);
    expect(stats.distinctPairCount).toBe(2);
  });

  it('passes truncated through to stats, defaulting to false', () => {
    const { stats: withDefault } = buildTracerouteCorpus([makeRow()], DEFAULT_OPTS);
    expect(withDefault.truncated).toBe(false);

    const { stats: withTrue } = buildTracerouteCorpus([makeRow()], { ...DEFAULT_OPTS, truncated: true });
    expect(withTrue.truncated).toBe(true);
  });
});
