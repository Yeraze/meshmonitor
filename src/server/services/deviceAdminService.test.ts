/**
 * Tests for local device-config setters + edit-session flow + config
 * marshalling (#3962 Phase 4.2a PR5 §4e).
 *
 * `DeviceAdminService` is tested against a minimal fake manager implementing
 * only the narrow public surface it depends on (`isTransportReady`,
 * `getLocalNodeInfo`, `sendLocalAdminPacket`, `updateCachedDeviceConfig`,
 * `updateCachedModuleConfig`, `getActualDeviceConfig`, `getActualModuleConfig`,
 * `isDeviceConnected`, `getConnectionAddress`, `sourceId`) — same style as
 * `favoritesService.test.ts` / `adminTransactionService.test.ts`.
 *
 * Invariant I6 (key-repair NodeInfo exchanges route on the node's channel,
 * never PKI DM) has no dedicated test in this file: none of the moved
 * methods reference a channel parameter, destination-resolution, or a DM/PKI
 * path at all — every setter builds a single admin packet addressed to the
 * local node and sends it over the transport. The channel-vs-DM branch this
 * invariant protects lives entirely in code that was NOT moved (out of scope
 * per spec §10 — protobuf dispatch / key-repair flow), so I6 is preserved by
 * non-involvement; the full Vitest suite run (meshtasticManager.positionChannel
 * .test.ts + the key-repair test family) is the actual pin for it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAllChannels = vi.fn();
const upsertNodeAsync = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    channels: {
      getAllChannels: (...args: unknown[]) => getAllChannels(...args),
    },
    upsertNodeAsync: (...args: unknown[]) => upsertNodeAsync(...args),
  },
}));

const createSetDeviceConfigMessage = vi.fn((..._args: unknown[]) => new Uint8Array([1]));
const createSetLoRaConfigMessage = vi.fn((..._args: unknown[]) => new Uint8Array([2]));
const createSetNetworkConfigMessage = vi.fn((..._args: unknown[]) => new Uint8Array([3]));
const createSetChannelMessage = vi.fn((..._args: unknown[]) => new Uint8Array([4]));
const createSetFixedPositionMessage = vi.fn((..._args: unknown[]) => new Uint8Array([5]));
const createSetPositionConfigMessage = vi.fn((..._args: unknown[]) => new Uint8Array([6]));
const createSetMQTTConfigMessage = vi.fn((..._args: unknown[]) => new Uint8Array([7]));
const createSetNeighborInfoConfigMessage = vi.fn((..._args: unknown[]) => new Uint8Array([8]));
const createSetDeviceConfigMessageGeneric = vi.fn((..._args: unknown[]) => new Uint8Array([9]));
const createSetModuleConfigMessageGeneric = vi.fn((..._args: unknown[]) => new Uint8Array([10]));
const createSetOwnerMessage = vi.fn((..._args: unknown[]) => new Uint8Array([11]));
const createBeginEditSettingsMessage = vi.fn((..._args: unknown[]) => new Uint8Array([12]));
const createCommitEditSettingsMessage = vi.fn((..._args: unknown[]) => new Uint8Array([13]));
const createAdminPacket = vi.fn((...args: unknown[]) => args[0] as Uint8Array);

vi.mock('../protobufService.js', () => ({
  default: {
    createSetDeviceConfigMessage: (...args: unknown[]) => createSetDeviceConfigMessage(...args),
    createSetLoRaConfigMessage: (...args: unknown[]) => createSetLoRaConfigMessage(...args),
    createSetNetworkConfigMessage: (...args: unknown[]) => createSetNetworkConfigMessage(...args),
    createSetChannelMessage: (...args: unknown[]) => createSetChannelMessage(...args),
    createSetFixedPositionMessage: (...args: unknown[]) => createSetFixedPositionMessage(...args),
    createSetPositionConfigMessage: (...args: unknown[]) => createSetPositionConfigMessage(...args),
    createSetMQTTConfigMessage: (...args: unknown[]) => createSetMQTTConfigMessage(...args),
    createSetNeighborInfoConfigMessage: (...args: unknown[]) => createSetNeighborInfoConfigMessage(...args),
    createSetDeviceConfigMessageGeneric: (...args: unknown[]) => createSetDeviceConfigMessageGeneric(...args),
    createSetModuleConfigMessageGeneric: (...args: unknown[]) => createSetModuleConfigMessageGeneric(...args),
    createSetOwnerMessage: (...args: unknown[]) => createSetOwnerMessage(...args),
    createBeginEditSettingsMessage: (...args: unknown[]) => createBeginEditSettingsMessage(...args),
    createCommitEditSettingsMessage: (...args: unknown[]) => createCommitEditSettingsMessage(...args),
    createAdminPacket: (...args: unknown[]) => createAdminPacket(...args),
  },
}));

import { DeviceAdminService } from './deviceAdminService.js';

/** Minimal fake implementing only what DeviceAdminService touches on the manager. */
function makeFakeManager(overrides: Partial<{
  sourceId: string;
  transportReady: boolean;
  deviceConnected: boolean;
  localNodeInfo: { nodeNum: number; longName?: string; nodeId?: string; firmwareVersion?: string } | null;
  actualDeviceConfig: any;
  actualModuleConfig: any;
}> = {}) {
  const state = {
    sourceId: overrides.sourceId ?? 'src-1',
    transportReady: overrides.transportReady ?? true,
    deviceConnected: overrides.deviceConnected ?? true,
    localNodeInfo: overrides.localNodeInfo === undefined ? { nodeNum: 111, nodeId: '!0000006f', longName: 'Test Node', firmwareVersion: '2.7.24' } : overrides.localNodeInfo,
    actualDeviceConfig: overrides.actualDeviceConfig ?? null,
    actualModuleConfig: overrides.actualModuleConfig ?? null,
  };

  return {
    state,
    sourceId: state.sourceId,
    isTransportReady: vi.fn(() => state.transportReady),
    isDeviceConnected: vi.fn(() => state.deviceConnected),
    getLocalNodeInfo: vi.fn(() => state.localNodeInfo),
    sendLocalAdminPacket: vi.fn().mockResolvedValue(undefined),
    updateCachedDeviceConfig: vi.fn((section: string, values: Record<string, any>) => {
      state.actualDeviceConfig = { ...state.actualDeviceConfig, [section]: { ...state.actualDeviceConfig?.[section], ...values } };
    }),
    updateCachedModuleConfig: vi.fn((section: string, values: Record<string, any>) => {
      state.actualModuleConfig = { ...state.actualModuleConfig, [section]: { ...state.actualModuleConfig?.[section], ...values } };
    }),
    getActualDeviceConfig: vi.fn(() => state.actualDeviceConfig),
    getActualModuleConfig: vi.fn(() => state.actualModuleConfig),
    getConnectionAddress: vi.fn().mockResolvedValue({ nodeIp: '10.0.0.5', tcpPort: 4403 }),
  };
}

