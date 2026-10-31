import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Regression for issue #6044
//
// Default-key primary traffic from the Virtual Node MQTT-proxy path used to
// land on a virtual "LongFast #101" channel (CHANNEL_DB_OFFSET + dbId) instead
// of the device's Primary #0. A server-decrypted broadcast is matched to a
// device slot only when PSK *and* trimmed name agree. The auto-seeded
// channel-DB row is named "LongFast" (DEFAULT_MQTT_CHANNELS) while a freshly
// connected device reports its primary slot (role 1, id 0) with a blank name
// until config syncs — so PSK `AQ==` matched but `"LongFast" !== ""` and no
// device slot matched, pushing the message to channelIndex 101.
//
// Fix: when a device channel's name is blank AND it is the primary (role 1,
// id 0), compare its *effective* name against the source's modem-preset name
// (`lora.preset.<sourceId>` → modemPresetChannelName). A LongFast-preset
// default-key device then matches slot 0 (channelIndex 0). A non-LongFast
// preset, a named slot, and a missing preset setting are all unaffected.
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

const {
  insertMessageMock,
  getByIdAsyncMock,
  getAllChannelsMock,
  getSettingMock,
  getChannelByIdMock,
  upsertChannelMock,
} = vi.hoisted(() => ({
  insertMessageMock: vi.fn().mockResolvedValue(true),
  getByIdAsyncMock: vi.fn(),
  getAllChannelsMock: vi.fn().mockResolvedValue([]),
  getSettingMock: vi.fn().mockResolvedValue(null),
  getChannelByIdMock: vi.fn().mockResolvedValue({ id: 0, name: '', role: 1 }),
  upsertChannelMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: getSettingMock,
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    messages: {
      insertMessage: insertMessageMock,
      getDirectMessages: vi.fn().mockResolvedValue([]),
      updateMessageDeliveryState: vi.fn().mockResolvedValue(undefined),
    },
    channelDatabase: {
      getByIdAsync: getByIdAsyncMock,
    },
    channels: {
      getAllChannels: getAllChannelsMock,
      getChannelById: getChannelByIdMock,
      upsertChannel: upsertChannelMock,
    },
    upsertNodeAsync: vi.fn().mockResolvedValue(undefined),
    updateNodeMobilityAsync: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    getPortNumName: (n: number) => `PORT_${n}`,
    normalizePortNum: (n: any) => (typeof n === 'number' ? n : 0),
    processPayload: vi.fn(),
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

const SOURCE_ID = 'src-1';

function makeManager(): MeshtasticManager {
  const mgr = new MeshtasticManager(SOURCE_ID, { host: '127.0.0.1', port: 4403 });
  (mgr as any).isConnected = true;
  (mgr as any).localNodeInfo = { nodeNum: 555, nodeId: '!0000022b' };
  // Stub side effects of processTextMessageProtobuf so the test exercises only
  // the channel-match decision, not notifications / auto-responders / node IO.
  (mgr as any).ensureMessageEndpointNodes = vi.fn().mockResolvedValue(undefined);
  (mgr as any).assessLocalSpoof = vi.fn().mockReturnValue({ spoofSuspected: false });
  (mgr as any).sendMessagePushNotification = vi.fn().mockResolvedValue(undefined);
  (mgr as any).checkAutoAcknowledge = vi.fn().mockResolvedValue(undefined);
  (mgr as any).checkForwarding = vi.fn().mockResolvedValue(undefined);
  (mgr as any).handleAutoPingCommand = vi.fn().mockResolvedValue(false);
  (mgr as any).checkAutoResponder = vi.fn().mockResolvedValue(undefined);
  (mgr as any).checkGeofencesForNode = vi.fn().mockResolvedValue(undefined);
  (mgr as any).trackPKIEncryption = vi.fn().mockResolvedValue(undefined);
  return mgr;
}

/** A server-decrypted broadcast TEXT_MESSAGE_APP packet. */
function broadcastPacket(overrides: Record<string, any> = {}) {
  return {
    from: 123456,
    to: 4294967295, // 0xFFFFFFFF broadcast
    id: 999,
    channel: 8, // on-wire LoRa hash — must NOT be used as a slot index
    decoded: {},
    ...overrides,
  };
}

const SERVER_CTX = { decryptedBy: 'server' as const, decryptedChannelId: 1 };

/** The channel recorded on the FIRST inserted message row (the device/radio copy). */
function firstInsertedChannel(): number | undefined {
  return insertMessageMock.mock.calls[0]?.[0]?.channel;
}

describe('MeshtasticManager — default-key primary channel match (issue #6044)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertMessageMock.mockResolvedValue(true);
    getByIdAsyncMock.mockResolvedValue(null);
    getAllChannelsMock.mockResolvedValue([]);
    getSettingMock.mockResolvedValue(null);
    getChannelByIdMock.mockResolvedValue({ id: 0, name: '', role: 1 });
    upsertChannelMock.mockResolvedValue(undefined);
  });

  it('(1) maps a default-key (AQ==) broadcast to Primary #0 when the source preset resolves to LongFast and the primary slot name is blank', async () => {
    const mgr = makeManager();
    // Auto-seeded channel-DB row from the MQTT-proxy path: named "LongFast".
    getByIdAsyncMock.mockResolvedValue({ id: 1, name: 'LongFast', psk: 'AQ==' });
    // Device reports its primary slot with a BLANK name (config not yet synced).
    getAllChannelsMock.mockResolvedValue([{ id: 0, name: '', psk: 'AQ==', role: 1 }]);
    // Source modem preset = 0 (LongFast).
    getSettingMock.mockImplementation(async (key: string) =>
      key === `lora.preset.${SOURCE_ID}` ? '0' : null,
    );

    await (mgr as any).processTextMessageProtobuf(broadcastPacket(), 'hello mesh', SERVER_CTX);

    expect(firstInsertedChannel()).toBe(0); // Primary #0, NOT 101
    expect(firstInsertedChannel()).not.toBe(CHANNEL_DB_OFFSET + 1); // never the virtual channel
    // Dual-channel insertion also records the DB-channel copy at 101.
    const channels = insertMessageMock.mock.calls.map(c => c[0]?.channel);
    expect(channels).toContain(CHANNEL_DB_OFFSET + 1);
  });

  it('(2) does NOT match (stays on the virtual channel) when the source preset is not LongFast', async () => {
    const mgr = makeManager();
    getByIdAsyncMock.mockResolvedValue({ id: 1, name: 'LongFast', psk: 'AQ==' });
    getAllChannelsMock.mockResolvedValue([{ id: 0, name: '', psk: 'AQ==', role: 1 }]);
    // Source modem preset = 3 (MediumSlow) — must not absorb LongFast traffic.
    getSettingMock.mockImplementation(async (key: string) =>
      key === `lora.preset.${SOURCE_ID}` ? '3' : null,
    );

    await (mgr as any).processTextMessageProtobuf(broadcastPacket(), 'hello mesh', SERVER_CTX);

    expect(firstInsertedChannel()).toBe(CHANNEL_DB_OFFSET + 1); // virtual channel 101
  });

  it('(3) leaves a named device slot unaffected (exact psk+name match, no preset widening)', async () => {
    const mgr = makeManager();
    getByIdAsyncMock.mockResolvedValue({ id: 1, name: 'gauntlet', psk: 'SharedPSK==' });
    getAllChannelsMock.mockResolvedValue([
      { id: 0, name: '', psk: 'AQ==', role: 1 },
      { id: 2, name: 'gauntlet', psk: 'SharedPSK==', role: 2 },
    ]);
    // Even with a LongFast preset, the named secondary slot must win by its own name.
    getSettingMock.mockImplementation(async (key: string) =>
      key === `lora.preset.${SOURCE_ID}` ? '0' : null,
    );

    await (mgr as any).processTextMessageProtobuf(broadcastPacket(), 'hi gauntlet', SERVER_CTX);

    expect(firstInsertedChannel()).toBe(2); // named device slot, not 101 and not 0
  });

  it('(4) is unchanged (no match, no throw) when the preset setting is missing', async () => {
    const mgr = makeManager();
    getByIdAsyncMock.mockResolvedValue({ id: 1, name: 'LongFast', psk: 'AQ==' });
    getAllChannelsMock.mockResolvedValue([{ id: 0, name: '', psk: 'AQ==', role: 1 }]);
    // No lora.preset.* setting stored → modemPresetChannelName falls back to null.
    getSettingMock.mockResolvedValue(null);

    await (mgr as any).processTextMessageProtobuf(broadcastPacket(), 'hello mesh', SERVER_CTX);

    expect(firstInsertedChannel()).toBe(CHANNEL_DB_OFFSET + 1); // virtual channel 101, unchanged
  });
});
