/**
 * MeshtasticManager - ATAK V2 persistence (processTakV2Packet, #4317)
 *
 * Verifies the implicit-PLI branch upserts exactly one `atak_contacts` row
 * (and no Messages row), the GeoChat variant persists a Messages row on
 * portnum 78 with the `[ATAK <callsign>]` provenance prefix, receipts and
 * rich-CoT variants persist nothing, decode-fallback raw payloads are
 * ignored, and DB failures are swallowed (RX-only, best-effort).
 *
 * Mock harness copied from meshtasticManager.atak.pli.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before any imports
const mockInsertMessage = vi.fn();
const mockGetNode = vi.fn();
const mockUpsertNode = vi.fn();
const mockGetChannelById = vi.fn();
const mockUpsertContact = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    insertMessage: mockInsertMessage,
    getNode: mockGetNode,
    upsertNode: mockUpsertNode,
    upsertNodeAsync: mockUpsertNode,
    getChannelById: mockGetChannelById,
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
    settings: {
      getSetting: vi.fn(),
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
      upsertChannel: vi.fn().mockResolvedValue(undefined),
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
    atakContacts: {
      upsertContact: mockUpsertContact,
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

describe('MeshtasticManager - ATAK V2 persistence (processTakV2Packet)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockGetNode.mockReturnValue({
      nodeNum: 0x1111,
      nodeId: '!00001111',
      longName: 'Test Node',
      shortName: 'TEST',
    });
    mockGetChannelById.mockReturnValue({ id: 0, name: 'Primary', role: 1 });
    mockUpsertContact.mockResolvedValue(undefined);
    mockInsertMessage.mockResolvedValue(true);

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
      portnum: 78,
    },
  });

  it('implicit PLI upserts exactly one ATAK contact and writes no Messages row', async () => {
    const packet = makeMeshPacket(0x1111, 0xffffffff, 0, 50);
    const tak = {
      callsign: 'BRAVO-2',
      deviceCallsign: 'ANDROID-abc',
      uid: 'ANDROID-uid-9',
      team: 9,
      role: 1,
      battery: 75,
      latitudeI: 371234500,
      longitudeI: -1225432100,
      altitude: 10,
      speed: 250,
      course: 4500,
    };

    await manager.processTakV2Packet(packet, tak);

    expect(mockUpsertContact).toHaveBeenCalledTimes(1);
    const row = mockUpsertContact.mock.calls[0][0];
    expect(row).toMatchObject({
      uid: 'ANDROID-uid-9',
      callsign: 'BRAVO-2',
      deviceCallsign: 'ANDROID-abc',
      nodeNum: 0x1111,
      team: 9,
      role: 1,
      battery: 75,
      speed: 3,   // 250 cm/s → m/s rounded
      course: 45, // 4500 deg×100 → deg
    });
    expect(mockInsertMessage).not.toHaveBeenCalled();
  });

  it('GeoChat persists a Messages row on portnum 78 with the ATAK provenance prefix', async () => {
    const packet = makeMeshPacket(0x1111, 0xffffffff, 2, 51);
    const tak = {
      callsign: 'BRAVO-2',
      chat: { message: 'On station', toCallsign: '' },
    };

    await manager.processTakV2Packet(packet, tak);

    expect(mockUpsertContact).not.toHaveBeenCalled();
    expect(mockInsertMessage).toHaveBeenCalledTimes(1);
    const [message] = mockInsertMessage.mock.calls[0];
    expect(message.portnum).toBe(78);
    expect(message.text).toBe('[ATAK BRAVO-2] On station');
    expect(message.channel).toBe(2);
    expect(mockEmitNewMessage).toHaveBeenCalledTimes(1);
  });

  it('GeoChat DM routes with channel -1 and directed tag', async () => {
    const packet = makeMeshPacket(0x1111, 0x2222, 0, 52);
    const tak = {
      callsign: 'BRAVO-2',
      chat: { message: 'rally at cp2', toCallsign: 'ALPHA-1' },
    };

    await manager.processTakV2Packet(packet, tak);

    const [message] = mockInsertMessage.mock.calls[0];
    expect(message.channel).toBe(-1);
    expect(message.text).toBe('[ATAK BRAVO-2\u2192ALPHA-1] rally at cp2');
  });

  it('GeoChat receipts persist nothing', async () => {
    const packet = makeMeshPacket(0x1111, 0x2222, 0, 53);
    await manager.processTakV2Packet(packet, { callsign: 'B', chat: { message: '', receiptType: 1 } });
    await manager.processTakV2Packet(packet, { callsign: 'B', chat: { message: '', receiptForUid: 'X' } });

    expect(mockInsertMessage).not.toHaveBeenCalled();
    expect(mockUpsertContact).not.toHaveBeenCalled();
  });

  it('rich-CoT variants (marker) persist neither contact nor message this phase', async () => {
    const packet = makeMeshPacket(0x1111, 0xffffffff, 0, 54);
    await manager.processTakV2Packet(packet, {
      callsign: 'BRAVO-2',
      latitudeI: 371234500,
      longitudeI: -1225432100,
      marker: { name: 'OP1' },
    });

    expect(mockInsertMessage).not.toHaveBeenCalled();
    expect(mockUpsertContact).not.toHaveBeenCalled();
  });

  it('ignores decode-fallback raw payloads without throwing', async () => {
    const packet = makeMeshPacket(0x1111, 0xffffffff, 0, 55);
    await expect(manager.processTakV2Packet(packet, new Uint8Array([0x00, 0x01]))).resolves.toBeUndefined();
    expect(mockInsertMessage).not.toHaveBeenCalled();
    expect(mockUpsertContact).not.toHaveBeenCalled();
  });

  it('swallows GeoChat message-insertion failures (RX-only, best-effort)', async () => {
    mockInsertMessage.mockRejectedValueOnce(new Error('db down'));
    const packet = makeMeshPacket(0x1111, 0xffffffff, 0, 57);
    await expect(manager.processTakV2Packet(packet, {
      callsign: 'BRAVO-2',
      chat: { message: 'On station' },
    })).resolves.toBeUndefined();
    expect(mockEmitNewMessage).not.toHaveBeenCalled();
  });

  it('swallows contact-persistence failures (RX-only, best-effort)', async () => {
    mockUpsertContact.mockRejectedValueOnce(new Error('db down'));
    const packet = makeMeshPacket(0x1111, 0xffffffff, 0, 56);
    await expect(manager.processTakV2Packet(packet, {
      callsign: 'BRAVO-2',
      latitudeI: 371234500,
      longitudeI: -1225432100,
    })).resolves.toBeUndefined();
  });
});
