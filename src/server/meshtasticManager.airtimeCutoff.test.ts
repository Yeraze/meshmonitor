/**
 * Tests for the airtime-cutoff automation gate on MeshtasticManager:
 * - setAutomationAirtimeCutoffThreshold range validation
 * - getAirtimeCutoffStatus / isAutomationAirtimeGated reflect the effective
 *   Channel Utilization (local node, or neighbour-averaged) vs. the threshold
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockGetActiveNodes = vi.fn();
const mockGetLatestSamples = vi.fn();
const mockGetSettingForSource = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    settings: {
      getSetting: mockGetSetting,
      setSetting: mockSetSetting,
      getSettingForSource: mockGetSettingForSource,
      setSettingForSource: vi.fn((_sourceId: string, key: string, value: string) => mockSetSetting(key, value)),
    },
    nodes: {
      getAllNodes: vi.fn().mockResolvedValue([]),
      getActiveNodes: mockGetActiveNodes,
    },
    telemetry: {
      insertTelemetry: vi.fn().mockResolvedValue(undefined),
      getLatestTelemetrySampleForAllNodes: mockGetLatestSamples,
    },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Loaded once while the file is collected, not inside a hook. A dynamic import in
// `beforeEach` charged the manager's module load (~2 s idle, 10 s+ on a busy
// host) to the first test's hook budget; collection has no such budget.
const managerModule = await import('./meshtasticManager.js');

describe('MeshtasticManager - airtime cutoff gate', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetActiveNodes.mockResolvedValue([]);
    mockGetLatestSamples.mockResolvedValue(new Map());
    mockGetSettingForSource.mockImplementation((_sourceId: string, key: string) => mockGetSetting(key));
    manager = managerModule.fallbackManager;
    // Reset gate-related state between tests
    manager.setAutomationAirtimeCutoffThreshold(30);
    manager.setAutomationAirtimeCutoffSource('local');
    manager.setAutomationAirtimeCutoffNeighborSelection({ mode: 'auto', sampleCount: 3, nodes: '[]' });
    manager.localChannelUtilization = null;
    manager.neighborUtilCache = null;
    manager.lastAirtimeGateLogTime = 0;
    manager.localNodeInfo = { nodeNum: 0x11111111 };
  });

  describe('setAutomationAirtimeCutoffThreshold', () => {
    it('accepts values within 0-100', async () => {
      manager.setAutomationAirtimeCutoffThreshold(45);
      expect((await manager.getAirtimeCutoffStatus()).threshold).toBe(45);
      manager.setAutomationAirtimeCutoffThreshold(0);
      expect((await manager.getAirtimeCutoffStatus()).threshold).toBe(0);
      manager.setAutomationAirtimeCutoffThreshold(100);
      expect((await manager.getAirtimeCutoffStatus()).threshold).toBe(100);
    });

    it('rejects out-of-range values', () => {
      expect(() => manager.setAutomationAirtimeCutoffThreshold(-1)).toThrow();
      expect(() => manager.setAutomationAirtimeCutoffThreshold(101)).toThrow();
      expect(() => manager.setAutomationAirtimeCutoffThreshold(NaN)).toThrow();
    });
  });

  describe('local source', () => {
    it('does not gate before any telemetry is seen', async () => {
      manager.setAutomationAirtimeCutoffThreshold(30);
      expect(manager.localChannelUtilization).toBeNull();
      expect(await manager.isAutomationAirtimeGated()).toBe(false);
      expect(await manager.getAirtimeCutoffStatus()).toEqual({
        threshold: 30, source: 'local', neighborMaxHops: 0, channelUtilization: null, sampleCount: 0, contributors: [], gated: false,
      });
    });

    it('gates when the local utilization exceeds the threshold', async () => {
      manager.setAutomationAirtimeCutoffThreshold(30);
      manager.localChannelUtilization = 42;
      expect(await manager.isAutomationAirtimeGated()).toBe(true);
      expect(await manager.getAirtimeCutoffStatus()).toEqual({
        threshold: 30, source: 'local', neighborMaxHops: 0, channelUtilization: 42, sampleCount: 1, contributors: [], gated: true,
      });
    });

    it('does not gate at or below the threshold', async () => {
      manager.setAutomationAirtimeCutoffThreshold(30);
      manager.localChannelUtilization = 30;
      expect(await manager.isAutomationAirtimeGated()).toBe(false);
      manager.localChannelUtilization = 12;
      expect(await manager.isAutomationAirtimeGated()).toBe(false);
    });

    it('never gates when disabled (threshold 0), even at high utilization', async () => {
      manager.setAutomationAirtimeCutoffThreshold(0);
      manager.localChannelUtilization = 99;
      expect(await manager.isAutomationAirtimeGated()).toBe(false);
      expect((await manager.getAirtimeCutoffStatus()).gated).toBe(false);
    });

    it('does not query neighbours in local mode', async () => {
      manager.localChannelUtilization = 10;
      await manager.isAutomationAirtimeGated();
      expect(mockGetActiveNodes).not.toHaveBeenCalled();
    });
  });

  describe('neighbours source', () => {
    const node = (over: any) => ({ nodeNum: 0x22220000 + (over.b ?? 0), role: 2, hopsAway: 0, rssi: -60, channelUtilization: 40, ...over });

    it('averages the strongest-RSSI 0-hop infrastructure neighbours', async () => {
      manager.setAutomationAirtimeCutoffSource('neighbors');
      manager.setAutomationAirtimeCutoffThreshold(30);
      // Local ChUtil is low; neighbours are busy → neighbour mode should gate.
      manager.localChannelUtilization = 5;
      mockGetActiveNodes.mockResolvedValue([
        node({ b: 1, rssi: -50, channelUtilization: 50 }), // strongest
        node({ b: 2, rssi: -60, channelUtilization: 40 }),
        node({ b: 3, rssi: -70, channelUtilization: 30 }),
        node({ b: 4, rssi: -90, channelUtilization: 0 }),  // 4th strongest → excluded
        node({ b: 5, role: 0, rssi: -40, channelUtilization: 99 }), // client → excluded
        node({ b: 6, hopsAway: 2, rssi: -40, channelUtilization: 99 }), // not 0-hop → excluded
      ]);

      const status = await manager.getAirtimeCutoffStatus();
      expect(status.source).toBe('neighbors');
      expect(status.sampleCount).toBe(3);
      expect(status.channelUtilization).toBeCloseTo((50 + 40 + 30) / 3); // 40
      expect(status.gated).toBe(true); // 40 > 30
      expect(mockGetActiveNodes).toHaveBeenCalled();
      // The 3 contributing infrastructure nodes are surfaced, strongest RSSI first.
      expect(status.contributors).toHaveLength(3);
      expect(status.contributors.map((c) => c.rssi)).toEqual([-50, -60, -70]);
      expect(status.contributors[0]).toMatchObject({ nodeNum: 0x22220001, channelUtilization: 50 });
    });

    it('uses the local ChUtil when no infrastructure neighbours qualify (#6007)', async () => {
      manager.setAutomationAirtimeCutoffSource('neighbors');
      manager.localChannelUtilization = 99;
      mockGetActiveNodes.mockResolvedValue([
        { nodeNum: 0x33330001, role: 0, hopsAway: 0, rssi: -50, channelUtilization: 80 }, // client
      ]);
      const status = await manager.getAirtimeCutoffStatus();
      expect(status.channelUtilization).toBe(99);
      expect(status.sampleCount).toBe(0);
      expect(status.localUsed).toBe('no_neighbors');
      expect(status.gated).toBe(true);
    });

    it('keeps the no-gate behaviour when neither neighbours nor local ChUtil are known', async () => {
      manager.setAutomationAirtimeCutoffSource('neighbors');
      manager.localChannelUtilization = null;
      const status = await manager.getAirtimeCutoffStatus();
      expect(status.channelUtilization).toBeNull();
      expect(status.gated).toBe(false);
    });

    it('caches the neighbour computation (one query per TTL)', async () => {
      manager.setAutomationAirtimeCutoffSource('neighbors');
      mockGetActiveNodes.mockResolvedValue([node({ b: 1 })]);
      await manager.isAutomationAirtimeGated();
      await manager.isAutomationAirtimeGated();
      await manager.getAirtimeCutoffStatus();
      expect(mockGetActiveNodes).toHaveBeenCalledTimes(1);
    });

    it('excludes the local node from the neighbour set', async () => {
      manager.setAutomationAirtimeCutoffSource('neighbors');
      manager.localNodeInfo = { nodeNum: 0x22220001 };
      mockGetActiveNodes.mockResolvedValue([
        { nodeNum: 0x22220001, role: 2, hopsAway: 0, rssi: -50, channelUtilization: 90 }, // local — excluded
      ]);
      const status = await manager.getAirtimeCutoffStatus();
      expect(status.sampleCount).toBe(0);
      expect(status.channelUtilization).toBeNull();
    });
  });

  describe('issue #6007: selection mode, sample count, MQTT exclusion', () => {
    const NOW = Date.now();
    const node = (b: number, over: any = {}) => ({
      nodeNum: 0x44440000 + b, nodeId: `!4444000${b}`, longName: `R${b}`, role: 2, hopsAway: 0, rssi: -60 - b, channelUtilization: 40, viaMqtt: false, ...over,
    });

    it('excludes MQTT-heard routers from the auto average', async () => {
      manager.setAutomationAirtimeCutoffSource('neighbors');
      mockGetActiveNodes.mockResolvedValue([
        node(1, { viaMqtt: true, rssi: -20, channelUtilization: 1 }),
        node(2), node(3), node(4),
      ]);
      const status = await manager.getAirtimeCutoffStatus();
      expect(status.contributors.map((c: any) => c.nodeNum)).toEqual([0x44440002, 0x44440003, 0x44440004]);
      expect(status.channelUtilization).toBe(40);
    });

    it('honours a user sample count of 5 and clamps out-of-range values', async () => {
      manager.setAutomationAirtimeCutoffSource('neighbors');
      mockGetActiveNodes.mockResolvedValue([1, 2, 3, 4, 5, 6].map((b) => node(b)));
      manager.setAutomationAirtimeCutoffNeighborSelection({ sampleCount: 5 });
      expect((await manager.getAirtimeCutoffStatus()).sampleCount).toBe(5);
      manager.setAutomationAirtimeCutoffNeighborSelection({ sampleCount: 12 });
      expect((await manager.getAirtimeCutoffStatus()).neighborSampleCount).toBe(5);
      manager.setAutomationAirtimeCutoffNeighborSelection({ sampleCount: 1 });
      const s = await manager.getAirtimeCutoffStatus();
      expect(s.neighborSampleCount).toBe(3);
      expect(s.sampleCount).toBe(3);
    });

    it('manual mode averages only fresh picks and reports the rest', async () => {
      manager.setAutomationAirtimeCutoffSource('neighbors');
      manager.localChannelUtilization = 10;
      mockGetActiveNodes.mockResolvedValue([
        node(1, { channelUtilization: 20 }),
        node(2, { channelUtilization: 30 }),
        node(3, { channelUtilization: 90 }), // stale sample
        node(4, { viaMqtt: true }),
        node(5, { rssi: -10, channelUtilization: 99 }), // strongest, not picked
      ]);
      mockGetLatestSamples.mockResolvedValue(new Map([
        ['!44440001', { value: 20, timestamp: NOW - 60_000 }],
        ['!44440002', { value: 30, timestamp: NOW - 60_000 }],
        ['!44440003', { value: 90, timestamp: NOW - 4 * 60 * 60 * 1000 }],
        ['!44440004', { value: 40, timestamp: NOW }],
        ['!44440005', { value: 99, timestamp: NOW }],
      ]));
      manager.setAutomationAirtimeCutoffNeighborSelection({
        mode: 'manual',
        nodes: JSON.stringify([0x44440001, 0x44440002, 0x44440003, 0x44440004]),
      });
      const status = await manager.getAirtimeCutoffStatus();
      expect(status.neighborMode).toBe('manual');
      expect(status.contributors.map((c: any) => c.nodeNum)).toEqual([0x44440001, 0x44440002]);
      expect(status.channelUtilization).toBe(25); // local 10 is lower
      expect(status.targetCount).toBe(4);
      expect(status.localUsed).toBeNull();
      expect(status.skipped.map((s: any) => [s.nodeNum, s.reason])).toEqual([
        [0x44440003, 'stale'], [0x44440004, 'mqtt'],
      ]);
      expect(mockGetLatestSamples).toHaveBeenCalledWith('channelUtilization', manager.sourceId);
    });

    it('manual mode uses the local ChUtil when it is higher than a short average', async () => {
      manager.setAutomationAirtimeCutoffSource('neighbors');
      manager.localChannelUtilization = 31;
      mockGetActiveNodes.mockResolvedValue([node(1, { channelUtilization: 18 })]);
      mockGetLatestSamples.mockResolvedValue(new Map([['!44440001', { value: 18, timestamp: NOW }]]));
      manager.setAutomationAirtimeCutoffNeighborSelection({ mode: 'manual', nodes: '[1145307137, 2, 3]' });
      const status = await manager.getAirtimeCutoffStatus();
      expect(status.channelUtilization).toBe(31);
      expect(status.neighborAverage).toBe(18);
      expect(status.localUsed).toBe('higher_than_neighbors');
      expect(status.gated).toBe(true);
    });

    it('lists only non-MQTT infrastructure nodes as picker candidates', async () => {
      mockGetActiveNodes.mockResolvedValue([
        node(1, { hopsAway: 2 }),
        node(2, { viaMqtt: true }),
        node(3, { role: 0 }),
        node(4, { role: 12, hopsAway: 0 }),
        { ...node(9), nodeNum: 0x11111111 }, // the local node
      ]);
      mockGetLatestSamples.mockResolvedValue(new Map([['!44440001', { value: 12, timestamp: 123 }]]));
      const list = await manager.getAirtimeCutoffCandidates();
      expect(list.map((c: any) => c.nodeNum)).toEqual([0x44440004, 0x44440001]);
      expect(list[1]).toMatchObject({ role: 2, hopsAway: 2, channelUtilization: 40, channelUtilizationAt: 123 });
    });

    it('loads the new settings per source with defaults and clamps', async () => {
      const stored: Record<string, string> = {
        automationAirtimeCutoffSource: 'neighbors',
        automationAirtimeCutoffNeighborMode: 'manual',
        automationAirtimeCutoffNeighborSampleCount: '9',
        automationAirtimeCutoffNeighborNodes: '[1,2,3,4,5,6]',
      };
      mockGetSettingForSource.mockImplementation((_s: string, key: string) => Promise.resolve(stored[key] ?? null));
      await manager.loadAirtimeCutoffSettings();
      for (const key of Object.keys(stored)) {
        expect(mockGetSettingForSource).toHaveBeenCalledWith(manager.sourceId, key);
      }
      let status = await manager.getAirtimeCutoffStatus();
      expect(status.neighborMode).toBe('manual');
      expect(status.neighborSampleCount).toBe(5);
      expect(status.neighborNodes).toEqual([1, 2, 3, 4, 5]);

      mockGetSettingForSource.mockImplementation((_s: string, key: string) =>
        Promise.resolve(key === 'automationAirtimeCutoffSource' ? 'neighbors' : null));
      await manager.loadAirtimeCutoffSettings();
      status = await manager.getAirtimeCutoffStatus();
      expect(status.neighborMode).toBe('auto');
      expect(status.neighborSampleCount).toBe(3);
      expect(status.neighborNodes).toEqual([]);
    });
  });
});
