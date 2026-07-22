/**
 * Tests for NodeDB maintenance operations (#3962 Phase 4.2a PR2 §4f).
 *
 * `mapDbNodeToDeviceInfo` is a pure function — tested directly, including the
 * BIGINT-coercion pin (CLAUDE.md multi-DB rule): `nodeNum` passes through as
 * whatever type the (already-normalized) DB row provides, with no accidental
 * stringification/boxing along the way.
 *
 * `NodeDbMaintenanceService` is tested against a minimal fake implementing
 * only the narrow public surface it depends on (mirrors the real
 * MeshtasticManager accessors added for this extraction:
 * `isTransportReady`/`isDeviceConnected`/`getLocalNodeInfo`/
 * `sendLocalAdminPacket`/`removeDeviceNodeNum`/`connect`/`sendWantConfigId`/
 * `requestAllModuleConfigs`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getLatestTelemetryValueForAllNodes = vi.fn();
const getAllNodes = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    telemetry: {
      getLatestTelemetryValueForAllNodes: (...args: unknown[]) => getLatestTelemetryValueForAllNodes(...args),
    },
    nodes: {
      getAllNodes: (...args: unknown[]) => getAllNodes(...args),
    },
  },
}));

const createPurgeNodeDbMessage = vi.fn();
const createAdminPacket = vi.fn();
const createRemoveNodeMessage = vi.fn();

vi.mock('../protobufService.js', () => ({
  default: {
    createPurgeNodeDbMessage: (...args: unknown[]) => createPurgeNodeDbMessage(...args),
    createAdminPacket: (...args: unknown[]) => createAdminPacket(...args),
    createRemoveNodeMessage: (...args: unknown[]) => createRemoveNodeMessage(...args),
  },
}));

import { mapDbNodeToDeviceInfo, NodeDbMaintenanceService } from './nodeDbMaintenanceService.js';

describe('mapDbNodeToDeviceInfo', () => {
  it('passes nodeNum through verbatim (BIGINT coercion happens upstream in the repository, not here)', () => {
    const node = {
      nodeNum: 123456789,
      nodeId: '!075bcd15',
      longName: 'Test Node',
      shortName: 'TST',
    };
    const result = mapDbNodeToDeviceInfo(node);
    expect(result.nodeNum).toBe(123456789);
    expect(typeof result.nodeNum).toBe('number');
  });

  it('maps core user/device fields', () => {
    const node = {
      nodeNum: 42,
      nodeId: '!0000002a',
      longName: 'Alpha',
      shortName: 'A1',
      hwModel: 9,
      batteryLevel: 87,
      lastHeard: 1000,
      snr: 5.5,
      rssi: -90,
    };
    const result: any = mapDbNodeToDeviceInfo(node, 3600, -110);
    expect(result.user?.longName).toBe('Alpha');
    expect(result.user?.shortName).toBe('A1');
    expect(result.deviceMetrics?.batteryLevel).toBe(87);
    expect(result.deviceMetrics?.uptimeSeconds).toBe(3600);
    // `noiseFloor` is populated at runtime but not declared on the DeviceInfo
    // interface (pre-existing gap, same as isFavorite/keyIsLowEntropy/etc.).
    expect(result.deviceMetrics?.noiseFloor).toBe(-110);
    expect(result.lastHeard).toBe(1000);
    expect(result.snr).toBe(5.5);
    expect(result.rssi).toBe(-90);
  });

  it('omits optional fields the row does not carry, and includes boolean flags only when present', () => {
    const node = { nodeNum: 1, nodeId: '!00000001', longName: '', shortName: '' };
    const result: any = mapDbNodeToDeviceInfo(node);
    expect(result.isFavorite).toBeUndefined();
    expect(result.position).toBeUndefined();

    const withFlags = { ...node, isFavorite: 1, isIgnored: 0, latitude: 1.5, longitude: 2.5, altitude: 10 };
    const result2: any = mapDbNodeToDeviceInfo(withFlags);
    expect(result2.isFavorite).toBe(true);
    expect(result2.isIgnored).toBe(false);
    expect(result2.position).toEqual({ latitude: 1.5, longitude: 2.5, altitude: 10 });
  });
});

/** Minimal fake implementing only what NodeDbMaintenanceService touches. */
function makeFakeManager(overrides: Partial<{
  transportReady: boolean;
  deviceConnected: boolean;
  localNodeInfo: { nodeNum: number; isLocked?: boolean } | null;
}> = {}) {
  const state = {
    transportReady: overrides.transportReady ?? true,
    deviceConnected: overrides.deviceConnected ?? true,
    localNodeInfo: overrides.localNodeInfo === undefined
      ? { nodeNum: 111, isLocked: true }
      : overrides.localNodeInfo,
  };
  return {
    state,
    isTransportReady: vi.fn(() => state.transportReady),
    isDeviceConnected: vi.fn(() => state.deviceConnected),
    getLocalNodeInfo: vi.fn(() => state.localNodeInfo),
    sendLocalAdminPacket: vi.fn().mockResolvedValue(undefined),
    removeDeviceNodeNum: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    sendWantConfigId: vi.fn().mockResolvedValue(undefined),
    requestAllModuleConfigs: vi.fn().mockResolvedValue(undefined),
  };
}

