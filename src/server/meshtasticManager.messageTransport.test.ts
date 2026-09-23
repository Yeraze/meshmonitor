/**
 * MeshtasticManager — per-message transport stamp on `messages.transportMechanism` (#5101 P2 WP3).
 *
 * Binding decisions (TRANSPORT_BREAKDOWN_P2_SPEC.md §10.4, finding 9):
 *  - Every RECEIVED Meshtastic message stamps `resolveRadioPacketTransport`
 *    (explicit `transportMechanism` wins; else `viaMqtt` -> MQTT; else LoRa).
 *  - A Virtual Node client's own send (routed through the same RX handler,
 *    `processTextMessageProtobuf`, via `context.virtualNodeRequestId`) is
 *    OUTBOUND, not received, so it stamps INTERNAL (0) regardless of the
 *    packet's own viaMqtt/transportMechanism.
 *  - Every OUTBOUND write via `sendTextMessage` stamps INTERNAL (0).
 *  - The dual-channel `_dbchan` copy (server-decrypted messages landing on
 *    both a device channel and a Channel Database slot) inherits the same
 *    value via object spread.
 *
 * Mock scaffolding: `processTextMessageProtobuf` cases are copied from
 * meshtasticManager.duplicate-message.test.ts (the canonical harness for that
 * method); the `sendTextMessage` case is copied from
 * meshtasticManager.deliveryEvents.test.ts (the canonical harness for that
 * method), so both paths are driven against the REAL manager methods.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before any imports
const mockInsertMessage = vi.fn();
const mockGetSetting = vi.fn();
const mockGetNode = vi.fn();
const mockUpsertNode = vi.fn();
const mockGetChannelById = vi.fn();
const mockUpsertChannel = vi.fn();
const mockMarkMessageAsRead = vi.fn();
const mockGetByIdAsync = vi.fn();
const mockGetAllChannels = vi.fn();
const mockCreateTextMessage = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    insertMessage: mockInsertMessage,
    getSetting: mockGetSetting,
    getNode: mockGetNode,
    upsertNode: mockUpsertNode,
    getChannelById: mockGetChannelById,
    upsertChannel: mockUpsertChannel,
    markMessageAsRead: mockMarkMessageAsRead,
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    settings: {
      getSetting: mockGetSetting,
      getSettingForSource: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    nodes: {
      getNode: mockGetNode,
      getAllNodes: vi.fn().mockResolvedValue([]),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      upsertNode: mockUpsertNode,
      markNodeAsWelcomedIfNotAlready: vi.fn().mockResolvedValue(false),
      getNodeCount: vi.fn().mockResolvedValue(0),
      setNodeFavorite: vi.fn().mockResolvedValue(undefined),
      updateNodeMessageHops: vi.fn().mockResolvedValue(undefined),
    },
    channels: {
      getChannelById: mockGetChannelById,
      getAllChannels: mockGetAllChannels,
      upsertChannel: mockUpsertChannel,
      getChannelCount: vi.fn().mockResolvedValue(0),
    },
    channelDatabase: {
      getByIdAsync: mockGetByIdAsync,
    },
    telemetry: {
      insertTelemetry: vi.fn().mockResolvedValue(undefined),
      insertTelemetryBatch: vi.fn().mockResolvedValue(0),
      getLatestTelemetryForType: vi.fn().mockResolvedValue(null),
    },
    messages: {
      insertMessage: mockInsertMessage,
      getMessages: vi.fn().mockResolvedValue([]),
      updateMessageTimestamps: vi.fn().mockResolvedValue(true),
      updateMessageDeliveryState: vi.fn().mockResolvedValue(true),
    },
    messageEvents: {
      recordEvent: vi.fn().mockResolvedValue(undefined),
    },
    traceroutes: {
      insertTraceroute: vi.fn().mockResolvedValue(undefined),
      insertRouteSegment: vi.fn().mockResolvedValue(undefined),
    },
    neighbors: {
      upsertNeighborInfo: vi.fn().mockResolvedValue(undefined),
      deleteNeighborInfoForNode: vi.fn().mockResolvedValue(0),
    },
    recordTracerouteRequest: vi.fn(),
    logKeyRepairAttemptAsync: vi.fn().mockResolvedValue(0),
    clearKeyRepairStateAsync: vi.fn().mockResolvedValue(undefined),
    deleteNodeAsync: vi.fn().mockResolvedValue({}),
    getNodeNeedingTracerouteAsync: vi.fn().mockResolvedValue(null),
    logAutoTracerouteAttemptAsync: vi.fn().mockResolvedValue(0),
    getNodeNeedingTimeSyncAsync: vi.fn().mockResolvedValue(null),
    getNodeNeedingRemoteAdminCheckAsync: vi.fn().mockResolvedValue(null),
    updateNodeRemoteAdminStatusAsync: vi.fn().mockResolvedValue(undefined),
    getNodesNeedingKeyRepairAsync: vi.fn().mockResolvedValue([]),
    getKeyRepairLogAsync: vi.fn().mockResolvedValue([]),
    setKeyRepairStateAsync: vi.fn().mockResolvedValue(undefined),
    insertTelemetryAsync: vi.fn().mockResolvedValue(undefined),
    getLatestTelemetryForTypeAsync: vi.fn().mockResolvedValue(null),
    getMessageByRequestIdAsync: vi.fn().mockResolvedValue(null),
    updateNodeMobilityAsync: vi.fn().mockResolvedValue(0),
    getRecentEstimatedPositionsAsync: vi.fn().mockResolvedValue([]),
    updateAutoTracerouteResultByNodeAsync: vi.fn().mockResolvedValue(undefined),
    getAllGeofenceCooldownsAsync: vi.fn().mockResolvedValue([]),
    setGeofenceCooldownAsync: vi.fn().mockResolvedValue(undefined),
    markMessageAsReadAsync: vi.fn().mockResolvedValue(true),
    upsertNodeAsync: mockUpsertNode,
  },
}));

const mockEmitNewMessage = vi.fn();

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitNewMessage: mockEmitNewMessage,
    emit: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    initialize: vi.fn(),
    createMeshPacket: vi.fn(),
    createTextMessage: mockCreateTextMessage,
    createFromRadioTextMessage: vi.fn().mockResolvedValue(null),
  },
  meshtasticProtobufService: {
    initialize: vi.fn(),
    createMeshPacket: vi.fn(),
    createTextMessage: mockCreateTextMessage,
    createFromRadioTextMessage: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('./protobufService.js', () => ({
  default: {
    encode: vi.fn(),
    decode: vi.fn(),
  },
  convertIpv4ConfigToStrings: vi.fn(),
}));

vi.mock('./protobufLoader.js', () => ({
  getProtobufRoot: vi.fn(),
}));

vi.mock('./tcpTransport.js', () => ({
  TcpTransport: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('./services/notificationService.js', () => ({
  notificationService: {
    checkAndSendNotifications: vi.fn(),
  },
}));

vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeConnected: vi.fn(),
    notifyNodeDisconnected: vi.fn(),
  },
}));

vi.mock('./services/packetLogService.js', () => ({
  default: {
    isEnabled: vi.fn().mockResolvedValue(false),
    logPacket: vi.fn(),
  },
}));

vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: {
    tryDecrypt: vi.fn(),
  },
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
  return {
    messageQueueService: mockInstance,
    MessageQueueService,
  };
});

vi.mock('./utils/cronScheduler.js', () => ({
  validateCron: vi.fn(() => true),
  scheduleCron: vi.fn((_expression: string, _callback: () => void) => ({
    stop: vi.fn(),
  })),
}));

vi.mock('./config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => ({
    NODE_IP: '127.0.0.1',
    TCP_PORT: 4403,
    LOG_LEVEL: 'info',
  })),
}));

vi.mock('../utils/autoResponderUtils.js', () => ({
  normalizeTriggerPatterns: vi.fn(),
  normalizeTriggerChannels: vi.fn(),
}));

vi.mock('../utils/nodeHelpers.js', () => ({
  isNodeComplete: vi.fn(),
}));

const LOCAL = 0x0a0a0a0a;
const PEER = 0x22222222;
const toNodeId = (n: number) => `!${n.toString(16).padStart(8, '0')}`;

describe('MeshtasticManager — per-message transport stamp (#5101)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockGetNode.mockReturnValue({
      nodeNum: 0x11223344,
      nodeId: '!11223344',
      longName: 'Test Node',
      shortName: 'TEST',
    });
    mockGetChannelById.mockReturnValue({ id: 0, name: 'Primary', role: 1 });
    mockGetAllChannels.mockResolvedValue([]);
    mockGetByIdAsync.mockResolvedValue(null);
    mockCreateTextMessage.mockReturnValue({ data: new Uint8Array([1, 2, 3]), messageId: 999 });

    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    manager.localNodeInfo = { nodeNum: LOCAL, nodeId: toNodeId(LOCAL) };
    manager.isConnected = true;
    manager.transport = { send: vi.fn().mockResolvedValue(undefined) };
    manager.sourceId = 'default';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeMeshPacket = (from: number, to: number, extra: Record<string, unknown> = {}) => ({
    from,
    to,
    id: 12345,
    channel: 0,
    rxTime: Math.floor(Date.now() / 1000),
    decoded: {
      portnum: 1,
    },
    ...extra,
  });

  describe('processTextMessageProtobuf — received messages', () => {
    it('stamps LoRa (1) when the packet has neither an explicit mechanism nor viaMqtt', async () => {
      mockInsertMessage.mockReturnValue(true);
      const packet = makeMeshPacket(0x11223344, 0xffffffff);

      await (manager as any).processTextMessageProtobuf(packet, 'Hello world');

      expect(mockInsertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ transportMechanism: 1 }),
        expect.anything(),
      );
    });

    it('stamps MQTT (5) for a packet with viaMqtt=true and no explicit mechanism', async () => {
      mockInsertMessage.mockReturnValue(true);
      const packet = makeMeshPacket(0x11223344, 0xffffffff, { viaMqtt: true });

      await (manager as any).processTextMessageProtobuf(packet, 'Bridged message');

      expect(mockInsertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ transportMechanism: 5 }),
        expect.anything(),
      );
    });

    it('preserves an explicit MULTICAST_UDP (6) mechanism', async () => {
      mockInsertMessage.mockReturnValue(true);
      const packet = makeMeshPacket(0x11223344, 0xffffffff, { transportMechanism: 6 });

      await (manager as any).processTextMessageProtobuf(packet, 'UDP message');

      expect(mockInsertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ transportMechanism: 6 }),
        expect.anything(),
      );
    });

    it('stamps INTERNAL (0) for a Virtual Node client send, even over a viaMqtt packet', async () => {
      mockInsertMessage.mockReturnValue(true);
      // A Virtual Node client's own outgoing send is routed through this same
      // RX handler (context.virtualNodeRequestId set) — it must be treated as
      // OUTBOUND regardless of what the packet itself claims about viaMqtt.
      const packet = makeMeshPacket(LOCAL, 0xffffffff, { viaMqtt: true });

      await (manager as any).processTextMessageProtobuf(packet, 'VN send', { virtualNodeRequestId: 777 });

      expect(mockInsertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ transportMechanism: 0 }),
        expect.anything(),
      );
    });

    it('the dual-channel _dbchan copy inherits the same transportMechanism as the primary insert', async () => {
      mockInsertMessage.mockReturnValue(true);
      // Server-decrypted onto a device channel slot with a matching psk+name
      // (same recipe as meshtasticManager.positionChannel.test.ts) so the
      // dbCopy branch (channelIndex < CHANNEL_DB_OFFSET) actually runs.
      mockGetByIdAsync.mockResolvedValue({ id: 5, name: 'gauntlet', psk: 'SharedPSK==' });
      mockGetAllChannels.mockResolvedValue([
        { id: 0, name: 'LongFast', psk: 'AQ==', role: 1 },
        { id: 2, name: 'gauntlet', psk: 'SharedPSK==', role: 2 },
      ]);

      const packet = makeMeshPacket(0x11223344, 0xffffffff, { viaMqtt: true });
      await (manager as any).processTextMessageProtobuf(packet, 'dual-channel', {
        decryptedBy: 'server',
        decryptedChannelId: 5,
      });

      expect(mockInsertMessage).toHaveBeenCalledTimes(2);
      const primary = mockInsertMessage.mock.calls[0][0];
      const dbCopy = mockInsertMessage.mock.calls[1][0];
      expect(dbCopy.id).toBe(`${primary.id}_dbchan`);
      expect(primary.transportMechanism).toBe(5);
      expect(dbCopy.transportMechanism).toBe(5);
    });
  });

  describe('sendTextMessage — outbound sends', () => {
    it('stamps INTERNAL (0) on the outgoing row', async () => {
      await manager.sendTextMessage('hello mesh', 0, PEER);

      expect(mockInsertMessage).toHaveBeenCalledTimes(1);
      expect(mockInsertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ transportMechanism: 0 }),
        expect.anything(),
      );
    });
  });
});
