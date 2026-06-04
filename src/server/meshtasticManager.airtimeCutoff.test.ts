/**
 * Tests for the airtime-cutoff automation gate on MeshtasticManager:
 * - setAutomationAirtimeCutoffThreshold range validation
 * - getAirtimeCutoffStatus / isAutomationAirtimeGated reflect the cached
 *   local Channel Utilization vs. the configured threshold
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();

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
      getActiveNodes: vi.fn().mockResolvedValue([]),
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
    const module = await import('./meshtasticManager.js');
    manager = module.default;
    // Reset gate-related state between tests
    manager.setAutomationAirtimeCutoffThreshold(30);
    manager.localChannelUtilization = null;
    manager.lastAirtimeGateLogTime = 0;
  });

  describe('setAutomationAirtimeCutoffThreshold', () => {
    it('accepts values within 0-100', () => {
      manager.setAutomationAirtimeCutoffThreshold(45);
      expect(manager.getAirtimeCutoffStatus().threshold).toBe(45);
      manager.setAutomationAirtimeCutoffThreshold(0);
      expect(manager.getAirtimeCutoffStatus().threshold).toBe(0);
      manager.setAutomationAirtimeCutoffThreshold(100);
      expect(manager.getAirtimeCutoffStatus().threshold).toBe(100);
    });

    it('rejects out-of-range values', () => {
      expect(() => manager.setAutomationAirtimeCutoffThreshold(-1)).toThrow();
      expect(() => manager.setAutomationAirtimeCutoffThreshold(101)).toThrow();
      expect(() => manager.setAutomationAirtimeCutoffThreshold(NaN)).toThrow();
    });
  });

  describe('isAutomationAirtimeGated / getAirtimeCutoffStatus', () => {
    it('does not gate before any telemetry is seen', () => {
      manager.setAutomationAirtimeCutoffThreshold(30);
      expect(manager.localChannelUtilization).toBeNull();
      expect(manager.isAutomationAirtimeGated()).toBe(false);
      expect(manager.getAirtimeCutoffStatus()).toEqual({ threshold: 30, channelUtilization: null, gated: false });
    });

    it('gates when cached utilization exceeds the threshold', () => {
      manager.setAutomationAirtimeCutoffThreshold(30);
      manager.localChannelUtilization = 42;
      expect(manager.isAutomationAirtimeGated()).toBe(true);
      expect(manager.getAirtimeCutoffStatus()).toEqual({ threshold: 30, channelUtilization: 42, gated: true });
    });

    it('does not gate when utilization is at or below the threshold', () => {
      manager.setAutomationAirtimeCutoffThreshold(30);
      manager.localChannelUtilization = 30;
      expect(manager.isAutomationAirtimeGated()).toBe(false);
      manager.localChannelUtilization = 12;
      expect(manager.isAutomationAirtimeGated()).toBe(false);
    });

    it('never gates when the feature is disabled (threshold 0), even at high utilization', () => {
      manager.setAutomationAirtimeCutoffThreshold(0);
      manager.localChannelUtilization = 99;
      expect(manager.isAutomationAirtimeGated()).toBe(false);
      expect(manager.getAirtimeCutoffStatus().gated).toBe(false);
    });
  });
});
