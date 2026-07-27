/**
 * Remote LocalStats scheduler TX-disabled skip (#4294 epic, Phase 1 WP3).
 *
 * Mirrors meshtasticManager.tracerouteScheduler.test.ts's setup/mock pattern:
 * a bare fallbackManager instance with fake timers and Math.random stubbed to
 * 0 so the scheduler's startup jitter resolves immediately. See
 * docs/internal/dev-notes/TX_DISABLED_PHASE1_SPEC.md §7.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockGetNodesNeedingRemoteLocalStatsAsync = vi.fn();
const mockFindUserByIdAsync = vi.fn();
const mockFindUserByUsernameAsync = vi.fn();
const mockCheckPermissionAsync = vi.fn();
const mockGetUserPermissionSetAsync = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    getNodesNeedingRemoteLocalStatsAsync: mockGetNodesNeedingRemoteLocalStatsAsync,
    findUserByIdAsync: mockFindUserByIdAsync,
    findUserByUsernameAsync: mockFindUserByUsernameAsync,
    checkPermissionAsync: mockCheckPermissionAsync,
    getUserPermissionSetAsync: mockGetUserPermissionSetAsync,
    settings: {
      getSetting: mockGetSetting,
      setSetting: mockSetSetting,
      getSettingForSource: vi.fn((_sourceId: string, key: string) => mockGetSetting(key)),
      setSettingForSource: vi.fn((_sourceId: string, key: string, value: string) => mockSetSetting(key, value)),
    },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
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
}));

vi.mock('../utils/nodeHelpers.js', () => ({
  isNodeComplete: vi.fn(),
}));

const mockTargetNode = {
  nodeNum: 88888,
  nodeId: '!00088888',
  longName: 'Remote Stats Target',
  channel: 0,
  hopsAway: 1,
};

describe('MeshtasticManager - Remote LocalStats Scheduler TX-disabled skip (#4294 WP3)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;

    manager.isConnected = true;
    manager.localNodeInfo = {
      nodeNum: 1234567890,
      nodeId: '!12345678',
      longName: 'Test Node',
      shortName: 'TN',
    };
    manager.lastRemoteLocalStatsSentTime = 0;
    manager.remoteLocalStatsLastSentAt = new Map();

    manager.requestRemoteLocalStats = vi.fn().mockResolvedValue({ packetId: 1, requestId: 1 });
    mockGetNodesNeedingRemoteLocalStatsAsync.mockResolvedValue([mockTargetNode]);
  });

  afterEach(() => {
    manager.remoteLocalStatsIntervalMinutes = 0;
    if (manager.remoteLocalStatsJitterTimeout) {
      clearTimeout(manager.remoteLocalStatsJitterTimeout);
      manager.remoteLocalStatsJitterTimeout = null;
    }
    if (manager.remoteLocalStatsInterval) {
      clearInterval(manager.remoteLocalStatsInterval);
      manager.remoteLocalStatsInterval = null;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function startScheduler(minutes: number) {
    manager.remoteLocalStatsIntervalMinutes = minutes;
    const fn = manager['startRemoteLocalStatsScheduler'].bind(manager);
    fn();
  }

  it('does not call requestRemoteLocalStats when TX is disabled, but keeps the interval running', async () => {
    manager.actualDeviceConfig = { lora: { txEnabled: false } };

    startScheduler(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.requestRemoteLocalStats).not.toHaveBeenCalled();
    expect(manager.remoteLocalStatsInterval).not.toBeNull();
  });

  it('calls requestRemoteLocalStats once TX is re-enabled on a later tick', async () => {
    manager.actualDeviceConfig = { lora: { txEnabled: false } };

    startScheduler(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.requestRemoteLocalStats).not.toHaveBeenCalled();

    manager.actualDeviceConfig = { lora: { txEnabled: true } };
    manager.lastRemoteLocalStatsSentTime = 0;
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(manager.requestRemoteLocalStats).toHaveBeenCalledTimes(1);
  });

  it('calls requestRemoteLocalStats normally when TX is enabled', async () => {
    manager.actualDeviceConfig = { lora: { txEnabled: true } };

    startScheduler(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.requestRemoteLocalStats).toHaveBeenCalledTimes(1);
  });
});
