/**
 * NodeMobilityService tests
 *
 * Covers the mobility heuristic extracted from
 * DatabaseService.updateNodeMobilityAsync (Phase 3.4, #3962):
 * bounding-box haversine >100m boundary, insufficient-history and error paths,
 * plus the persist + cache-patch side effects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateNodeMobility, NodeMobilityDeps } from './nodeMobilityService.js';
import { ALL_SOURCES } from '../../db/repositories/base.js';

const NODE_ID = '!aabbccdd';

// ~0.002° of latitude ≈ 222 m; ~0.0005° ≈ 56 m (well either side of the 100 m threshold)
const positionRows = (latSpanDeg: number) => [
  { telemetryType: 'latitude', value: 30.0, timestamp: 1 },
  { telemetryType: 'longitude', value: -90.0, timestamp: 1 },
  { telemetryType: 'latitude', value: 30.0 + latSpanDeg, timestamp: 2 },
  { telemetryType: 'longitude', value: -90.0, timestamp: 2 },
];

describe('nodeMobilityService.updateNodeMobility', () => {
  let deps: NodeMobilityDeps;
  let getPositionTelemetryByNode: ReturnType<typeof vi.fn>;
  let updateNodeMobilityRepo: ReturnType<typeof vi.fn>;
  let patchCache: ReturnType<typeof vi.fn<(nodeId: string, mobile: number) => void>>;

  beforeEach(() => {
    getPositionTelemetryByNode = vi.fn().mockResolvedValue([]);
    updateNodeMobilityRepo = vi.fn().mockResolvedValue(undefined);
    patchCache = vi.fn<(nodeId: string, mobile: number) => void>();
    deps = {
      telemetryRepo: { getPositionTelemetryByNode } as any,
      nodesRepo: { updateNodeMobility: updateNodeMobilityRepo } as any,
      patchCache,
    };
  });

  it('marks a node mobile when its position box spans more than 100 m', async () => {
    getPositionTelemetryByNode.mockResolvedValue(positionRows(0.002)); // ~222 m

    const result = await updateNodeMobility(NODE_ID, deps);

    expect(result).toBe(1);
    expect(updateNodeMobilityRepo).toHaveBeenCalledWith(NODE_ID, 1);
    expect(patchCache).toHaveBeenCalledWith(NODE_ID, 1);
  });

  it('keeps a node stationary when movement stays under 100 m', async () => {
    getPositionTelemetryByNode.mockResolvedValue(positionRows(0.0005)); // ~56 m

    const result = await updateNodeMobility(NODE_ID, deps);

    expect(result).toBe(0);
    expect(updateNodeMobilityRepo).toHaveBeenCalledWith(NODE_ID, 0);
    expect(patchCache).toHaveBeenCalledWith(NODE_ID, 0);
  });

  it('returns 0 (and still persists) with fewer than 2 position pairs', async () => {
    getPositionTelemetryByNode.mockResolvedValue([
      { telemetryType: 'latitude', value: 30.0, timestamp: 1 },
      { telemetryType: 'longitude', value: -90.0, timestamp: 1 },
    ]);

    const result = await updateNodeMobility(NODE_ID, deps);

    expect(result).toBe(0);
    expect(updateNodeMobilityRepo).toHaveBeenCalledWith(NODE_ID, 0);
  });

  it('reads position history cross-source (ALL_SOURCES) with a 500 limit', async () => {
    await updateNodeMobility(NODE_ID, deps);
    expect(getPositionTelemetryByNode).toHaveBeenCalledWith(NODE_ID, 500, undefined, ALL_SOURCES);
  });

  it('swallows errors and reports non-mobile', async () => {
    getPositionTelemetryByNode.mockRejectedValue(new Error('db down'));

    const result = await updateNodeMobility(NODE_ID, deps);

    expect(result).toBe(0);
    expect(patchCache).not.toHaveBeenCalled();
  });
});
