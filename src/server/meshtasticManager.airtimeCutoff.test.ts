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

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    settings: {
      getSetting: mockGetSetting,
      setSetting: mockSetSetting,
      getSettingForSource: vi.fn((_sourceId: string, key: string) => mockGetSetting(key)),
      setSettingForSource: vi.fn((_sourceId: string, key: string, value: string) => mockSetSetting(key, value)),
    },
    nodes: {
      getAllNodes: vi.fn().mockResolvedValue([]),
      getActiveNodes: mockGetActiveNodes,
    },
    telemetry: { insertTelemetry: vi.fn().mockResolvedValue(undefined) },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('MeshtasticManager - airtime cutoff gate', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetActiveNodes.mockResolvedValue([]);
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    // Reset gate-related state between tests
    manager.setAutomationAirtimeCutoffThreshold(30);
    manager.setAutomationAirtimeCutoffSource('local');
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
        threshold: 30, source: 'local', channelUtilization: null, sampleCount: 0, contributors: [], gated: false,
      });
    });

    it('gates when the local utilization exceeds the threshold', async () => {
      manager.setAutomationAirtimeCutoffThreshold(30);
      manager.localChannelUtilization = 42;
      expect(await manager.isAutomationAirtimeGated()).toBe(true);
      expect(await manager.getAirtimeCutoffStatus()).toEqual({
        threshold: 30, source: 'local', channelUtilization: 42, sampleCount: 1, contributors: [], gated: true,
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

    it('falls back to no-gate when no infrastructure neighbours qualify', async () => {
      manager.setAutomationAirtimeCutoffSource('neighbors');
      manager.localChannelUtilization = 99; // local is high but ignored in neighbour mode
      mockGetActiveNodes.mockResolvedValue([
        { nodeNum: 0x33330001, role: 0, hopsAway: 0, rssi: -50, channelUtilization: 80 }, // client
      ]);
      const status = await manager.getAirtimeCutoffStatus();
      expect(status.channelUtilization).toBeNull();
      expect(status.sampleCount).toBe(0);
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
});
