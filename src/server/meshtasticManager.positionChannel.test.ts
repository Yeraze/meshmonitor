import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Regression for issue #3682
//
// Position packets received on a private secondary channel (server-decrypted
// via a Channel Database entry) used to store the RAW `meshPacket.channel`
// value — which is the on-wire LoRa channel *hash* (e.g. 39), NOT a channel
// slot index. Text messages on the SAME channel resolved correctly because the
// TEXT_MESSAGE_APP dispatch threads the decryption context
// (decryptedBy/decryptedChannelId) through to its handler.
//
// The fix threads that same context into processPositionMessageProtobuf and
// resolves the channel from it (matching the text path) via the shared
// resolveBroadcastChannelIndex helper, falling back to the raw meshPacket.channel
// ONLY when there is no server-decryption context (unencrypted/primary).
// ---------------------------------------------------------------------------

// Hoisted mocks — must be set up before MeshtasticManager is imported.

vi.mock('./virtualNodeServer.js', () => ({
  VirtualNodeServer: vi.fn(function (this: any) {
    this.start = vi.fn().mockResolvedValue(undefined);
    this.stop = vi.fn().mockResolvedValue(undefined);
    this.broadcastToClients = vi.fn().mockResolvedValue(undefined);
    this.isRunning = () => true;
    this.getClientCount = () => 0;
  }),
}));

vi.mock('./tcpTransport.js', () => ({
  TcpTransport: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    off = vi.fn();
    isConnected = () => true;
    setStaleConnectionTimeout = vi.fn();
    setConnectTimeout = vi.fn();
    setReconnectTiming = vi.fn();
  },
}));

const { insertTelemetryMock, getByIdAsyncMock, getAllChannelsMock } = vi.hoisted(() => ({
  insertTelemetryMock: vi.fn().mockResolvedValue(undefined),
  getByIdAsyncMock: vi.fn(),
  getAllChannelsMock: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    telemetry: {
      insertTelemetry: insertTelemetryMock,
    },
    messages: {
      getDirectMessages: vi.fn().mockResolvedValue([]),
      updateMessageDeliveryState: vi.fn().mockResolvedValue(undefined),
    },
    channelDatabase: {
      getByIdAsync: getByIdAsyncMock,
    },
    channels: {
      getAllChannels: getAllChannelsMock,
    },
    updateNodeMobilityAsync: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    getPortNumName: (n: number) => `PORT_${n}`,
    normalizePortNum: (n: any) => (typeof n === 'number' ? n : 0),
    processPayload: vi.fn(),
    convertCoordinates: (latI: number, lonI: number) => ({
      latitude: latI / 1e7,
      longitude: lonI / 1e7,
    }),
  };
  return { default: svc, meshtasticProtobufService: svc };
});

vi.mock('./services/packetLogService.js', () => {
  const svc = { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() };
  return { default: svc, packetLogService: svc };
});
vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: { isEnabled: () => false, tryDecrypt: vi.fn() },
}));

import { MeshtasticManager, CHANNEL_DB_OFFSET } from './meshtasticManager.js';

function makeManager(): MeshtasticManager {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).isConnected = true;
  (mgr as any).localNodeInfo = { nodeNum: 555, nodeId: '!0000022b' };
  // Avoid touching geofence / event-emitter side effects.
  (mgr as any).checkGeofencesForNode = vi.fn().mockResolvedValue(undefined);
  (mgr as any).trackPKIEncryption = vi.fn().mockResolvedValue(undefined);
  return mgr;
}

