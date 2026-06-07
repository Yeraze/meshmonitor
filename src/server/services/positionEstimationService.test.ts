/**
 * Tests for positionEstimationService — the global, batch, multilateration
 * position estimator (issue #3271).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the database singleton before importing the service.
// vi.hoisted keeps the mock object available to the hoisted vi.mock factory.
const mockDb = vi.hoisted(() => ({
  sources: { getAllSources: vi.fn() },
  nodes: { getAllNodes: vi.fn() },
  traceroutes: { getAllTraceroutes: vi.fn() },
  neighbors: { getAllNeighborInfo: vi.fn() },
  upsertEstimatedPositionsAsync: vi.fn(),
  deleteEstimatedPositionsByNodeNumsAsync: vi.fn(),
}));
vi.mock('../../services/database.js', () => ({ default: mockDb }));

import {
  solveNodePosition,
  buildObservations,
  observationWeight,
  positionEstimationService,
  type PositionObservation,
  type TracerouteForEstimation,
  type NeighborForEstimation,
} from './positionEstimationService.js';

const NOW = 1_700_000_000_000;

function obs(partial: Partial<PositionObservation>): PositionObservation {
  return {
    nodeNum: 1,
    anchorLat: 0,
    anchorLon: 0,
    timestamp: NOW,
    kind: 'traceroute',
    ...partial,
  };
}

describe('solveNodePosition', () => {
  it('returns null for no observations', () => {
    expect(solveNodePosition([], NOW)).toBeNull();
  });

  it('places the estimate at the centroid of four symmetric anchors', () => {
    const d = 0.1; // ~11km
    const anchors = [
      obs({ anchorLat: 10 + d, anchorLon: 20 }),
      obs({ anchorLat: 10 - d, anchorLon: 20 }),
      obs({ anchorLat: 10, anchorLon: 20 + d }),
      obs({ anchorLat: 10, anchorLon: 20 - d }),
    ];
    const solved = solveNodePosition(anchors, NOW)!;
    expect(solved.latitude).toBeCloseTo(10, 5);
    expect(solved.longitude).toBeCloseTo(20, 5);
    expect(solved.observationCount).toBe(4);
  });

  it('a single traceroute segment yields the midpoint of its two anchors', () => {
    const segment = [
      obs({ anchorLat: 10, anchorLon: 20 }),
      obs({ anchorLat: 12, anchorLon: 20 }),
    ];
    const solved = solveNodePosition(segment, NOW)!;
    expect(solved.latitude).toBeCloseTo(11, 5);
    expect(solved.longitude).toBeCloseTo(20, 5);
  });

  it('a spread-out 2-anchor estimate is less certain than a tight 4-anchor cluster', () => {
    const farPair = solveNodePosition([
      obs({ anchorLat: 10, anchorLon: 20 }),
      obs({ anchorLat: 12, anchorLon: 20 }),
    ], NOW)!;
    const tightCluster = solveNodePosition([
      obs({ anchorLat: 10.01, anchorLon: 20 }),
      obs({ anchorLat: 9.99, anchorLon: 20 }),
      obs({ anchorLat: 10, anchorLon: 20.01 }),
      obs({ anchorLat: 10, anchorLon: 19.99 }),
    ], NOW)!;
    expect(farPair.uncertaintyKm).toBeGreaterThan(tightCluster.uncertaintyKm);
  });

  it('biases the estimate toward the higher-SNR anchor', () => {
    const solved = solveNodePosition([
      obs({ anchorLat: 10, anchorLon: 20, snrDb: 12 }),  // strong → closer
      obs({ anchorLat: 14, anchorLon: 20, snrDb: -4 }),  // weak → farther
    ], NOW)!;
    // Strong anchor at lat 10, weak at lat 14 → estimate pulled below midpoint (12).
    expect(solved.latitude).toBeLessThan(12);
    expect(solved.latitude).toBeGreaterThan(10);
  });

  it('down-weights stale observations via time decay', () => {
    const fresh = observationWeight(obs({ timestamp: NOW }), NOW);
    const dayOld = observationWeight(obs({ timestamp: NOW - 24 * 60 * 60 * 1000 }), NOW);
    expect(dayOld).toBeCloseTo(fresh / 2, 5); // 24h half-life
  });
});

describe('buildObservations', () => {
  const anchors = new Map<number, { lat: number; lon: number }>([
    [100, { lat: 10, lon: 20 }],
    [200, { lat: 12, lon: 20 }],
  ]);

  it('anchors a traceroute intermediate to both positioned neighbors', () => {
    const trs: TracerouteForEstimation[] = [{
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([5]),       // path: 100 - 5 - 200
      routeBack: null,
      snrTowards: JSON.stringify([20, 24]),
      snrBack: null,
      timestamp: NOW,
    }];
    const out = buildObservations(trs, [], anchors);
    expect(out.has(5)).toBe(true);
    expect(out.get(5)!).toHaveLength(2);
  });

  it('does not estimate a node that already has a real position', () => {
    const trs: TracerouteForEstimation[] = [{
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([200]),     // 200 is an anchor, should be skipped
      routeBack: null,
      snrTowards: JSON.stringify([20, 24]),
      snrBack: null,
      timestamp: NOW,
    }];
    const out = buildObservations(trs, [], anchors);
    expect(out.has(200)).toBe(false);
  });

  it('anchors the unpositioned side of a neighbor pair', () => {
    const nbs: NeighborForEstimation[] = [
      { nodeNum: 100, neighborNodeNum: 7, snr: 6.5, timestamp: NOW },
    ];
    const out = buildObservations([], nbs, anchors);
    expect(out.get(7)).toHaveLength(1);
    expect(out.get(7)![0].kind).toBe('neighbor');
    expect(out.get(7)![0].anchorLat).toBe(10);
  });

  it('combines traceroute and neighbor observations for the same node', () => {
    const trs: TracerouteForEstimation[] = [{
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([9]),
      routeBack: null,
      snrTowards: JSON.stringify([20, 24]),
      snrBack: null,
      timestamp: NOW,
    }];
    const nbs: NeighborForEstimation[] = [
      { nodeNum: 200, neighborNodeNum: 9, snr: 5, timestamp: NOW },
    ];
    const out = buildObservations(trs, nbs, anchors);
    // 2 from traceroute (anchors 100 + 200) + 1 from neighbor (anchor 200) = 3
    expect(out.get(9)).toHaveLength(3);
    expect(out.get(9)!.some(o => o.kind === 'traceroute')).toBe(true);
    expect(out.get(9)!.some(o => o.kind === 'neighbor')).toBe(true);
  });
});

describe('positionEstimationService.recomputeAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pin system time so recomputeAll's internal Date.now() matches NOW-based fixtures.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockDb.traceroutes.getAllTraceroutes.mockResolvedValue([]);
    mockDb.neighbors.getAllNeighborInfo.mockResolvedValue([]);
    mockDb.upsertEstimatedPositionsAsync.mockResolvedValue(undefined);
    mockDb.deleteEstimatedPositionsByNodeNumsAsync.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pools anchors and observations across multiple Meshtastic sources into one estimate', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([
      { id: 'src-a', type: 'meshtastic_tcp' },
      { id: 'src-b', type: 'mqtt_broker' },
    ]);
    // Anchor 100 lives in source A, anchor 200 in source B (MQTT).
    mockDb.nodes.getAllNodes.mockImplementation(async (sourceId: string) => {
      if (sourceId === 'src-a') return [{ nodeNum: 100, latitude: 10, longitude: 20 }];
      if (sourceId === 'src-b') return [{ nodeNum: 200, latitude: 12, longitude: 20 }];
      return [];
    });
    // Traceroute heard on source A places node 5 between 100 and 200.
    mockDb.traceroutes.getAllTraceroutes.mockImplementation(async (_limit: number, sourceId: string) => {
      if (sourceId === 'src-a') return [{
        fromNodeNum: 100, toNodeNum: 200, route: JSON.stringify([5]),
        routeBack: null, snrTowards: JSON.stringify([20, 20]), snrBack: null, timestamp: NOW,
      }];
      return [];
    });

    const result = await positionEstimationService.recomputeAll({ lookbackMs: 7 * 24 * 60 * 60 * 1000 });

    expect(result.anchorCount).toBe(2);
    expect(result.estimatedNodeCount).toBe(1);
    const inputs = mockDb.upsertEstimatedPositionsAsync.mock.calls[0][0];
    expect(inputs).toHaveLength(1);
    expect(inputs[0].nodeNum).toBe(5);
    expect(inputs[0].latitude).toBeCloseTo(11, 5); // midpoint of cross-source anchors
  });

  it('excludes MeshCore sources', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([
      { id: 'mc', type: 'meshcore' },
      { id: 'mt', type: 'meshtastic_tcp' },
    ]);
    mockDb.nodes.getAllNodes.mockResolvedValue([]);

    await positionEstimationService.recomputeAll({ lookbackMs: 1000 });

    const queriedSources = mockDb.nodes.getAllNodes.mock.calls.map((c: any[]) => c[0]);
    expect(queriedSources).toContain('mt');
    expect(queriedSources).not.toContain('mc');
  });

  it('ignores observations older than the lookback window', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([{ id: 's', type: 'meshtastic_tcp' }]);
    mockDb.nodes.getAllNodes.mockResolvedValue([
      { nodeNum: 100, latitude: 10, longitude: 20 },
      { nodeNum: 200, latitude: 12, longitude: 20 },
    ]);
    const old = NOW - 30 * 24 * 60 * 60 * 1000; // 30 days ago
    mockDb.traceroutes.getAllTraceroutes.mockResolvedValue([{
      fromNodeNum: 100, toNodeNum: 200, route: JSON.stringify([5]),
      routeBack: null, snrTowards: JSON.stringify([20, 20]), snrBack: null, timestamp: old,
    }]);

    const result = await positionEstimationService.recomputeAll({ lookbackMs: 7 * 24 * 60 * 60 * 1000 });
    expect(result.estimatedNodeCount).toBe(0);
  });

  it('clears estimates for nodes that now have real positions', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([{ id: 's', type: 'meshtastic_tcp' }]);
    mockDb.nodes.getAllNodes.mockResolvedValue([
      { nodeNum: 100, latitude: 10, longitude: 20 },
      { nodeNum: 200, latitude: 12, longitude: 20 },
    ]);

    await positionEstimationService.recomputeAll({ lookbackMs: 1000 });

    const deletedNodeNums = mockDb.deleteEstimatedPositionsByNodeNumsAsync.mock.calls[0][0];
    expect(deletedNodeNums).toContain(100);
    expect(deletedNodeNums).toContain(200);
  });
});
