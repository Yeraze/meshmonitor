/**
 * Auto-ack / auto-responder / auto-ping TX-disabled skip (#4294 epic, Phase 1 WP3).
 *
 * Each of these reply paths eventually queues its outbound text through
 * `this.messageQueue.enqueue(...)` (auto-ack, auto-responder) or calls
 * `this.sendTextMessage(...)` directly (auto-ping command handler / session
 * ticker) — none of that work should even be attempted while
 * `isTxEnabled()` is false, so the pre-checks added in meshtasticManager.ts
 * return early before touching the queue/send primitive.
 *
 * Mock pattern mirrors meshtasticManager.node-identity-guards.test.ts /
 * meshtasticManager.tracerouteScheduler.test.ts (fresh `fallbackManager`
 * import per test file, full databaseService + messageQueueService mocks).
 * See docs/internal/dev-notes/TX_DISABLED_PHASE1_SPEC.md §7.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockGetSettingForSource = vi.fn();
const mockGetNode = vi.fn();
const mockFindUserByIdAsync = vi.fn();
const mockFindUserByUsernameAsync = vi.fn();
const mockCheckPermissionAsync = vi.fn();
const mockGetUserPermissionSetAsync = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    findUserByIdAsync: mockFindUserByIdAsync,
    findUserByUsernameAsync: mockFindUserByUsernameAsync,
    checkPermissionAsync: mockCheckPermissionAsync,
    getUserPermissionSetAsync: mockGetUserPermissionSetAsync,
    settings: {
      getSetting: mockGetSetting,
      setSetting: mockSetSetting,
      getSettingForSource: mockGetSettingForSource,
      setSettingForSource: vi.fn().mockResolvedValue(undefined),
    },
    nodes: {
      getNode: mockGetNode,
      getAllNodes: vi.fn().mockResolvedValue([]),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      markNodeAsWelcomedIfNotAlready: vi.fn().mockResolvedValue(false),
      getNodeCount: vi.fn().mockResolvedValue(0),
      setNodeFavorite: vi.fn().mockResolvedValue(undefined),
      updateNodeMessageHops: vi.fn().mockResolvedValue(undefined),
    },
    channels: {
      getChannelById: vi.fn().mockResolvedValue(null),
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
      insertMessage: vi.fn().mockResolvedValue(true),
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
    logKeyRepairAttemptAsync: vi.fn().mockResolvedValue(0),
    clearKeyRepairStateAsync: vi.fn().mockResolvedValue(undefined),
    deleteNodeAsync: vi.fn().mockResolvedValue({}),
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
    getAllGeofenceCooldownsAsync: vi.fn().mockResolvedValue([]),
    setGeofenceCooldownAsync: vi.fn().mockResolvedValue(undefined),
    markMessageAsReadAsync: vi.fn().mockResolvedValue(true),
    getNodeNeedingTracerouteAsync: vi.fn().mockResolvedValue(null),
    logAutoTracerouteAttemptAsync: vi.fn().mockResolvedValue(0),
    updateAutoTracerouteResultByNodeAsync: vi.fn().mockResolvedValue(undefined),
    recordTracerouteRequest: vi.fn(),
    getNodesNeedingRemoteLocalStatsAsync: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    initialize: vi.fn(),
    createMeshPacket: vi.fn(),
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

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emit: vi.fn(),
    on: vi.fn(),
    emitAutoPingUpdate: vi.fn(),
  },
}));

const mockEnqueue = vi.fn();
vi.mock('./messageQueueService.js', () => {
  const mockInstance = {
    enqueue: mockEnqueue,
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

const LOCAL_NODE_NUM = 1234567890;
const REMOTE_NODE_NUM = 987654321;

/** Backing store for getSettingForSource, keyed by settings key (sourceId ignored — single source in these tests). */
function wireSettings(overrides: Record<string, string | null>) {
  mockGetSettingForSource.mockImplementation((_sourceId: string, key: string) =>
    Promise.resolve(Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null)
  );
}

