/**
 * Unit tests for the likely-aircraft classification queue (#5364/#5365
 * Phase 1 WP2, spec §4.2 / §6). Every dependency is injected per
 * `AircraftClassificationDeps` — no real database, no real HTTP.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AircraftClassificationService,
  MAX_BATCH,
  SAMPLE_TIMEOUT_MS,
  PROVIDER_BACKOFF_MS,
  type AircraftClassificationDeps,
} from './aircraftClassificationService.js';
import type { DbNode } from '../../db/types.js';
import type { AircraftReclassifyRow } from '../../db/repositories/nodes.js';

function makeNode(overrides: Partial<DbNode> & { nodeNum: number }): DbNode {
  return {
    nodeId: `!${overrides.nodeNum.toString(16).padStart(8, '0')}`,
    sourceId: 'src-a',
    latitude: 45.0,
    longitude: -75.0,
    altitude: 600,
    likelyAircraft: null,
    aircraftBasis: null,
    groundElevation: null,
    heightAboveGround: null,
    aircraftClassifiedAt: null,
    positionOverrideEnabled: false,
    latitudeOverride: null,
    longitudeOverride: null,
    altitudeOverride: null,
    positionPrecisionBits: null,
    ...overrides,
  } as DbNode;
}

interface TestDeps {
  deps: AircraftClassificationDeps;
  nodes: Map<string, DbNode>;
  sourceSettings: Map<string, string>;
  globalSettings: Map<string, string>;
  sampleFn: ReturnType<typeof vi.fn>;
  writeFn: ReturnType<typeof vi.fn>;
  emitFn: ReturnType<typeof vi.fn>;
  setFixedFn: ReturnType<typeof vi.fn>;
  clock: { now: number };
}

function makeDeps(): TestDeps {
  const nodes = new Map<string, DbNode>();
  const sourceSettings = new Map<string, string>();
  const globalSettings = new Map<string, string>();
  const clock = { now: 1_700_000_000_000 };

  const sampleFn = vi.fn(async (points: Array<{ lat: number; lng: number }>) => points.map(() => 200));
  const writeFn = vi.fn(async (nodeNum: number, sourceId: string, c: Record<string, unknown>) => {
    const key = `${sourceId}:${nodeNum}`;
    const existing = nodes.get(key);
    if (existing) nodes.set(key, { ...existing, ...c });
  });
  const emitFn = vi.fn();
  const setFixedFn = vi.fn(async () => undefined);
  const provider = { type: 'terrarium' as const, sample: sampleFn };

  const deps: AircraftClassificationDeps = {
    getNode: vi.fn(async (nodeNum: number, sourceId: string) => nodes.get(`${sourceId}:${nodeNum}`) ?? null),
    writeClassification: writeFn as unknown as AircraftClassificationDeps['writeClassification'],
    listForReclassify: vi.fn(async () => [] as AircraftReclassifyRow[]),
    listUnclassifiedWithAltitude: vi.fn(async () => [] as number[]),
    clearClassification: vi.fn(async () => 0),
    setFixed: setFixedFn as unknown as AircraftClassificationDeps['setFixed'],
    getSourceSetting: vi.fn(async (sourceId: string, key: string) => sourceSettings.get(`${sourceId}:${key}`) ?? null),
    getGlobalSetting: vi.fn(async (key: string) => globalSettings.get(key) ?? null),
    listSources: vi.fn(async () => [] as Array<{ id: string; type: string }>),
    resolveProvider: vi.fn(() => provider as any),
    emitAircraft: emitFn,
    now: () => clock.now,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
  };

  return { deps, nodes, sourceSettings, globalSettings, sampleFn, writeFn, emitFn, setFixedFn, clock };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AircraftClassificationService — schedule() coalescing and batching', () => {
  it('coalesces repeated schedule() calls for the same key into a single getNode call', async () => {
    const { deps, nodes } = makeDeps();
    nodes.set('src-a:100', makeNode({ nodeNum: 100 }));
    const svc = new AircraftClassificationService(deps);

    for (let i = 0; i < 5; i++) svc.schedule('src-a', 100);
    await svc.drainForTest();

    expect(deps.getNode).toHaveBeenCalledTimes(1);
  });

  it('never runs two sample() calls concurrently, even when schedule() lands mid-drain', async () => {
    const { deps, nodes, sampleFn } = makeDeps();
    nodes.set('src-a:100', makeNode({ nodeNum: 100 }));
    nodes.set('src-a:200', makeNode({ nodeNum: 200, latitude: 10, longitude: 10 }));

    let inFlight = 0;
    let sawOverlap = false;
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let callIndex = 0;
    sampleFn.mockImplementation(async (points: Array<{ lat: number; lng: number }>) => {
      inFlight++;
      if (inFlight > 1) sawOverlap = true;
      const myIndex = callIndex++;
      if (myIndex === 0) await firstGate;
      inFlight--;
      return points.map(() => 200);
    });

    const svc = new AircraftClassificationService(deps);
    svc.schedule('src-a', 100);
    // Let the first batch's async work begin (settings/getNode/sample()).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    svc.schedule('src-a', 200); // arrives while the first sample() call is still open
    releaseFirst?.();
    await svc.drainForTest();

    expect(sawOverlap).toBe(false);
    expect(sampleFn).toHaveBeenCalledTimes(2);
  });

  it('splits a 150-job burst into batches of 100 then 50', async () => {
    const { deps, nodes, sampleFn } = makeDeps();
    for (let i = 0; i < 150; i++) {
      nodes.set(`src-a:${i}`, makeNode({ nodeNum: i, latitude: 40 + i * 0.001, longitude: -70 - i * 0.001 }));
    }
    const svc = new AircraftClassificationService(deps);
    for (let i = 0; i < 150; i++) svc.schedule('src-a', i);
    await svc.drainForTest();

    expect(sampleFn).toHaveBeenCalledTimes(2);
    expect(sampleFn.mock.calls[0][0]).toHaveLength(MAX_BATCH);
    expect(sampleFn.mock.calls[1][0]).toHaveLength(50);
  });

  it('never throws from schedule(), even when a dependency rejects', async () => {
    const { deps } = makeDeps();
    (deps.getNode as any).mockRejectedValueOnce(new Error('db down'));
    const svc = new AircraftClassificationService(deps);

    expect(() => svc.schedule('src-a', 999)).not.toThrow();
    await expect(svc.drainForTest()).resolves.toBeUndefined();
  });
});

describe('AircraftClassificationService — ground memo (D5)', () => {
  it('reuses the last ground value for an unmoved node, and re-samples after a move', async () => {
    const { deps, nodes, sampleFn } = makeDeps();
    nodes.set('src-a:100', makeNode({ nodeNum: 100, altitude: 1000 }));
    const svc = new AircraftClassificationService(deps);

    svc.schedule('src-a', 100);
    await svc.drainForTest();
    expect(sampleFn).toHaveBeenCalledTimes(1);

    // Same node, unchanged coordinates — position packet re-arrives.
    svc.schedule('src-a', 100);
    await svc.drainForTest();
    expect(sampleFn).toHaveBeenCalledTimes(1);

    // Node moved (rounds to a different 4-dp lat/lng) — memo miss.
    const moved = nodes.get('src-a:100')!;
    nodes.set('src-a:100', { ...moved, latitude: (moved.latitude as number) + 1 });
    svc.schedule('src-a', 100);
    await svc.drainForTest();
    expect(sampleFn).toHaveBeenCalledTimes(2);
  });
});

describe('AircraftClassificationService — elevation gate and backoff (D4)', () => {
  it('skips sampling entirely when elevationEnabled=false, basis msl', async () => {
    const { deps, nodes, globalSettings, sampleFn } = makeDeps();
    globalSettings.set('elevationEnabled', 'false');
    nodes.set('src-a:100', makeNode({ nodeNum: 100, altitude: 6000 }));
    const svc = new AircraftClassificationService(deps);

    svc.schedule('src-a', 100);
    await svc.drainForTest();

    expect(sampleFn).not.toHaveBeenCalled();
    const node = nodes.get('src-a:100')!;
    expect(node.aircraftBasis).toBe('msl');
    expect(node.likelyAircraft).toBe(true); // 6000 > default 5000 MSL threshold
  });

  it('backs off for 10 minutes after an all-null sample result, then resumes', async () => {
    const { deps, nodes, sampleFn, clock } = makeDeps();
    nodes.set('src-a:100', makeNode({ nodeNum: 100, altitude: 6000 }));
    sampleFn.mockResolvedValueOnce([null]);
    const svc = new AircraftClassificationService(deps);

    svc.schedule('src-a', 100);
    await svc.drainForTest();
    expect(nodes.get('src-a:100')!.aircraftBasis).toBe('msl');
    expect(sampleFn).toHaveBeenCalledTimes(1);

    // Within the backoff window: no new sample() call.
    nodes.set('src-a:101', makeNode({ nodeNum: 101, altitude: 6000, latitude: 5, longitude: 5 }));
    svc.schedule('src-a', 101);
    await svc.drainForTest();
    expect(sampleFn).toHaveBeenCalledTimes(1);

    // After 10 minutes: sampling resumes.
    clock.now += PROVIDER_BACKOFF_MS + 1;
    sampleFn.mockResolvedValueOnce([300]);
    nodes.set('src-a:102', makeNode({ nodeNum: 102, altitude: 6000, latitude: 6, longitude: 6 }));
    svc.schedule('src-a', 102);
    await svc.drainForTest();
    expect(sampleFn).toHaveBeenCalledTimes(2);
  });

  it('backs off for 10 minutes after sample() rejects, then resumes', async () => {
    const { deps, nodes, sampleFn, clock } = makeDeps();
    nodes.set('src-a:100', makeNode({ nodeNum: 100, altitude: 6000 }));
    sampleFn.mockRejectedValueOnce(new Error('provider unreachable'));
    const svc = new AircraftClassificationService(deps);

    svc.schedule('src-a', 100);
    await svc.drainForTest();
    expect(nodes.get('src-a:100')!.aircraftBasis).toBe('msl');
    expect(sampleFn).toHaveBeenCalledTimes(1);

    nodes.set('src-a:101', makeNode({ nodeNum: 101, altitude: 6000, latitude: 5, longitude: 5 }));
    svc.schedule('src-a', 101);
    await svc.drainForTest();
    expect(sampleFn).toHaveBeenCalledTimes(1);

    clock.now += PROVIDER_BACKOFF_MS + 1;
    sampleFn.mockResolvedValueOnce([300]);
    nodes.set('src-a:102', makeNode({ nodeNum: 102, altitude: 6000, latitude: 6, longitude: 6 }));
    svc.schedule('src-a', 102);
    await svc.drainForTest();
    expect(sampleFn).toHaveBeenCalledTimes(2);
  });

  it('backs off for 10 minutes after a sample() call that never resolves (15s timeout)', async () => {
    vi.useFakeTimers();
    const { deps, nodes, sampleFn, clock } = makeDeps();
    deps.setTimer = setTimeout as unknown as typeof setTimeout;
    deps.clearTimer = clearTimeout as unknown as typeof clearTimeout;
    nodes.set('src-a:100', makeNode({ nodeNum: 100, altitude: 6000 }));
    sampleFn.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));
    const svc = new AircraftClassificationService(deps);

    svc.schedule('src-a', 100);
    const drainPromise = svc.drainForTest();
    await vi.advanceTimersByTimeAsync(SAMPLE_TIMEOUT_MS + 1000);
    await drainPromise;

    expect(nodes.get('src-a:100')!.aircraftBasis).toBe('msl');
    expect(sampleFn).toHaveBeenCalledTimes(1);

    // Within the backoff window: no new sample() call.
    sampleFn.mockResolvedValueOnce([300]);
    nodes.set('src-a:101', makeNode({ nodeNum: 101, altitude: 6000, latitude: 5, longitude: 5 }));
    svc.schedule('src-a', 101);
    await svc.drainForTest();
    expect(sampleFn).toHaveBeenCalledTimes(1);

    // After 10 minutes: sampling resumes.
    clock.now += PROVIDER_BACKOFF_MS + 1;
    nodes.set('src-a:102', makeNode({ nodeNum: 102, altitude: 6000, latitude: 6, longitude: 6 }));
    svc.schedule('src-a', 102);
    await svc.drainForTest();
    expect(sampleFn).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('treats a bogus (Null Island) position as no-ground and skips the sample call', async () => {
    const { deps, nodes, sampleFn } = makeDeps();
    nodes.set('src-a:100', makeNode({ nodeNum: 100, altitude: 6000, latitude: 0, longitude: 0 }));
    const svc = new AircraftClassificationService(deps);

    svc.schedule('src-a', 100);
    await svc.drainForTest();

    expect(sampleFn).not.toHaveBeenCalled();
    expect(nodes.get('src-a:100')!.aircraftBasis).toBe('msl');
  });

  it('skips the sample call when altitude is missing (basis unknown)', async () => {
    const { deps, nodes, sampleFn } = makeDeps();
    nodes.set('src-a:100', makeNode({ nodeNum: 100, altitude: null }));
    const svc = new AircraftClassificationService(deps);

    svc.schedule('src-a', 100);
    await svc.drainForTest();

    expect(sampleFn).not.toHaveBeenCalled();
    const node = nodes.get('src-a:100')!;
    expect(node.aircraftBasis).toBe('unknown');
    expect(node.likelyAircraft).toBeNull();
  });
});

describe('AircraftClassificationService — write-if-changed and effective position', () => {
  it('writes once on first classification, then skips an unchanged rewrite', async () => {
    const { deps, nodes, writeFn, globalSettings } = makeDeps();
    globalSettings.set('elevationEnabled', 'false'); // deterministic msl path, no memo interference
    nodes.set('src-a:100', makeNode({ nodeNum: 100, altitude: 1000 }));
    const svc = new AircraftClassificationService(deps);

    svc.schedule('src-a', 100);
    await svc.drainForTest();
    expect(writeFn).toHaveBeenCalledTimes(1);

    svc.schedule('src-a', 100);
    await svc.drainForTest();
    expect(writeFn).toHaveBeenCalledTimes(1); // identical classification -> no second write
  });

  it('classifies the effective (override) position, not the raw device position (D17)', async () => {
    const { deps, nodes, globalSettings } = makeDeps();
    globalSettings.set('elevationEnabled', 'false');
    nodes.set('src-a:100', makeNode({
      nodeNum: 100,
      altitude: 100, // device altitude — well below the MSL threshold
      positionOverrideEnabled: true,
      latitudeOverride: 45,
      longitudeOverride: -75,
      altitudeOverride: 9000, // override altitude — above the MSL threshold
    }));
    const svc = new AircraftClassificationService(deps);

    svc.schedule('src-a', 100);
    await svc.drainForTest();

    const node = nodes.get('src-a:100')!;
    expect(node.likelyAircraft).toBe(true);
    expect(node.aircraftBasis).toBe('msl');
  });
});

describe('AircraftClassificationService — node:aircraft events (D9)', () => {
  it('emits only for a position job transitioning into flagged, never for backfill or an already-true node', async () => {
    const { deps, nodes, emitFn } = makeDeps();
    nodes.set('src-a:100', makeNode({ nodeNum: 100, altitude: 6000, latitude: null, longitude: null }));
    const svc = new AircraftClassificationService(deps);

    svc.schedule('src-a', 100, 'position');
    await svc.drainForTest();
    expect(emitFn).toHaveBeenCalledTimes(1);
    expect(emitFn.mock.calls[0][0]).toMatchObject({ nodeNum: 100, previous: null, current: true, basis: 'msl' });
    expect(emitFn.mock.calls[0][1]).toBe('src-a');

    // Already true -> true: no new emit.
    svc.schedule('src-a', 100, 'position');
    await svc.drainForTest();
    expect(emitFn).toHaveBeenCalledTimes(1);

    // A fresh node, classified via 'backfill': silent even on a null->true transition.
    nodes.set('src-a:200', makeNode({ nodeNum: 200, altitude: 6000, latitude: null, longitude: null }));
    svc.schedule('src-a', 200, 'backfill');
    await svc.drainForTest();
    expect(emitFn).toHaveBeenCalledTimes(1);
  });
});

describe('AircraftClassificationService — disabled source (D7)', () => {
  it('skips a disabled source (no getNode call) and clears its classification once per batch', async () => {
    const { deps, nodes, sourceSettings } = makeDeps();
    sourceSettings.set('src-a:aircraftDetectionEnabled', 'false');
    nodes.set('src-a:100', makeNode({ nodeNum: 100, likelyAircraft: true, aircraftBasis: 'agl' }));
    const svc = new AircraftClassificationService(deps);

    svc.schedule('src-a', 100);
    await svc.drainForTest();

    expect(deps.getNode).not.toHaveBeenCalled();
    expect(deps.clearClassification).toHaveBeenCalledWith('src-a');
    expect(deps.clearClassification).toHaveBeenCalledTimes(1);
  });
});

describe('AircraftClassificationService — reclassifySource (D6/D7)', () => {
  it('recomputes from stored ground with no network call and no emit, and writes only changed rows', async () => {
    const { deps, sourceSettings, sampleFn, emitFn, writeFn } = makeDeps();
    sourceSettings.set('src-a:aircraftAglThresholdMeters', '3000');
    deps.listForReclassify = vi.fn(async () => [
      {
        nodeNum: 100,
        altitude: 1300,
        groundElevation: 300, // hag = 1000, was flagged at the old 500m threshold
        likelyAircraft: true,
        aircraftBasis: 'agl',
        heightAboveGround: 1000,
        positionOverrideEnabled: null,
        latitudeOverride: null,
        longitudeOverride: null,
        altitudeOverride: null,
        latitude: 45,
        longitude: -75,
      },
    ] as unknown as AircraftReclassifyRow[]);

    const svc = new AircraftClassificationService(deps);
    const written = await svc.reclassifySource('src-a');

    expect(written).toBe(1);
    expect(writeFn).toHaveBeenCalledWith(100, 'src-a', expect.objectContaining({
      likelyAircraft: false, // hag 1000 <= new 3000m threshold
      aircraftBasis: 'agl',
      groundElevation: 300,
      heightAboveGround: 1000,
    }));
    expect(sampleFn).not.toHaveBeenCalled();
    expect(emitFn).not.toHaveBeenCalled();
  });

  it('clears the source instead of recomputing when detection is disabled', async () => {
    const { deps, sourceSettings } = makeDeps();
    sourceSettings.set('src-a:aircraftDetectionEnabled', 'false');
    (deps.clearClassification as any).mockResolvedValueOnce(3);
    const svc = new AircraftClassificationService(deps);

    const written = await svc.reclassifySource('src-a');

    expect(written).toBe(3);
    expect(deps.listForReclassify).not.toHaveBeenCalled();
  });
});

describe('AircraftClassificationService — backfillAll (D11)', () => {
  it('enqueues unclassified nodes only on eligible, enabled sources', async () => {
    const { deps, nodes, sourceSettings, emitFn } = makeDeps();
    deps.listSources = vi.fn(async () => [
      { id: 'src-a', type: 'meshtastic_tcp' },
      { id: 'src-mc', type: 'meshcore' },
      { id: 'src-ret', type: 'reticulum' },
      { id: 'src-disabled', type: 'mqtt_broker' },
    ]);
    sourceSettings.set('src-disabled:aircraftDetectionEnabled', 'false');
    deps.listUnclassifiedWithAltitude = vi.fn(async (sourceId: string) => (sourceId === 'src-a' ? [100] : []));
    nodes.set('src-a:100', makeNode({ nodeNum: 100, altitude: 6000, latitude: null, longitude: null }));

    const svc = new AircraftClassificationService(deps);
    await svc.backfillAll();
    await svc.drainForTest();

    expect(deps.listUnclassifiedWithAltitude).toHaveBeenCalledWith('src-a');
    expect(deps.listUnclassifiedWithAltitude).not.toHaveBeenCalledWith('src-mc');
    expect(deps.listUnclassifiedWithAltitude).not.toHaveBeenCalledWith('src-ret');
    expect(deps.listUnclassifiedWithAltitude).not.toHaveBeenCalledWith('src-disabled');
    expect(deps.writeClassification).toHaveBeenCalledWith(100, 'src-a', expect.anything());
    expect(emitFn).not.toHaveBeenCalled(); // silent — D11
  });
});

// #5364/#5365 Phase 2 (D4): the "confirmed fixed" anchor.
describe('AircraftClassificationService — fixed anchor', () => {
  const M = 1 / 111_320; // ~1 m of latitude

  it('a marked node within 1 km of its anchor stays not-aircraft and keeps the mark; no event', async () => {
    const { deps, nodes, writeFn, emitFn, setFixedFn } = makeDeps();
    nodes.set('src-a:100', makeNode({
      nodeNum: 100, altitude: 9000, latitude: 45 + 300 * M, longitude: -75,
      aircraftFixedAt: 1, aircraftFixedLatitude: 45, aircraftFixedLongitude: -75,
    } as any));
    const svc = new AircraftClassificationService(deps);
    svc.schedule('src-a', 100);
    await svc.drainForTest();
    expect(setFixedFn).not.toHaveBeenCalled();
    expect(emitFn).not.toHaveBeenCalled();
    expect(writeFn.mock.calls.at(-1)?.[2].likelyAircraft).toBe(false);
  });

  it('beyond 1 km the mark is cleared and the node is classified normally (event fires)', async () => {
    const { deps, nodes, writeFn, emitFn, setFixedFn } = makeDeps();
    nodes.set('src-a:101', makeNode({
      nodeNum: 101, altitude: 9000, latitude: 45 + 2000 * M, longitude: -75,
      aircraftFixedAt: 1, aircraftFixedLatitude: 45, aircraftFixedLongitude: -75,
    } as any));
    const svc = new AircraftClassificationService(deps);
    svc.schedule('src-a', 101);
    await svc.drainForTest();
    expect(setFixedFn).toHaveBeenCalledWith(101, 'src-a', null);
    expect(writeFn.mock.calls.at(-1)?.[2].likelyAircraft).toBe(true);
    expect(emitFn).toHaveBeenCalledTimes(1);
  });

  it('reclassifySource honours the anchor and releases a moved node', async () => {
    const { deps, sourceSettings, setFixedFn, writeFn } = makeDeps();
    sourceSettings.set('src-a:aircraftDetectionEnabled', 'true');
    const base = {
      groundElevation: null, likelyAircraft: false, aircraftBasis: 'msl', heightAboveGround: null,
      positionOverrideEnabled: false, latitudeOverride: null, longitudeOverride: null, altitudeOverride: null,
      altitude: 9000, aircraftFixedLatitude: 45, aircraftFixedLongitude: -75,
    };
    (deps.listForReclassify as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...base, nodeNum: 1, latitude: 45 + 100 * M, longitude: -75 },
      { ...base, nodeNum: 2, latitude: 45 + 5000 * M, longitude: -75 },
    ] as AircraftReclassifyRow[]);
    const svc = new AircraftClassificationService(deps);
    await svc.reclassifySource('src-a');
    expect(setFixedFn).toHaveBeenCalledTimes(1);
    expect(setFixedFn).toHaveBeenCalledWith(2, 'src-a', null);
    // Node 1 stayed false (no write); node 2 flips to true.
    expect(writeFn.mock.calls.map((c) => c[0])).toEqual([2]);
    expect(writeFn.mock.calls[0][2].likelyAircraft).toBe(true);
  });
});