describe('MeshtasticManager — position channel resolution (issue #3682)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllChannelsMock.mockResolvedValue([]);
    getByIdAsyncMock.mockResolvedValue(null);
  });

  describe('resolveBroadcastChannelIndex', () => {
    it('resolves a server-decrypted secondary channel to CHANNEL_DB_OFFSET + dbId, NOT the raw hash', async () => {
      const mgr = makeManager();
      // Channel DB entry 3, no matching device channel.
      getByIdAsyncMock.mockResolvedValue({ id: 3, name: 'private', psk: 'AbCdEf==' });
      getAllChannelsMock.mockResolvedValue([]);

      // meshPacket.channel here is the raw LoRa hash (e.g. 39) — must be ignored.
      const meshPacket = { channel: 39, from: 123456 };
      const channelIndex = await (mgr as any).resolveBroadcastChannelIndex(meshPacket, {
        decryptedBy: 'server',
        decryptedChannelId: 3,
      });

      expect(channelIndex).toBe(CHANNEL_DB_OFFSET + 3); // 103
      expect(channelIndex).not.toBe(39); // never the raw hash
    });

    it('prefers a matching device channel slot (same psk + name) over the DB-offset index', async () => {
      const mgr = makeManager();
      getByIdAsyncMock.mockResolvedValue({ id: 3, name: 'gauntlet', psk: 'SharedPSK==' });
      // Device slot 2 has the same psk + name and is a non-primary role.
      getAllChannelsMock.mockResolvedValue([
        { id: 0, name: 'LongFast', psk: 'AQ==', role: 1 },
        { id: 2, name: 'gauntlet', psk: 'SharedPSK==', role: 2 },
      ]);

      const meshPacket = { channel: 39, from: 123456 };
      const channelIndex = await (mgr as any).resolveBroadcastChannelIndex(meshPacket, {
        decryptedBy: 'server',
        decryptedChannelId: 3,
      });

      expect(channelIndex).toBe(2); // device slot, not 103 and not 39
    });

    it('falls back to the raw meshPacket.channel for unencrypted/primary packets (no context)', async () => {
      const mgr = makeManager();
      const meshPacket = { channel: 2, from: 123456 };
      const channelIndex = await (mgr as any).resolveBroadcastChannelIndex(meshPacket, undefined);
      expect(channelIndex).toBe(2);
    });

    it('falls back to the raw meshPacket.channel for node-decrypted packets (decryptedBy=node)', async () => {
      const mgr = makeManager();
      const meshPacket = { channel: 1, from: 123456 };
      const channelIndex = await (mgr as any).resolveBroadcastChannelIndex(meshPacket, {
        decryptedBy: 'node',
        decryptedChannelId: undefined,
      });
      expect(channelIndex).toBe(1);
    });

    it('defaults to channel 0 when meshPacket.channel is undefined and no context', async () => {
      const mgr = makeManager();
      const channelIndex = await (mgr as any).resolveBroadcastChannelIndex({ from: 1 }, undefined);
      expect(channelIndex).toBe(0);
    });
  });

  describe('processPositionMessageProtobuf stores the resolved channel', () => {
    it('stores CHANNEL_DB_OFFSET + dbId (not the raw hash) in position telemetry when server-decrypted', async () => {
      const mgr = makeManager();
      getByIdAsyncMock.mockResolvedValue({ id: 5, name: 'secret', psk: 'AbCdEf==' });
      getAllChannelsMock.mockResolvedValue([]);

      const meshPacket = { channel: 39, from: 123456, id: 999 };
      const position = { latitudeI: 400000000, longitudeI: -750000000 };

      await (mgr as any).processPositionMessageProtobuf(meshPacket, position, {
        decryptedBy: 'server',
        decryptedChannelId: 5,
      });

      expect(insertTelemetryMock).toHaveBeenCalled();
      const latCall = insertTelemetryMock.mock.calls.find(
        (c: any[]) => c[0]?.telemetryType === 'latitude',
      );
      expect(latCall).toBeDefined();
      expect(latCall![0].channel).toBe(CHANNEL_DB_OFFSET + 5); // 105
      expect(latCall![0].channel).not.toBe(39); // never the raw hash
    });

    it('stores the raw meshPacket.channel for unencrypted/primary position packets', async () => {
      const mgr = makeManager();
      const meshPacket = { channel: 0, from: 123456, id: 999 };
      const position = { latitudeI: 400000000, longitudeI: -750000000 };

      await (mgr as any).processPositionMessageProtobuf(meshPacket, position, {
        decryptedBy: null,
        decryptedChannelId: undefined,
      });

      const latCall = insertTelemetryMock.mock.calls.find(
        (c: any[]) => c[0]?.telemetryType === 'latitude',
      );
      expect(latCall).toBeDefined();
      expect(latCall![0].channel).toBe(0);
    });
  });
});
