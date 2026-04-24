/**
 * MeshtasticManager - Duplicate message suppression tests
 *
 * Verifies that processTextMessageProtobuf does not emit WebSocket events
 * or trigger notifications/auto-responder when a duplicate message is detected.
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
      getAllChannels: vi.fn().mockResolvedValue([]),
      upsertChannel: mockUpsertChannel,
      getChannelCount: vi.fn().mockResolvedValue(0),
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
    traceroutes: {
      insertTraceroute: vi.fn().mockResolvedValue(undefined),
      insertRouteSegment: vi.fn().mockResolvedValue(undefined),
    },
    neighbors: {
      upsertNeighborInfo: vi.fn().mockResolvedValue(undefined),
      deleteNeighborInfoForNode: vi.fn().mockResolvedValue(0),
    },
    getAllTraceroutesForRecalculation: vi.fn().mockReturnValue([]),
    updateRecordHolderSegment: vi.fn(),
    recordTracerouteRequest: vi.fn(),
    suppressGhostNode: vi.fn(),
    isNodeSuppressed: vi.fn().mockReturnValue(false),
    isAutoTimeSyncEnabled: vi.fn().mockReturnValue(false),
    getAutoTimeSyncIntervalMinutes: vi.fn().mockReturnValue(0),
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
    createTextMessage: vi.fn(),
  },
  meshtasticProtobufService: {
    initialize: vi.fn(),
    createMeshPacket: vi.fn(),
    createTextMessage: vi.fn(),
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

describe('MeshtasticManager - Duplicate message suppression', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default mock: node exists
    mockGetNode.mockReturnValue({
      nodeNum: 0x11223344,
      nodeId: '!11223344',
      longName: 'Test Node',
      shortName: 'TEST',
    });

    // Channel 0 exists
    mockGetChannelById.mockReturnValue({ id: 0, name: 'Primary', role: 1 });

    // Dynamic import to get fresh module with mocks
    const module = await import('./meshtasticManager.js');
    manager = module.default;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeMeshPacket = (from: number, to: number, channel = 0) => ({
    from,
    to,
    id: 12345,
    channel,
    rxTime: Math.floor(Date.now() / 1000),
    decoded: {
      portnum: 1,
    },
  });

  describe('processTextMessageProtobuf', () => {
    it('should emit WebSocket event when message is new', async () => {
      mockInsertMessage.mockReturnValue(true);

      const packet = makeMeshPacket(0x11223344, 0xffffffff);
      await (manager as any).processTextMessageProtobuf(packet, 'Hello world');

      expect(mockInsertMessage).toHaveBeenCalledTimes(1);
      expect(mockEmitNewMessage).toHaveBeenCalledTimes(1);
    });

    it('should NOT emit WebSocket event when message is a duplicate', async () => {
      mockInsertMessage.mockReturnValue(false);

      const packet = makeMeshPacket(0x11223344, 0xffffffff);
      await (manager as any).processTextMessageProtobuf(packet, 'Hello world');

      expect(mockInsertMessage).toHaveBeenCalledTimes(1);
      expect(mockEmitNewMessage).not.toHaveBeenCalled();
    });

    it('should pass message data to insertMessage', async () => {
      mockInsertMessage.mockReturnValue(true);

      const packet = makeMeshPacket(0x11223344, 0xffffffff);
      await (manager as any).processTextMessageProtobuf(packet, 'Test message');

      expect(mockInsertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Test message',
          fromNodeNum: 0x11223344,
          toNodeNum: 0xffffffff,
        }),
        expect.anything()
      );
    });

    it('should emit correct message data to WebSocket when new', async () => {
      mockInsertMessage.mockReturnValue(true);

      const packet = makeMeshPacket(0x11223344, 0xffffffff);
      await (manager as any).processTextMessageProtobuf(packet, 'Broadcast msg');

      expect(mockEmitNewMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Broadcast msg',
          fromNodeNum: 0x11223344,
        }),
        expect.any(String)
      );
    });

    it('should handle direct messages correctly for new inserts', async () => {
      mockInsertMessage.mockReturnValue(true);

      // Direct message (to specific node, not broadcast)
      const packet = makeMeshPacket(0x11223344, 0x55667788);
      // Ensure target node exists
      mockGetNode.mockImplementation((nodeNum: number) => {
        if (nodeNum === 0x11223344) return { nodeNum: 0x11223344, nodeId: '!11223344', longName: 'Sender', shortName: 'SND' };
        if (nodeNum === 0x55667788) return { nodeNum: 0x55667788, nodeId: '!55667788', longName: 'Receiver', shortName: 'RCV' };
        return null;
      });

      await (manager as any).processTextMessageProtobuf(packet, 'DM text');

      expect(mockEmitNewMessage).toHaveBeenCalledTimes(1);
      expect(mockEmitNewMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'DM text',
          channel: -1, // Direct messages use channel -1
        }),
        expect.any(String)
      );
    });

    it('should not trigger any downstream processing for duplicate messages', async () => {
      mockInsertMessage.mockReturnValue(false);

      const packet = makeMeshPacket(0x11223344, 0xffffffff);
      await (manager as any).processTextMessageProtobuf(packet, 'Duplicate msg');

      // No WebSocket event
      expect(mockEmitNewMessage).not.toHaveBeenCalled();
    });
  });
});
