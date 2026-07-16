/**
 * Unit tests for mqttGeoSweepService (MQTT Geo-Ignore epic, Phase 3, WP1).
 *
 * `../../services/database.js` is mocked wholesale (mockResolvedValue on
 * every async method) — this file exercises the sweep's branching logic in
 * isolation from any real database. Per-source isolation is covered
 * separately in `mqttGeoSweepService.perSource.test.ts` against the real
 * singleton DB.
 *
 * `getEffectiveDbNodePosition` (nodeEnhancer.ts) and `MqttPacketFilter`
 * (mqttPacketFilter.ts) are used UNMOCKED — both are small pure functions,
 * and the override/bbox-classification behavior under test is exactly what
 * they implement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAllNodes = vi.fn();
const isIgnoredCached = vi.fn();
const addGeoIgnoreAsync = vi.fn();
const getIgnoredNodesAsync = vi.fn();
const liftGeoIgnoreAsync = vi.fn();
const deleteNodeAsync = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    nodes: { getAllNodes: (...a: unknown[]) => getAllNodes(...a) },
    ignoredNodes: {
      isIgnoredCached: (...a: unknown[]) => isIgnoredCached(...a),
      addGeoIgnoreAsync: (...a: unknown[]) => addGeoIgnoreAsync(...a),
      getIgnoredNodesAsync: (...a: unknown[]) => getIgnoredNodesAsync(...a),
      liftGeoIgnoreAsync: (...a: unknown[]) => liftGeoIgnoreAsync(...a),
    },
    deleteNodeAsync: (...a: unknown[]) => deleteNodeAsync(...a),
  },
}));

import { logger } from '../../utils/logger.js';
import { mqttGeoSweepService, type GeoSweepStatsSink } from './mqttGeoSweepService.js';

// Matches the ON_BBOX convention used across the geo-ignore test suite.
const ON_BBOX = { minLat: 43, maxLat: 45, minLng: -80, maxLng: -77 };

function makeNode(overrides: Record<string, unknown> = {}) {
  return {
    nodeNum: 100,
    nodeId: '!00000064',
    longName: 'Node 100',
    shortName: 'N100',
    latitude: 44,
    longitude: -78,
    positionOverrideEnabled: false,
    latitudeOverride: null,
    longitudeOverride: null,
    ...overrides,
  };
}

describe('mqttGeoSweepService', () => {
  beforeEach(() => {
    getAllNodes.mockReset().mockResolvedValue([]);
    isIgnoredCached.mockReset().mockReturnValue(false);
    addGeoIgnoreAsync.mockReset().mockResolvedValue(true);
    getIgnoredNodesAsync.mockReset().mockResolvedValue([]);
    liftGeoIgnoreAsync.mockReset().mockResolvedValue(true);
    deleteNodeAsync.mockReset().mockResolvedValue(undefined);
  });

  it('ignores and purges an out-of-bbox node', async () => {
    getAllNodes.mockResolvedValue([makeNode({ latitude: 49.2, longitude: -123 })]);

    const stats = await mqttGeoSweepService.runSweep('S1', ON_BBOX, { lift: false });

    expect(stats).toMatchObject({ sourceId: 'S1', scanned: 1, ignored: 1, purged: 1, lifted: 0 });
    expect(addGeoIgnoreAsync).toHaveBeenCalledWith(100, 'S1', '!00000064', 'Node 100', 'N100');
    expect(deleteNodeAsync).toHaveBeenCalledWith(100, 'S1');
  });

  it('leaves an in-bbox node untouched', async () => {
    getAllNodes.mockResolvedValue([makeNode({ latitude: 44, longitude: -78 })]);

    const stats = await mqttGeoSweepService.runSweep('S1', ON_BBOX, { lift: false });

    expect(stats).toMatchObject({ scanned: 1, ignored: 0, purged: 0 });
    expect(addGeoIgnoreAsync).not.toHaveBeenCalled();
    expect(deleteNodeAsync).not.toHaveBeenCalled();
  });

  it('excludes position-less nodes from scanned', async () => {
    getAllNodes.mockResolvedValue([makeNode({ latitude: null, longitude: null })]);

    const stats = await mqttGeoSweepService.runSweep('S1', ON_BBOX, { lift: false });

    expect(stats.scanned).toBe(0);
    expect(addGeoIgnoreAsync).not.toHaveBeenCalled();
  });

  it('honors an override that pushes an in-GPS node out of bounds', async () => {
    getAllNodes.mockResolvedValue([
      makeNode({
        latitude: 44, longitude: -78, // GPS is inside the bbox
        positionOverrideEnabled: true,
        latitudeOverride: 49.2, longitudeOverride: -123, // override is outside
      }),
    ]);

    const stats = await mqttGeoSweepService.runSweep('S1', ON_BBOX, { lift: false });

    expect(stats.ignored).toBe(1);
    expect(deleteNodeAsync).toHaveBeenCalledWith(100, 'S1');
  });

  it('honors an override that pulls an out-of-GPS node back in bounds', async () => {
    getAllNodes.mockResolvedValue([
      makeNode({
        latitude: 49.2, longitude: -123, // GPS is outside the bbox
        positionOverrideEnabled: true,
        latitudeOverride: 44, longitudeOverride: -78, // override is inside
      }),
    ]);

    const stats = await mqttGeoSweepService.runSweep('S1', ON_BBOX, { lift: false });

    expect(stats.ignored).toBe(0);
    expect(addGeoIgnoreAsync).not.toHaveBeenCalled();
    expect(deleteNodeAsync).not.toHaveBeenCalled();
  });

  it('does not purge when addGeoIgnoreAsync returns false (purge-once contract)', async () => {
    addGeoIgnoreAsync.mockResolvedValue(false);
    getAllNodes.mockResolvedValue([makeNode({ latitude: 49.2, longitude: -123 })]);

    const stats = await mqttGeoSweepService.runSweep('S1', ON_BBOX, { lift: false });

    expect(stats.ignored).toBe(0);
    expect(stats.purged).toBe(0);
    expect(deleteNodeAsync).not.toHaveBeenCalled();
  });

  it('skips an already-ignored node in the add pass (excluded from scanned)', async () => {
    isIgnoredCached.mockReturnValue(true);
    getAllNodes.mockResolvedValue([makeNode({ latitude: 49.2, longitude: -123 })]);

    const stats = await mqttGeoSweepService.runSweep('S1', ON_BBOX, { lift: false });

    expect(stats.scanned).toBe(0);
    expect(addGeoIgnoreAsync).not.toHaveBeenCalled();
  });

  it('lift pass lifts only reason=geo entries and counts only true returns', async () => {
    getIgnoredNodesAsync.mockResolvedValue([
      { nodeNum: 1, reason: 'geo' },
      { nodeNum: 2, reason: 'manual' },
      { nodeNum: 3, reason: 'geo' },
    ]);
    liftGeoIgnoreAsync.mockImplementation((nodeNum: number) => Promise.resolve(nodeNum === 1));

    const stats = await mqttGeoSweepService.runSweep('S1', ON_BBOX, { lift: true });

    expect(liftGeoIgnoreAsync).toHaveBeenCalledTimes(2);
    expect(liftGeoIgnoreAsync).toHaveBeenCalledWith(1, 'S1');
    expect(liftGeoIgnoreAsync).toHaveBeenCalledWith(3, 'S1');
    expect(liftGeoIgnoreAsync).not.toHaveBeenCalledWith(2, 'S1');
    expect(stats.lifted).toBe(1);
  });

  it('lift:false never calls getIgnoredNodesAsync or liftGeoIgnoreAsync', async () => {
    await mqttGeoSweepService.runSweep('S1', ON_BBOX, { lift: false });

    expect(getIgnoredNodesAsync).not.toHaveBeenCalled();
    expect(liftGeoIgnoreAsync).not.toHaveBeenCalled();
  });

  it('geo:undefined with lift:true still lifts, while the add pass no-ops', async () => {
    getIgnoredNodesAsync.mockResolvedValue([{ nodeNum: 1, reason: 'geo' }]);
    liftGeoIgnoreAsync.mockResolvedValue(true);
    getAllNodes.mockResolvedValue([makeNode({ latitude: 49.2, longitude: -123 })]);

    const stats = await mqttGeoSweepService.runSweep('S1', undefined, { lift: true });

    expect(stats.lifted).toBe(1);
    expect(stats.ignored).toBe(0);
    expect(stats.purged).toBe(0);
    expect(addGeoIgnoreAsync).not.toHaveBeenCalled();
  });

  it('logs at info level when anything changed, debug otherwise', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    getAllNodes.mockResolvedValue([makeNode({ latitude: 49.2, longitude: -123 })]);
    await mqttGeoSweepService.runSweep('S1', ON_BBOX, { lift: false });
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('geo sweep [S1]: ignored 1, purged 1, lifted 0, scanned 1'));
    expect(debugSpy).not.toHaveBeenCalledWith(expect.stringContaining('geo sweep'));

    infoSpy.mockClear();
    debugSpy.mockClear();

    getAllNodes.mockResolvedValue([makeNode({ latitude: 44, longitude: -78 })]);
    await mqttGeoSweepService.runSweep('S1', ON_BBOX, { lift: false });
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('geo sweep'));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('geo sweep [S1]'));

    infoSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('calls the stats sink exactly once with the final stats', async () => {
    getAllNodes.mockResolvedValue([makeNode({ latitude: 49.2, longitude: -123 })]);
    const recordGeoSweepStats = vi.fn();
    const sink: GeoSweepStatsSink = { recordGeoSweepStats };

    const stats = await mqttGeoSweepService.runSweep('S1', ON_BBOX, { lift: false, sink });

    expect(recordGeoSweepStats).toHaveBeenCalledTimes(1);
    expect(recordGeoSweepStats).toHaveBeenCalledWith(stats);
  });

  it('serializes two overlapping calls for the same source', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstCallSeen = false;

    getAllNodes.mockImplementation(async () => {
      if (!firstCallSeen) {
        firstCallSeen = true;
        order.push('first-start');
        await new Promise<void>((res) => { releaseFirst = res; });
        order.push('first-end');
        return [];
      }
      order.push('second-start');
      return [];
    });

    const p1 = mqttGeoSweepService.runSweep('SAME', ON_BBOX, { lift: false });
    // Let p1 reach its getAllNodes await point.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const p2 = mqttGeoSweepService.runSweep('SAME', ON_BBOX, { lift: false });
    // p2 must not have started scanning yet — it's chained behind p1.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    releaseFirst();
    await p1;
    await p2;

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });
});
