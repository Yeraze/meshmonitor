/**
 * Meshtastic delivery-diagnostics event-timeline recording (#4816 Phase 3 WP2a).
 *
 * Verifies that MeshtasticManager records `message_events` rows at the seams
 * described in the Phase 3 spec:
 *  - 'submitted'      — sendTextMessage, after the outgoing row is inserted.
 *  - 'delivered'      — processRoutingErrorMessage, own-radio/broadcast ack.
 *  - 'confirmed'      — processRoutingErrorMessage, destination DM ack.
 *  - 'routing_error'  — processRoutingErrorMessage, failed routing.
 * and that:
 *  - a RECEIVED message (processTextMessageProtobuf) records ZERO events —
 *    'submitted' is only recorded on the own-send path.
 *  - a recordEvent() throw is swallowed and never breaks the send/ack path.
 *
 * Mock scaffolding is copied from meshtasticManager.duplicate-message.test.ts
 * (the canonical processTextMessageProtobuf harness) so both the receive path
 * and the send/ack paths can be driven against the REAL manager methods.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoutingError } from './constants/meshtastic.js';

const mockInsertMessage = vi.fn();
const mockGetSetting = vi.fn();
const mockGetNode = vi.fn();
const mockUpsertNode = vi.fn();
const mockGetChannelById = vi.fn();
const mockUpsertChannel = vi.fn();
const mockMarkMessageAsRead = vi.fn();
const mockRecordEvent = vi.fn();
const mockGetMessageByRequestId = vi.fn();
const mockUpdateMessageDeliveryState = vi.fn();
const mockUpsertNodeAsync = vi.fn();

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
      updateMessageDeliveryState: mockUpdateMessageDeliveryState,
    },
    messageEvents: {
      recordEvent: mockRecordEvent,
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
    getMessageByRequestIdAsync: mockGetMessageByRequestId,
    updateNodeMobilityAsync: vi.fn().mockResolvedValue(0),
    getRecentEstimatedPositionsAsync: vi.fn().mockResolvedValue([]),
    updateAutoTracerouteResultByNodeAsync: vi.fn().mockResolvedValue(undefined),
    getAllGeofenceCooldownsAsync: vi.fn().mockResolvedValue([]),
    setGeofenceCooldownAsync: vi.fn().mockResolvedValue(undefined),
    markMessageAsReadAsync: vi.fn().mockResolvedValue(true),
    upsertNodeAsync: mockUpsertNodeAsync,
  },
}));

const mockEmitNewMessage = vi.fn();
const mockEmitRoutingUpdate = vi.fn();
const mockEmitNodeUpdate = vi.fn();

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitNewMessage: mockEmitNewMessage,
    emitRoutingUpdate: mockEmitRoutingUpdate,
    emitNodeUpdate: mockEmitNodeUpdate,
    emit: vi.fn(),
    on: vi.fn(),
  },
}));

const mockCreateTextMessage = vi.fn();

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

describe('MeshtasticManager - delivery-diagnostics event recording (#4816 Phase 3)', () => {
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
    mockUpdateMessageDeliveryState.mockResolvedValue(true);
    mockGetMessageByRequestId.mockResolvedValue(null);
    mockUpsertNodeAsync.mockResolvedValue(undefined);
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

  describe('received messages record nothing (submitted gate)', () => {
    it('does not call recordEvent for an inbound broadcast message', async () => {
      mockInsertMessage.mockReturnValue(true);
      const packet = makeMeshPacket(0x11223344, 0xffffffff);
      await (manager as any).processTextMessageProtobuf(packet, 'Hello world');

      expect(mockInsertMessage).toHaveBeenCalledTimes(1);
      expect(mockRecordEvent).not.toHaveBeenCalled();
    });

    it('does not call recordEvent for an inbound direct message', async () => {
      mockInsertMessage.mockReturnValue(true);
      const packet = makeMeshPacket(0x11223344, LOCAL);
      await (manager as any).processTextMessageProtobuf(packet, 'DM in');

      expect(mockRecordEvent).not.toHaveBeenCalled();
    });
  });

  describe('sendTextMessage records "submitted"', () => {
    it('records a submitted event after the outgoing row is inserted', async () => {
      await manager.sendTextMessage('hello mesh', 0, PEER);

      expect(mockInsertMessage).toHaveBeenCalledTimes(1);
      expect(mockRecordEvent).toHaveBeenCalledTimes(1);
      expect(mockRecordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 'default',
          eventType: 'submitted',
          provenance: 'observed',
        }),
      );
      // messageId must be the same string id that was inserted into `messages`.
      const insertedId = mockInsertMessage.mock.calls[0][0].id;
      expect(mockRecordEvent.mock.calls[0][0].messageId).toBe(insertedId);
    });

    it('does not break sendTextMessage when recordEvent throws', async () => {
      mockRecordEvent.mockRejectedValue(new Error('db unavailable'));

      await expect(manager.sendTextMessage('hello again', 0, PEER)).resolves.toBe(999);
      expect(mockInsertMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('processRoutingErrorMessage records delivered / confirmed / routing_error', () => {
    const REQ_ID = 4242;

    it('records "delivered" on the own-radio transmit ack', async () => {
      mockGetMessageByRequestId.mockResolvedValue({
        id: 'msg-delivered-1',
        toNodeId: toNodeId(PEER),
        toNodeNum: PEER,
        channel: -1,
      });

      const packet = { from: LOCAL, to: PEER, rxTime: 0, decoded: { requestId: REQ_ID } };
      await (manager as any).processRoutingErrorMessage(packet, { errorReason: 0 });

      expect(mockUpdateMessageDeliveryState).toHaveBeenCalledWith(REQ_ID, 'delivered');
      expect(mockRecordEvent).toHaveBeenCalledTimes(1);
      expect(mockRecordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 'default',
          messageId: 'msg-delivered-1',
          eventType: 'delivered',
          provenance: 'reported',
        }),
      );
    });

    it('records "confirmed" on the destination DM ack, persisting who ACKed and its signal (#4851)', async () => {
      mockGetMessageByRequestId.mockResolvedValue({
        id: 'msg-confirmed-1',
        toNodeId: toNodeId(PEER),
        toNodeNum: PEER,
        channel: -1,
      });

      const packet = {
        from: PEER,
        to: LOCAL,
        rxTime: 0,
        decoded: { requestId: REQ_ID },
        relayNode: 0x4a,
        rxSnr: 7.25,
        rxRssi: -91,
      };
      await (manager as any).processRoutingErrorMessage(packet, { errorReason: 0 });

      expect(mockUpdateMessageDeliveryState).toHaveBeenCalledWith(REQ_ID, 'confirmed', undefined, {
        ackFromNode: PEER,
        relayNode: 0x4a,
        rxSnr: 7.25,
        rxRssi: -91,
      });
      expect(mockRecordEvent).toHaveBeenCalledTimes(1);
      expect(mockRecordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 'default',
          messageId: 'msg-confirmed-1',
          eventType: 'confirmed',
          provenance: 'reported',
        }),
      );
    });

    it('records "routing_error" with the routingErrorCode in detail on a failed DM', async () => {
      mockGetMessageByRequestId.mockResolvedValue({
        id: 'msg-failed-1',
        toNodeId: toNodeId(PEER),
        toNodeNum: PEER,
        channel: -1,
      });

      const packet = { from: PEER, to: LOCAL, rxTime: 0, decoded: { requestId: REQ_ID } };
      await (manager as any).processRoutingErrorMessage(packet, { errorReason: RoutingError.MAX_RETRANSMIT });

      expect(mockUpdateMessageDeliveryState).toHaveBeenCalledWith(REQ_ID, 'failed', RoutingError.MAX_RETRANSMIT);
      expect(mockRecordEvent).toHaveBeenCalledTimes(1);
      expect(mockRecordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 'default',
          messageId: 'msg-failed-1',
          eventType: 'routing_error',
          provenance: 'reported',
          detail: JSON.stringify({ routingErrorCode: RoutingError.MAX_RETRANSMIT }),
        }),
      );
    });

    it('does not break ack handling when recordEvent throws', async () => {
      mockGetMessageByRequestId.mockResolvedValue({
        id: 'msg-delivered-2',
        toNodeId: toNodeId(PEER),
        toNodeNum: PEER,
        channel: -1,
      });
      mockRecordEvent.mockRejectedValue(new Error('db unavailable'));

      const packet = { from: LOCAL, to: PEER, rxTime: 0, decoded: { requestId: REQ_ID } };
      await expect(
        (manager as any).processRoutingErrorMessage(packet, { errorReason: 0 }),
      ).resolves.not.toThrow();

      // The delivery-state update still happened despite the diagnostics failure.
      expect(mockUpdateMessageDeliveryState).toHaveBeenCalledWith(REQ_ID, 'delivered');
    });
  });
});