describe('DeviceAdminService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllChannels.mockResolvedValue([]);
    upsertNodeAsync.mockResolvedValue(undefined);
  });

  describe('setter round-trip', () => {
    it('setDeviceConfig throws when transport is not ready', async () => {
      const mgr = makeFakeManager({ transportReady: false });
      const svc = new DeviceAdminService(mgr as any);
      await expect(svc.setDeviceConfig({ role: 1 })).rejects.toThrow('Not connected to Meshtastic node');
      expect(mgr.sendLocalAdminPacket).not.toHaveBeenCalled();
    });

    it('setDeviceConfig builds an admin packet and sends it over the manager transport', async () => {
      const mgr = makeFakeManager();
      const svc = new DeviceAdminService(mgr as any);
      await svc.setDeviceConfig({ role: 1 });
      expect(createSetDeviceConfigMessage).toHaveBeenCalledWith({ role: 1 }, expect.any(Uint8Array));
      expect(createAdminPacket).toHaveBeenCalledWith(expect.any(Uint8Array), 111, 111);
      expect(mgr.sendLocalAdminPacket).toHaveBeenCalledTimes(1);
    });

    it('setLoRaConfig sends the packet and updates the cached device config', async () => {
      const mgr = makeFakeManager();
      const svc = new DeviceAdminService(mgr as any);
      await svc.setLoRaConfig({ region: 1 });
      expect(mgr.sendLocalAdminPacket).toHaveBeenCalledTimes(1);
      expect(mgr.updateCachedDeviceConfig).toHaveBeenCalledWith('lora', { region: 1 });
    });

    it('setChannelConfig rejects an out-of-range channel index without sending', async () => {
      const mgr = makeFakeManager();
      const svc = new DeviceAdminService(mgr as any);
      await expect(svc.setChannelConfig(8, {})).rejects.toThrow('Channel index must be between 0 and 7');
      expect(mgr.sendLocalAdminPacket).not.toHaveBeenCalled();
    });

    it('setPositionConfig with coordinates writes the DB position then sends the fixed-position and config packets', async () => {
      const mgr = makeFakeManager();
      const svc = new DeviceAdminService(mgr as any);
      await svc.setPositionConfig({ latitude: 1.5, longitude: 2.5, altitude: 10, positionBroadcastSecs: 900 });

      expect(upsertNodeAsync).toHaveBeenCalledWith(
        expect.objectContaining({ nodeNum: 111, latitude: 1.5, longitude: 2.5, altitude: 10 }),
        'src-1'
      );
      // One packet for set_fixed_position, one for the position config itself.
      expect(mgr.sendLocalAdminPacket).toHaveBeenCalledTimes(2);
      expect(mgr.updateCachedDeviceConfig).toHaveBeenCalledWith('position', { positionBroadcastSecs: 900 });
    });

    it('setTelemetryConfig updates actualModuleConfig via updateCachedModuleConfig (not updateCachedDeviceConfig)', async () => {
      const mgr = makeFakeManager();
      const svc = new DeviceAdminService(mgr as any);
      await svc.setTelemetryConfig({ deviceUpdateInterval: 900 });
      expect(mgr.updateCachedModuleConfig).toHaveBeenCalledWith('telemetry', { deviceUpdateInterval: 900 });
      expect(mgr.updateCachedDeviceConfig).not.toHaveBeenCalled();
    });

    it('setNodeOwner builds a set_owner admin message', async () => {
      const mgr = makeFakeManager();
      const svc = new DeviceAdminService(mgr as any);
      await svc.setNodeOwner('Long Name', 'SN', true, false);
      expect(createSetOwnerMessage).toHaveBeenCalledWith('Long Name', 'SN', true, expect.any(Uint8Array), false);
      expect(mgr.sendLocalAdminPacket).toHaveBeenCalledTimes(1);
    });
  });

  describe('edit-session begin/commit ordering', () => {
    it('beginEditSettings sends before commitEditSettings when awaited in sequence', async () => {
      vi.useFakeTimers();
      try {
        const mgr = makeFakeManager();
        const svc = new DeviceAdminService(mgr as any);

        await svc.beginEditSettings();
        expect(createBeginEditSettingsMessage).toHaveBeenCalledTimes(1);
        expect(createCommitEditSettingsMessage).not.toHaveBeenCalled();

        const commitPromise = svc.commitEditSettings();
        // commitEditSettings waits ~2s after sending before resolving (flash-save delay).
        await vi.advanceTimersByTimeAsync(2000);
        await commitPromise;

        expect(createCommitEditSettingsMessage).toHaveBeenCalledTimes(1);
        // begin's send happened strictly before commit's send.
        const beginCallOrder = (mgr.sendLocalAdminPacket as any).mock.invocationCallOrder[0];
        const commitCallOrder = (mgr.sendLocalAdminPacket as any).mock.invocationCallOrder[1];
        expect(beginCallOrder).toBeLessThan(commitCallOrder);
      } finally {
        vi.useRealTimers();
      }
    });

    it('commitEditSettings throws without sending when transport is not ready', async () => {
      const mgr = makeFakeManager({ transportReady: false });
      const svc = new DeviceAdminService(mgr as any);
      await expect(svc.commitEditSettings()).rejects.toThrow('Not connected to Meshtastic node');
      expect(mgr.sendLocalAdminPacket).not.toHaveBeenCalled();
    });
  });

  describe('buildDeviceConfigFromActual', () => {
    it('marshals cached actual config + DB channels into the Configuration-tab shape', async () => {
      const mgr = makeFakeManager({
        actualDeviceConfig: { lora: { region: 1, modemPreset: 0, channelNum: 20, bandwidth: 250 } },
        actualModuleConfig: { mqtt: { enabled: true, address: 'mqtt.example.com' } },
      });
      getAllChannels.mockResolvedValue([
        { id: 0, name: 'Primary', psk: 'AQ==', role: 1, uplinkEnabled: true, downlinkEnabled: true, positionPrecision: 32 },
      ]);
      const svc = new DeviceAdminService(mgr as any);

      const config = await svc.buildDeviceConfigFromActual();

      expect(config.basic).toEqual({
        nodeAddress: '10.0.0.5',
        tcpPort: 4403,
        connected: true,
        nodeId: '!0000006f',
        nodeName: 'Test Node',
        firmwareVersion: '2.7.24',
      });
      expect(config.radio.region).toBe('US');
      expect(config.mqtt.enabled).toBe(true);
      expect(config.mqtt.server).toBe('mqtt.example.com');
      expect(config.channels).toHaveLength(1);
      expect(config.channels[0]).toMatchObject({ index: 0, name: 'Primary' });
    });

    it('falls back to the single default Primary channel when the DB has none', async () => {
      const mgr = makeFakeManager();
      getAllChannels.mockResolvedValue([]);
      const svc = new DeviceAdminService(mgr as any);

      const config = await svc.buildDeviceConfigFromActual();

      expect(config.channels).toEqual([
        { index: 0, name: 'Primary', psk: 'None', uplinkEnabled: true, downlinkEnabled: true },
      ]);
    });
  });
});
