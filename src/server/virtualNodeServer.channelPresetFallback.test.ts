/**
 * Regression test for issue #4037 — Virtual Node clients briefly lost the
 * slot-0 channel display name ("Long Fast" -> generic "Channel 0") whenever
 * config was requested in the window right after a physical-node disconnect.
 *
 * `sendChannelsFromDb()` derives the slot-0 name fallback from
 * `meshtasticManager.getActualDeviceConfig()?.lora?.modemPreset`, an
 * in-memory value that `handleDisconnected()` nulls out on every physical
 * disconnect (non-passive mode) until the device re-sends LoRa config on
 * reconnect. A Virtual Node client requesting config during that window used
 * to get slot 0 with no name at all. It must now fall back to the durable
 * per-source `lora.preset.<sourceId>` setting (the same one channelRoutes.ts,
 * unifiedRoutes.ts, and sourceDashboardData.ts already use for this exact
 * fallback) so the name survives the gap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getAllChannelsMock, getSettingMock } = vi.hoisted(() => ({
  getAllChannelsMock: vi.fn(),
  getSettingMock: vi.fn(),
}));

vi.mock('../services/database.js', () => {
  const shared = {
    channels: {
      getAllChannels: getAllChannelsMock,
    },
    nodes: {
      getActiveNodes: vi.fn().mockResolvedValue([]),
    },
    settings: {
      getSetting: getSettingMock,
    },
    getSettingAsync: vi.fn().mockResolvedValue(null),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    createChannel: vi.fn(async (opts: any) => new Uint8Array([opts.settings?.name ? 1 : 0])),
  },
}));

vi.mock('./protobufService.js', () => ({
  default: {},
}));

import meshtasticProtobufService from './meshtasticProtobufService.js';
import { VirtualNodeServer } from './virtualNodeServer.js';

function makeFakeManager(sourceId: string, actualDeviceConfig: any) {
  return {
    sourceId,
    getLocalNodeInfo: () => ({ nodeNum: 0x11223344, nodeId: '!11223344' }),
    getActualDeviceConfig: () => actualDeviceConfig,
  } as any;
}

function attachFakeClient(vn: VirtualNodeServer, clientId: string) {
  const socket = { destroyed: false, writable: true, write: (_frame: unknown, cb: (err?: Error) => void) => cb() };
  (vn as any).clients.set(clientId, {
    socket,
    id: clientId,
    buffer: Buffer.alloc(0),
    connectedAt: new Date(),
    lastActivity: new Date(),
  });
}

const emptySlot0 = { id: 0, name: '', role: 1, psk: null, uplinkEnabled: false, downlinkEnabled: false, positionPrecision: undefined };

describe('VirtualNodeServer.sendChannelsFromDb() — issue #4037 preset-name fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefers the live device config and skips the DB setting when it is available', async () => {
    const sourceId = 'src-1';
    getAllChannelsMock.mockResolvedValue([emptySlot0]);
    getSettingMock.mockImplementation((key: string) =>
      Promise.resolve(key === `lora.preset.${sourceId}` ? '0' /* LongFast */ : null)
    );

    // Live config says MediumFast (4) — should win over the persisted LongFast (0).
    const manager = makeFakeManager(sourceId, { lora: { modemPreset: 4 } });
    const vn = new VirtualNodeServer({ port: 0, meshtasticManager: manager });
    attachFakeClient(vn, 'client-1');

    await (vn as any).sendChannelsFromDb('client-1');

    expect(meshtasticProtobufService.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ name: 'MediumFast' }) })
    );
    // Live value sufficed — the durable setting must not be read.
    expect(getSettingMock).not.toHaveBeenCalled();
  });

  it('falls back to the persisted lora.preset.<sourceId> setting when live device config is unavailable (post-disconnect)', async () => {
    const sourceId = 'src-1';
    getAllChannelsMock.mockResolvedValue([emptySlot0]);
    // Simulates the persisted setting written by persistModemPreset() —
    // durable across the actualDeviceConfig=null gap left by handleDisconnected().
    getSettingMock.mockImplementation((key: string) =>
      Promise.resolve(key === `lora.preset.${sourceId}` ? '0' /* LONG_FAST */ : null)
    );

    // actualDeviceConfig is null — mirrors the state right after a physical
    // disconnect, before the device has re-sent LoRa config.
    const manager = makeFakeManager(sourceId, null);
    const vn = new VirtualNodeServer({ port: 0, meshtasticManager: manager });
    attachFakeClient(vn, 'client-1');

    const result = await (vn as any).sendChannelsFromDb('client-1');

    expect(result).toEqual({ sent: 1, disconnected: false });
    expect(meshtasticProtobufService.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ name: 'LongFast' }) })
    );
  });

  it('leaves the name undefined when neither live config nor a persisted preset is known', async () => {
    getAllChannelsMock.mockResolvedValue([emptySlot0]);
    getSettingMock.mockResolvedValue(null);

    const manager = makeFakeManager('src-1', null);
    const vn = new VirtualNodeServer({ port: 0, meshtasticManager: manager });
    attachFakeClient(vn, 'client-1');

    const result = await (vn as any).sendChannelsFromDb('client-1');

    expect(result).toEqual({ sent: 1, disconnected: false });
    expect(meshtasticProtobufService.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ name: undefined }) })
    );
  });

  it('does not crash on a non-numeric persisted preset value and leaves the name undefined', async () => {
    getAllChannelsMock.mockResolvedValue([emptySlot0]);
    getSettingMock.mockResolvedValue('garbage');

    const manager = makeFakeManager('src-1', null);
    const vn = new VirtualNodeServer({ port: 0, meshtasticManager: manager });
    attachFakeClient(vn, 'client-1');

    const result = await (vn as any).sendChannelsFromDb('client-1');

    expect(result).toEqual({ sent: 1, disconnected: false });
    expect(meshtasticProtobufService.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ name: undefined }) })
    );
  });
});
