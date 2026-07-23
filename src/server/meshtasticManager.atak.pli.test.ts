/**
 * MeshtasticManager - ATAK PLI contact persistence (Phase 2 / WP2, #3691)
 *
 * Verifies processTakPacket's PLI branch upserts exactly one
 * `atak_contacts` row via `databaseService.atakContacts.upsertContact` and
 * never inserts a Messages row (PLI does not become a chat message), that
 * malformed input persists nothing and does not throw, and that a failure
 * inside the PLI branch (e.g. the DB call rejecting) is swallowed rather
 * than propagated (RX-only, best-effort).
 *
 * Modeled on meshtasticManager.atak.test.ts (hoisted vi.mock of
 * database.js, module.fallbackManager, direct private-method calls).
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

describe('MeshtasticManager - ATAK PLI contact persistence (processTakPacket)', () => {
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

  it('upserts exactly one ATAK contact and writes no Messages row', async () => {
    const packet = makeMeshPacket(0x1111, 0xffffffff, 0, 50);
    const tak = {
      contact: { callsign: 'ALPHA-1', deviceCallsign: 'EUD-001' },
      group: { role: 1, team: 9 },
      status: { battery: 75 },
      pli: { latitudeI: 371234500, longitudeI: -1225432100, altitude: 10, speed: 2, course: 45 },
    };

    await (manager as any).processTakPacket(packet, tak);

    expect(mockUpsertContact).toHaveBeenCalledTimes(1);
    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: 'EUD-001',
        sourceId: manager.sourceId,
        nodeNum: 0x1111,
        callsign: 'ALPHA-1',
        deviceCallsign: 'EUD-001',
        team: 9,
        role: 1,
        battery: 75,
      }),
    );
    expect(mockInsertMessage).not.toHaveBeenCalled();
    expect(mockEmitNewMessage).not.toHaveBeenCalled();
  });

  it('ensures the carrying node row exists via getNode/upsertNode', async () => {
    mockGetNode.mockReturnValue(null); // force ensureMessageEndpointNodes to create it
    mockUpsertNode.mockResolvedValue(undefined);

    const packet = makeMeshPacket(0x2222, 0xffffffff, 0, 51);
    const tak = { contact: { deviceCallsign: 'EUD-002' }, pli: { latitudeI: 100, longitudeI: 100 } };

    await (manager as any).processTakPacket(packet, tak);

    expect(mockUpsertContact).toHaveBeenCalledTimes(1);
  });

  it('persists a compressed PLI keyed on the nodeNum fallback', async () => {
    const packet = makeMeshPacket(0x3333, 0xffffffff, 0, 52);
    const tak = {
      isCompressed: true,
      contact: { callsign: 'garbled', deviceCallsign: 'also-garbled' },
      pli: { latitudeI: 371234500, longitudeI: -1225432100 },
    };

    await (manager as any).processTakPacket(packet, tak);

    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.objectContaining({ uid: '!00003333' }),
    );
    expect(mockInsertMessage).not.toHaveBeenCalled();
  });

  it('does not throw and does not persist a message when the decode failed upstream (raw Uint8Array)', async () => {
    const packet = makeMeshPacket(0x1111, 0xffffffff);
    const malformed = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

    await expect((manager as any).processTakPacket(packet, malformed)).resolves.toBeUndefined();

    expect(mockUpsertContact).not.toHaveBeenCalled();
    expect(mockInsertMessage).not.toHaveBeenCalled();
  });

  it('does not throw when the DB upsert rejects — error is swallowed (RX-only, best-effort)', async () => {
    mockUpsertContact.mockRejectedValueOnce(new Error('db unavailable'));

    const packet = makeMeshPacket(0x1111, 0xffffffff, 0, 53);
    const tak = { contact: { deviceCallsign: 'EUD-001' }, pli: { latitudeI: 100, longitudeI: 100 } };

    await expect((manager as any).processTakPacket(packet, tak)).resolves.toBeUndefined();

    expect(mockInsertMessage).not.toHaveBeenCalled();
  });

  it('does not persist a contact row when tak has neither pli, chat, nor detail', async () => {
    const packet = makeMeshPacket(0x1111, 0xffffffff);
    const tak = { contact: { callsign: 'ALPHA-1' } };

    await (manager as any).processTakPacket(packet, tak);

    expect(mockUpsertContact).not.toHaveBeenCalled();
    expect(mockInsertMessage).not.toHaveBeenCalled();
  });
});
