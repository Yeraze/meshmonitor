/**
 * Tests for the inline (per-packet) distance check on
 * autoDeleteByDistanceService (issue #3900).
 *
 * `applyInlineDistanceCheck` is called synchronously from MQTT ingestion as
 * each POSITION packet arrives, so a node beyond the source's configured radius
 * never touches the nodeDB — instead of being cleaned up on the next periodic
 * cycle. It mirrors runDeleteCycle's protections (local node, favorites) and
 * caches per-source config to avoid a settings query per packet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSettingForSource = vi.fn();
const getNode = vi.fn();
const deleteNodeAsync = vi.fn();
const setNodeIgnoredAsync = vi.fn();
const isIgnoredCached = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    settings: { getSettingForSource: (...a: unknown[]) => getSettingForSource(...a) },
    nodes: { getNode: (...a: unknown[]) => getNode(...a) },
    ignoredNodes: { isIgnoredCached: (...a: unknown[]) => isIgnoredCached(...a) },
    deleteNodeAsync: (...a: unknown[]) => deleteNodeAsync(...a),
    setNodeIgnoredAsync: (...a: unknown[]) => setNodeIgnoredAsync(...a),
  },
}));

vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: () => ({ sendIgnoredNode: vi.fn() }),
}));

vi.mock('../utils/nodeEnhancer.js', () => ({
  getEffectiveDbNodePosition: (n: { latitude?: number | null; longitude?: number | null }) => ({
    latitude: n.latitude ?? null,
    longitude: n.longitude ?? null,
  }),
}));

import { autoDeleteByDistanceService } from './autoDeleteByDistanceService.js';

// A source configured with home (0,0), 100km threshold. Far coordinates
// (~10,10 ≈ 1560km) are well beyond; near coordinates (~0.1,0.1 ≈ 15km) are in.
const FAR_LAT = 10;
const FAR_LON = 10;
const NEAR_LAT = 0.1;
const NEAR_LON = 0.1;

function mockSettings(overrides: Record<string, string | null> = {}): void {
  const base: Record<string, string | null> = {
    autoDeleteByDistanceEnabled: 'true',
    autoDeleteByDistanceLat: '0',
    autoDeleteByDistanceLon: '0',
    autoDeleteByDistanceThresholdKm: '100',
    autoDeleteByDistanceAction: 'delete',
    localNodeNum: null,
    ...overrides,
  };
  getSettingForSource.mockImplementation((_sourceId: string, key: string) =>
    Promise.resolve(key in base ? base[key] : null),
  );
}

describe('autoDeleteByDistanceService.applyInlineDistanceCheck (#3900)', () => {
  beforeEach(() => {
    getSettingForSource.mockReset();
    getNode.mockReset().mockResolvedValue(null);
    deleteNodeAsync.mockReset().mockResolvedValue(undefined);
    setNodeIgnoredAsync.mockReset().mockResolvedValue(undefined);
    isIgnoredCached.mockReset().mockReturnValue(false);
    // Config is cached per-source; clear between cases so each mockSettings takes.
    autoDeleteByDistanceService.clearInlineConfigCache();
  });

  it("returns 'kept' when the feature is disabled for the source", async () => {
    mockSettings({ autoDeleteByDistanceEnabled: 'false' });
    const out = await autoDeleteByDistanceService.applyInlineDistanceCheck('A', 1, FAR_LAT, FAR_LON);
    expect(out).toBe('kept');
    expect(deleteNodeAsync).not.toHaveBeenCalled();
  });

  it("returns 'kept' when no home coordinates are configured", async () => {
    mockSettings({ autoDeleteByDistanceLat: null, autoDeleteByDistanceLon: null });
    const out = await autoDeleteByDistanceService.applyInlineDistanceCheck('A', 1, FAR_LAT, FAR_LON);
    expect(out).toBe('kept');
  });

  it("returns 'kept' for a node within the threshold", async () => {
    mockSettings();
    const out = await autoDeleteByDistanceService.applyInlineDistanceCheck('A', 1, NEAR_LAT, NEAR_LON);
    expect(out).toBe('kept');
    expect(deleteNodeAsync).not.toHaveBeenCalled();
    // A within-range node must not incur a getNode lookup.
    expect(getNode).not.toHaveBeenCalled();
  });

  it("deletes an existing node beyond the threshold (action=delete)", async () => {
    mockSettings();
    getNode.mockResolvedValue({ nodeNum: 1, isFavorite: false });
    const out = await autoDeleteByDistanceService.applyInlineDistanceCheck('A', 1, FAR_LAT, FAR_LON);
    expect(out).toBe('deleted');
    expect(deleteNodeAsync).toHaveBeenCalledWith(1, 'A');
  });

  it("returns 'deleted' without a delete call when the node isn't in the DB yet", async () => {
    mockSettings();
    getNode.mockResolvedValue(null);
    const out = await autoDeleteByDistanceService.applyInlineDistanceCheck('A', 2, FAR_LAT, FAR_LON);
    expect(out).toBe('deleted');
    expect(deleteNodeAsync).not.toHaveBeenCalled();
  });

  it("ignores a node beyond the threshold (action=ignore)", async () => {
    mockSettings({ autoDeleteByDistanceAction: 'ignore' });
    getNode.mockResolvedValue({ nodeNum: 3, isFavorite: false, isIgnored: false });
    const out = await autoDeleteByDistanceService.applyInlineDistanceCheck('A', 3, FAR_LAT, FAR_LON);
    expect(out).toBe('ignored');
    expect(setNodeIgnoredAsync).toHaveBeenCalledWith(3, true, 'A');
    expect(deleteNodeAsync).not.toHaveBeenCalled();
  });

  it("skips the ignore write when the node is already ignored", async () => {
    mockSettings({ autoDeleteByDistanceAction: 'ignore' });
    getNode.mockResolvedValue({ nodeNum: 3, isFavorite: false, isIgnored: true });
    const out = await autoDeleteByDistanceService.applyInlineDistanceCheck('A', 3, FAR_LAT, FAR_LON);
    expect(out).toBe('ignored');
    expect(setNodeIgnoredAsync).not.toHaveBeenCalled();
  });

  it("never touches a favorited node beyond the threshold", async () => {
    mockSettings();
    getNode.mockResolvedValue({ nodeNum: 4, isFavorite: true });
    const out = await autoDeleteByDistanceService.applyInlineDistanceCheck('A', 4, FAR_LAT, FAR_LON);
    expect(out).toBe('kept');
    expect(deleteNodeAsync).not.toHaveBeenCalled();
  });

  it("protects the local node even when it is beyond the threshold", async () => {
    mockSettings({ localNodeNum: '5' });
    const out = await autoDeleteByDistanceService.applyInlineDistanceCheck('A', 5, FAR_LAT, FAR_LON);
    expect(out).toBe('kept');
    expect(getNode).not.toHaveBeenCalled();
    expect(deleteNodeAsync).not.toHaveBeenCalled();
  });

  it("caches config per source — a second call does not re-read settings", async () => {
    mockSettings();
    getNode.mockResolvedValue(null);
    await autoDeleteByDistanceService.applyInlineDistanceCheck('A', 1, FAR_LAT, FAR_LON);
    const callsAfterFirst = getSettingForSource.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    await autoDeleteByDistanceService.applyInlineDistanceCheck('A', 2, FAR_LAT, FAR_LON);
    // No additional settings reads on the cached second call.
    expect(getSettingForSource.mock.calls.length).toBe(callsAfterFirst);
  });

  it("re-reads settings after clearInlineConfigCache", async () => {
    mockSettings();
    getNode.mockResolvedValue(null);
    await autoDeleteByDistanceService.applyInlineDistanceCheck('A', 1, FAR_LAT, FAR_LON);
    const callsAfterFirst = getSettingForSource.mock.calls.length;
    autoDeleteByDistanceService.clearInlineConfigCache('A');
    await autoDeleteByDistanceService.applyInlineDistanceCheck('A', 2, FAR_LAT, FAR_LON);
    expect(getSettingForSource.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("skips ingest ('deleted') even when the delete throws", async () => {
    mockSettings();
    getNode.mockResolvedValue({ nodeNum: 6, isFavorite: false });
    deleteNodeAsync.mockRejectedValue(new Error('db down'));
    const out = await autoDeleteByDistanceService.applyInlineDistanceCheck('A', 6, FAR_LAT, FAR_LON);
    expect(out).toBe('deleted');
  });
});
