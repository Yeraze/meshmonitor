/**
 * MeshtasticManager - ATAK GeoChat persistence (Phase 1 / WP2)
 *
 * Verifies processTakPacket persists only the GeoChat oneof variant of a
 * decoded TAKPacket (PortNum.ATAK_PLUGIN, 72) as a Messages row, reusing the
 * text-message row construction (exact id format, channel/DM routing) and
 * push notification, while PLI, detail, compressed chat, and receipts are
 * never persisted and no auto-responder machinery runs (RX-only).
 *
 * Modeled on meshtasticManager.duplicate-message.test.ts (hoisted vi.mock of
 * database.js, module.fallbackManager, direct private-method calls).
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
    sources: {
      getSource: vi.fn().mockResolvedValue({ id: 'default', name: 'Default' }),
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
    getServiceStatus: vi.fn(() => ({ anyAvailable: false })),
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

describe('MeshtasticManager - ATAK GeoChat persistence (processTakPacket)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default mock: node exists (so ensureMessageEndpointNodes never needs
    // upsertNodeAsync — same convention as duplicate-message.test.ts).
    mockGetNode.mockReturnValue({
      nodeNum: 0x1111,
      nodeId: '!00001111',
      longName: 'Test Node',
      shortName: 'TEST',
    });

    mockGetChannelById.mockReturnValue({ id: 0, name: 'Primary', role: 1 });

    // Dynamic import to get a fresh module with mocks applied
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeMeshPacket = (from: number, to: number, channel = 0, id = 42) => ({
    from,
    to,
    id,
    channel,
    rxTime: Math.floor(Date.now() / 1000),
    decoded: {
      portnum: 72,
    },
  });

  describe('GeoChat persists as a message', () => {
    it('persists a broadcast GeoChat with the exact row id / channel / portnum / text', async () => {
      mockInsertMessage.mockReturnValue(true);

      const packet = makeMeshPacket(0x1111, 0xffffffff, 3, 42);
      const tak = { contact: { callsign: 'ALPHA' }, chat: { message: 'hi' } };

      await (manager as any).processTakPacket(packet, tak);

      expect(mockInsertMessage).toHaveBeenCalledTimes(1);
      expect(mockInsertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `${manager.sourceId}_4369_42`,
          channel: 3,
          portnum: 72,
          text: '[ATAK ALPHA] hi',
        }),
        manager.sourceId,
      );
      expect(mockEmitNewMessage).toHaveBeenCalledTimes(1);
    });

    it('omits the callsign tag when contact is absent', async () => {
      mockInsertMessage.mockReturnValue(true);

      const packet = makeMeshPacket(0x1111, 0xffffffff, 0, 43);
      const tak = { chat: { message: 'no contact info' } };

      await (manager as any).processTakPacket(packet, tak);

      expect(mockInsertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: '[ATAK] no contact info' }),
        expect.anything(),
      );
    });

    it('tags with sender→recipient callsigns when to_callsign is set', async () => {
      mockInsertMessage.mockReturnValue(true);

      const packet = makeMeshPacket(0x1111, 0xffffffff, 0, 44);
      const tak = { contact: { callsign: 'ALPHA' }, chat: { message: 'go', toCallsign: 'BRAVO' } };

      await (manager as any).processTakPacket(packet, tak);

      expect(mockInsertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: '[ATAK ALPHA→BRAVO] go' }),
        expect.anything(),
      );
    });
  });

  describe('DM routing', () => {
    it('routes a GeoChat DM to channel -1 with toNodeNum from the envelope', async () => {
      mockInsertMessage.mockReturnValue(true);
      mockGetNode.mockImplementation((nodeNum: number) => {
        if (nodeNum === 0x1111) return { nodeNum: 0x1111, nodeId: '!00001111', longName: 'Sender', shortName: 'SND' };
        if (nodeNum === 0x55667788) return { nodeNum: 0x55667788, nodeId: '!55667788', longName: 'Receiver', shortName: 'RCV' };
        return null;
      });

      const packet = makeMeshPacket(0x1111, 0x55667788, 3, 45);
      const tak = { contact: { callsign: 'ALPHA' }, chat: { message: 'dm text' } };

      await (manager as any).processTakPacket(packet, tak);

      expect(mockInsertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: -1,
          toNodeNum: 0x55667788,
        }),
        expect.anything(),
      );
    });
  });

  describe('non-persisted variants', () => {
    it('does not persist a GeoChat receipt', async () => {
      const packet = makeMeshPacket(0x1111, 0xffffffff);
      const tak = { contact: { callsign: 'ALPHA' }, chat: { message: '', receiptType: 1, receiptForUid: 'u' } };

      await (manager as any).processTakPacket(packet, tak);

      expect(mockInsertMessage).not.toHaveBeenCalled();
      expect(mockEmitNewMessage).not.toHaveBeenCalled();
    });

    it('does not persist a compressed GeoChat', async () => {
      const packet = makeMeshPacket(0x1111, 0xffffffff);
      const tak = { isCompressed: true, contact: { callsign: 'ALPHA' }, chat: { message: 'hi' } };

      await (manager as any).processTakPacket(packet, tak);

      expect(mockInsertMessage).not.toHaveBeenCalled();
    });

    it('does not persist a PLI variant', async () => {
      const packet = makeMeshPacket(0x1111, 0xffffffff);
      const tak = { contact: { callsign: 'ALPHA' }, pli: { latitudeI: 371234500, longitudeI: -1225432100 } };

      await (manager as any).processTakPacket(packet, tak);

      expect(mockInsertMessage).not.toHaveBeenCalled();
    });

    it('does not persist a detail (opaque bytes) variant', async () => {
      const packet = makeMeshPacket(0x1111, 0xffffffff);
      const tak = { contact: { callsign: 'ALPHA' }, detail: new Uint8Array([1, 2, 3]) };

      await (manager as any).processTakPacket(packet, tak);

      expect(mockInsertMessage).not.toHaveBeenCalled();
    });

    it('does not throw and does not persist when the decode failed upstream (raw Uint8Array)', async () => {
      const packet = makeMeshPacket(0x1111, 0xffffffff);
      const malformed = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

      await expect((manager as any).processTakPacket(packet, malformed)).resolves.toBeUndefined();

      expect(mockInsertMessage).not.toHaveBeenCalled();
    });

    it('does not persist an empty/whitespace-only GeoChat message', async () => {
      const packet = makeMeshPacket(0x1111, 0xffffffff);
      const tak = { contact: { callsign: 'ALPHA' }, chat: { message: '   ' } };

      await (manager as any).processTakPacket(packet, tak);

      expect(mockInsertMessage).not.toHaveBeenCalled();
    });
  });

  describe('no auto-responder side effects (RX-only)', () => {
    it('never calls checkAutoAcknowledge / handleAutoPingCommand / checkAutoResponder for GeoChat', async () => {
      mockInsertMessage.mockReturnValue(true);

      const ackSpy = vi.spyOn(manager, 'checkAutoAcknowledge');
      const pingSpy = vi.spyOn(manager, 'handleAutoPingCommand');
      const responderSpy = vi.spyOn(manager, 'checkAutoResponder');

      const packet = makeMeshPacket(0x1111, 0xffffffff, 0, 46);
      const tak = { contact: { callsign: 'ALPHA' }, chat: { message: 'hello' } };

      await (manager as any).processTakPacket(packet, tak);

      expect(mockInsertMessage).toHaveBeenCalledTimes(1);
      expect(ackSpy).not.toHaveBeenCalled();
      expect(pingSpy).not.toHaveBeenCalled();
      expect(responderSpy).not.toHaveBeenCalled();
    });
  });
});