describe('NodeDbMaintenanceService', () => {
  beforeEach(() => {
    getLatestTelemetryValueForAllNodes.mockReset().mockResolvedValue(new Map());
    getAllNodes.mockReset().mockResolvedValue([]);
    createPurgeNodeDbMessage.mockReset().mockReturnValue(new Uint8Array([1]));
    createAdminPacket.mockReset().mockReturnValue(new Uint8Array([2]));
    createRemoveNodeMessage.mockReset().mockReturnValue(new Uint8Array([3]));
  });

  describe('purgeNodeDb', () => {
    it('throws without building/sending anything when the transport is not ready', async () => {
      const mgr = makeFakeManager({ transportReady: false });
      const svc = new NodeDbMaintenanceService(mgr as any);

      await expect(svc.purgeNodeDb(5)).rejects.toThrow('Not connected to Meshtastic node');
      expect(createPurgeNodeDbMessage).not.toHaveBeenCalled();
      expect(mgr.sendLocalAdminPacket).not.toHaveBeenCalled();
    });

    it('builds the purge message and sends it via the manager when ready', async () => {
      const mgr = makeFakeManager();
      const svc = new NodeDbMaintenanceService(mgr as any);

      await svc.purgeNodeDb(30);
      expect(createPurgeNodeDbMessage).toHaveBeenCalledWith(30);
      expect(createAdminPacket).toHaveBeenCalledWith(expect.any(Uint8Array), 111, 111);
      expect(mgr.sendLocalAdminPacket).toHaveBeenCalledWith(expect.any(Uint8Array));
    });

    it('defaults seconds to 0', async () => {
      const mgr = makeFakeManager();
      const svc = new NodeDbMaintenanceService(mgr as any);
      await svc.purgeNodeDb();
      expect(createPurgeNodeDbMessage).toHaveBeenCalledWith(0);
    });
  });

  describe('sendRemoveNode', () => {
    it('throws when the transport is not ready', async () => {
      const mgr = makeFakeManager({ transportReady: false });
      const svc = new NodeDbMaintenanceService(mgr as any);
      await expect(svc.sendRemoveNode(999)).rejects.toThrow('Not connected to Meshtastic node');
    });

    it('throws when local node info is unavailable', async () => {
      const mgr = makeFakeManager({ localNodeInfo: null });
      const svc = new NodeDbMaintenanceService(mgr as any);
      await expect(svc.sendRemoveNode(999)).rejects.toThrow('Local node information not available');
    });

    it('sends the remove-node admin packet and drops the node from device tracking (#3914-adjacent state)', async () => {
      const mgr = makeFakeManager();
      const svc = new NodeDbMaintenanceService(mgr as any);

      await svc.sendRemoveNode(999);
      expect(createRemoveNodeMessage).toHaveBeenCalledWith(999, expect.any(Uint8Array));
      expect(mgr.sendLocalAdminPacket).toHaveBeenCalled();
      expect(mgr.removeDeviceNodeNum).toHaveBeenCalledWith(999);
    });

    it('propagates a transport send failure without removing device tracking', async () => {
      const mgr = makeFakeManager();
      mgr.sendLocalAdminPacket.mockRejectedValue(new Error('boom'));
      const svc = new NodeDbMaintenanceService(mgr as any);

      await expect(svc.sendRemoveNode(1)).rejects.toThrow('boom');
      expect(mgr.removeDeviceNodeNum).not.toHaveBeenCalled();
    });
  });

  describe('refreshNodeDatabase', () => {
    it('reconnects when not connected, clears the localNodeInfo lock, and requests config', async () => {
      vi.useFakeTimers();
      const localNodeInfo = { nodeNum: 111, isLocked: true };
      const mgr = makeFakeManager({ deviceConnected: false, localNodeInfo });
      const svc = new NodeDbMaintenanceService(mgr as any);

      await svc.refreshNodeDatabase();

      expect(mgr.connect).toHaveBeenCalled();
      expect(localNodeInfo.isLocked).toBe(false);
      expect(mgr.sendWantConfigId).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(mgr.requestAllModuleConfigs).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('does not reconnect when already connected', async () => {
      vi.useFakeTimers();
      const mgr = makeFakeManager({ deviceConnected: true });
      const svc = new NodeDbMaintenanceService(mgr as any);

      await svc.refreshNodeDatabase();
      expect(mgr.connect).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('getAllNodesAsync', () => {
    it('delegates to databaseService with the given sourceId (no cross-source merge)', async () => {
      getAllNodes.mockResolvedValue([{ nodeNum: 7, nodeId: '!00000007', longName: 'N7', shortName: 'N7' }]);
      const mgr = makeFakeManager();
      const svc = new NodeDbMaintenanceService(mgr as any);

      const result = await svc.getAllNodesAsync('source-A');
      expect(getAllNodes).toHaveBeenCalledWith('source-A');
      expect(result).toHaveLength(1);
      expect(result[0].nodeNum).toBe(7);
    });

    it('passes uptime/noise-floor telemetry maps through to the mapper', async () => {
      getAllNodes.mockResolvedValue([{ nodeNum: 7, nodeId: '!00000007', longName: '', shortName: '' }]);
      getLatestTelemetryValueForAllNodes.mockImplementation((type: string) => {
        if (type === 'uptimeSeconds') return Promise.resolve(new Map([['!00000007', 500]]));
        if (type === 'noiseFloor') return Promise.resolve(new Map([['!00000007', -95]]));
        return Promise.resolve(new Map());
      });
      const mgr = makeFakeManager();
      const svc = new NodeDbMaintenanceService(mgr as any);

      const result: any[] = await svc.getAllNodesAsync('source-A');
      expect(result[0].deviceMetrics?.uptimeSeconds).toBe(500);
      expect(result[0].deviceMetrics?.noiseFloor).toBe(-95);
    });
  });
});
