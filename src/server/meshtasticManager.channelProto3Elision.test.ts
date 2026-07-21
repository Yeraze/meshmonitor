import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks (must be defined before importing meshtasticManager) ──────────────
//
// Regression test for #3594: proto3 boolean elision in processChannelProtobuf.
//
// proto3 omits boolean `false` on the wire (it's the zero/default value). When
// the device streams its channel config on reconnect, a user-disabled
// `downlink_enabled`/`uplink_enabled` arrives DECODED AS `undefined` (per the
// repo's "protobuf.js decoded-message shape" gotcha — an unset scalar reads as
// null/undefined, not the proto default). The old `?? true` fallback then
// incorrectly stored `true`, silently re-enabling the setting after a container
// restart. Both fields default to `false` in the Meshtastic ChannelSettings
// proto, so the correct reconstruction of an absent value is `false`.

const mockUpsertChannel = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: vi.fn().mockResolvedValue(null),
    setSetting: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
      getSettingForSource: vi.fn().mockResolvedValue(null),
      setSourceSetting: vi.fn().mockResolvedValue(undefined),
      getAllSettings: vi.fn().mockResolvedValue({}),
      setSettings: vi.fn().mockResolvedValue(undefined),
    },
    channels: {
      getChannelById: vi.fn().mockResolvedValue(null),
      getAllChannels: vi.fn().mockResolvedValue([]),
      upsertChannel: mockUpsertChannel,
      getChannelCount: vi.fn().mockResolvedValue(0),
    },
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: { initialize: vi.fn(), createMeshPacket: vi.fn() },
}));

vi.mock('./protobufService.js', () => ({
  default: { encode: vi.fn(), decode: vi.fn() },
  convertIpv4ConfigToStrings: vi.fn(),
}));

vi.mock('./protobufLoader.js', () => ({ getProtobufRoot: vi.fn() }));

vi.mock('./tcpTransport.js', () => ({ TcpTransport: vi.fn() }));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./services/notificationService.js', () => ({
  notificationService: { checkAndSendNotifications: vi.fn() },
}));

vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeConnected: vi.fn(),
    notifyNodeDisconnected: vi.fn(),
  },
}));

vi.mock('./services/packetLogService.js', () => ({
  default: { logPacket: vi.fn() },
}));

vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: { tryDecrypt: vi.fn() },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock('./messageQueueService.js', () => {
  const mockInstance = {
    enqueue: vi.fn(),
    setSendCallback: vi.fn(),
    handleAck: vi.fn(),
    handleFailure: vi.fn(),
    recordExternalSend: vi.fn(),
    clear: vi.fn(),
    getStatus: vi.fn(() => ({ queueLength: 0, pendingAcks: 0, processing: false })),
  };
  function MessageQueueService() { return mockInstance as any; }
  return { messageQueueService: mockInstance, MessageQueueService };
});

vi.mock('./utils/cronScheduler.js', () => ({
  validateCron: vi.fn(() => true),
  scheduleCron: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('./config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => ({ NODE_IP: '127.0.0.1', TCP_PORT: 4403, LOG_LEVEL: 'info' })),
}));

vi.mock('../utils/autoResponderUtils.js', () => ({ normalizeTriggerPatterns: vi.fn() }));

vi.mock('../utils/nodeHelpers.js', () => ({ isNodeComplete: vi.fn() }));

// ─── Tests ────────────────────────────────────────────────────────────────────

const SOURCE = 'default';

describe('MeshtasticManager - processChannelProtobuf proto3 boolean elision (#3594)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    manager.sourceId = SOURCE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores downlinkEnabled=false when the field is elided (undefined) on the wire', async () => {
    // Simulates a secondary channel whose user disabled "Downlink Enabled".
    // proto3 elides the false value, so the decoded message has no downlinkEnabled.
    const channel = {
      index: 1,
      role: 2, // SECONDARY
      settings: {
        name: 'gauntlet',
        psk: Buffer.from('0123456789abcdef'),
        // uplinkEnabled present + true; downlinkEnabled elided (was false)
        uplinkEnabled: true,
        // downlinkEnabled: <absent>
      },
    };

    await manager.processChannelProtobuf(channel);

    expect(mockUpsertChannel).toHaveBeenCalledTimes(1);
    const [stored] = mockUpsertChannel.mock.calls[0];
    expect(stored.downlinkEnabled).toBe(false);
    // Bug would have stored true via `?? true`.
    expect(stored.downlinkEnabled).not.toBe(true);
  });

  it('stores uplinkEnabled=false when the field is elided (undefined) on the wire', async () => {
    const channel = {
      index: 2,
      role: 2,
      settings: {
        name: 'private',
        psk: Buffer.from('fedcba9876543210'),
        // uplinkEnabled elided (was false); downlinkEnabled present + true
        downlinkEnabled: true,
      },
    };

    await manager.processChannelProtobuf(channel);

    expect(mockUpsertChannel).toHaveBeenCalledTimes(1);
    const [stored] = mockUpsertChannel.mock.calls[0];
    expect(stored.uplinkEnabled).toBe(false);
    expect(stored.uplinkEnabled).not.toBe(true);
  });

  it('stores both as false when both booleans are elided', async () => {
    const channel = {
      index: 3,
      role: 2,
      settings: {
        name: 'quiet',
        psk: Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
        // both elided
      },
    };

    await manager.processChannelProtobuf(channel);

    expect(mockUpsertChannel).toHaveBeenCalledTimes(1);
    const [stored] = mockUpsertChannel.mock.calls[0];
    expect(stored.uplinkEnabled).toBe(false);
    expect(stored.downlinkEnabled).toBe(false);
  });

  it('preserves an explicitly-true value (no false-positive regression)', async () => {
    const channel = {
      index: 4,
      role: 2,
      settings: {
        name: 'public',
        psk: Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
        uplinkEnabled: true,
        downlinkEnabled: true,
      },
    };

    await manager.processChannelProtobuf(channel);

    expect(mockUpsertChannel).toHaveBeenCalledTimes(1);
    const [stored] = mockUpsertChannel.mock.calls[0];
    expect(stored.uplinkEnabled).toBe(true);
    expect(stored.downlinkEnabled).toBe(true);
  });

  it('preserves an explicit false value verbatim', async () => {
    const channel = {
      index: 5,
      role: 2,
      settings: {
        name: 'explicit',
        psk: Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
        uplinkEnabled: false,
        downlinkEnabled: false,
      },
    };

    await manager.processChannelProtobuf(channel);

    expect(mockUpsertChannel).toHaveBeenCalledTimes(1);
    const [stored] = mockUpsertChannel.mock.calls[0];
    expect(stored.uplinkEnabled).toBe(false);
    expect(stored.downlinkEnabled).toBe(false);
  });
});