describe('MeshtasticManager - Auto-Ack/Responder/Ping TX-disabled skip (#4294 WP3)', () => {
  let manager: any;
  let loggerModule: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    loggerModule = await import('../utils/logger.js');

    manager.isConnected = true;
    manager.localNodeInfo = {
      nodeNum: LOCAL_NODE_NUM,
      nodeId: '!499602d2',
      longName: 'Test Local Node',
      shortName: 'TLN',
    };
    manager.autoAckProcessedPackets = new Set();
    manager.autoResponderProcessedPackets = new Set();
    manager.autoAckCooldowns = new Map();
    manager.autoPingSessions = new Map();
    manager.cachedAutoAckRegex = null;
    manager.sendTextMessage = vi.fn().mockResolvedValue(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkAutoAcknowledge', () => {
    const autoAckMessage = {
      fromNodeId: '!3ade68b1',
      timestamp: Date.now(),
      hopStart: undefined,
      hopLimit: undefined,
      viaMqtt: false,
      relayNode: undefined,
    };

    it('does not enqueue a reply when TX is disabled', async () => {
      manager.actualDeviceConfig = { lora: { txEnabled: false } };
      wireSettings({
        autoAckEnabled: 'true',
        autoAckChannels: '0',
        autoAckChannelZeroHopReplyEnabled: 'true',
      });

      await manager.checkAutoAcknowledge(autoAckMessage, 'ping', 0, false, REMOTE_NODE_NUM, 111);

      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(loggerModule.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('TX disabled')
      );
    });

    it('enqueues a reply normally when TX is enabled', async () => {
      manager.actualDeviceConfig = { lora: { txEnabled: true } };
      wireSettings({
        autoAckEnabled: 'true',
        autoAckChannels: '0',
        autoAckChannelZeroHopReplyEnabled: 'true',
        autoAckPreSendDelaySeconds: '0',
      });

      await manager.checkAutoAcknowledge(autoAckMessage, 'ping', 0, false, REMOTE_NODE_NUM, 222);

      expect(mockEnqueue).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkAutoResponder', () => {
    const responderMessage = {
      text: 'hello',
      fromNodeNum: REMOTE_NODE_NUM,
      channel: 0,
      timestamp: Date.now(),
    };

    it('does not read trigger config or enqueue a reply when TX is disabled', async () => {
      manager.actualDeviceConfig = { lora: { txEnabled: false } };
      wireSettings({ autoResponderEnabled: 'true' });

      await manager.checkAutoResponder(responderMessage, false, 333);

      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(loggerModule.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('TX disabled')
      );
      // Never got far enough to look for configured triggers.
      expect(mockGetSettingForSource).not.toHaveBeenCalledWith(expect.anything(), 'autoResponderTriggers');
    });

    it('proceeds past the TX check when TX is enabled', async () => {
      manager.actualDeviceConfig = { lora: { txEnabled: true } };
      wireSettings({ autoResponderEnabled: 'true' }); // no autoResponderTriggers configured

      await manager.checkAutoResponder(responderMessage, false, 444);

      // Guard didn't block; execution reached the (unconfigured) triggers check.
      expect(loggerModule.logger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('TX disabled')
      );
      expect(loggerModule.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('No auto-responder triggers configured')
      );
    });
  });

  describe('handleAutoPingCommand', () => {
    const pingMessage = { text: 'ping 3', fromNodeNum: REMOTE_NODE_NUM, channel: 0 };

    it('does not send a reply and does not start a session when TX is disabled', async () => {
      manager.actualDeviceConfig = { lora: { txEnabled: false } };
      wireSettings({ autoPingEnabled: 'true' });

      const handled = await manager.handleAutoPingCommand(pingMessage, true);

      expect(handled).toBe(false);
      expect(manager.sendTextMessage).not.toHaveBeenCalled();
      expect(manager.autoPingSessions.has(REMOTE_NODE_NUM)).toBe(false);
      expect(loggerModule.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('TX is disabled')
      );
    });

    it('starts a session and sends the confirmation when TX is enabled', async () => {
      manager.actualDeviceConfig = { lora: { txEnabled: true } };
      wireSettings({ autoPingEnabled: 'true', autoPingMaxPings: '20', autoPingIntervalSeconds: '30', autoPingTimeoutSeconds: '60' });
      manager.emitAutoPingUpdate = vi.fn().mockResolvedValue(undefined);
      manager.startAutoPingSession = vi.fn();

      const handled = await manager.handleAutoPingCommand(pingMessage, true);

      expect(handled).toBe(true);
      expect(manager.sendTextMessage).toHaveBeenCalledWith(
        expect.stringContaining('Starting 3 pings'),
        0,
        REMOTE_NODE_NUM
      );
      expect(manager.autoPingSessions.has(REMOTE_NODE_NUM)).toBe(true);
    });
  });

  describe('sendNextAutoPing', () => {
    function makeSession(overrides: Record<string, unknown> = {}) {
      return {
        requestedBy: REMOTE_NODE_NUM,
        channel: 0,
        totalPings: 5,
        completedPings: 0,
        successfulPings: 0,
        failedPings: 0,
        intervalMs: 30000,
        timeoutMs: 60000,
        timer: null,
        sending: false,
        pendingRequestId: null,
        pendingTimeout: null,
        startTime: Date.now(),
        lastPingSentAt: 0,
        results: [],
        ...overrides,
      };
    }

    it('does not send the next ping when TX is disabled', async () => {
      manager.actualDeviceConfig = { lora: { txEnabled: false } };
      const session = makeSession();

      await manager.sendNextAutoPing(session);

      expect(manager.sendTextMessage).not.toHaveBeenCalled();
      // Tick was skipped entirely — session state untouched, so it resumes cleanly later.
      expect(session.sending).toBe(false);
      expect(session.pendingRequestId).toBeNull();
    });

    it('sends the next ping normally when TX is enabled', async () => {
      manager.actualDeviceConfig = { lora: { txEnabled: true } };
      const session = makeSession();

      await manager.sendNextAutoPing(session);

      expect(manager.sendTextMessage).toHaveBeenCalledWith('Ping 1/5', 0, REMOTE_NODE_NUM);
    });
  });
});
