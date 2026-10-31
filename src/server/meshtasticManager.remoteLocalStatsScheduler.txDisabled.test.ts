/**
 * Remote LocalStats scheduler TX-disabled skip (#4294 epic, Phase 1 WP3).
 *
 * Mirrors meshtasticManager.tracerouteScheduler.test.ts's setup/mock pattern:
 * a bare fallbackManager instance with fake timers and Math.random stubbed to
 * 0 so the scheduler's startup jitter resolves immediately. See
 * docs/internal/dev-notes/TX_DISABLED_PHASE1_SPEC.md §7.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_RETRY_CONFIG } from './services/telemetryRetryPolicy.js';

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
      setSourceSetting: vi.fn((_sourceId: string, key: string, value: string) => mockSetSetting(key, value)),
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
      getLatestTelemetryPerNodeAndTypeSince: vi.fn().mockResolvedValue([]),
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

// Loaded once while the file is collected, not inside a hook. A dynamic import in
// `beforeEach` charged the manager's module load (~2 s idle, 10 s+ on a busy
// host) to the first test's hook budget; collection has no such budget.
const managerModule = await import('./meshtasticManager.js');

describe('MeshtasticManager - Remote LocalStats Scheduler TX-disabled skip (#4294 WP3)', () => {
  let manager: any;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    manager = managerModule.fallbackManager;

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

// Retry-burst / cooldown parity (#6033).
describe('MeshtasticManager - Remote LocalStats retry/cooldown parity (#6033)', () => {
  let manager: any;
  let dbDefault: any;
  const RETRY_STATE_KEY = 'remoteLocalStatsRetryState';

  beforeEach(async () => {
    vi.clearAllMocks();
    dbDefault = (await import('../services/database.js')).default as any;
    manager = managerModule.fallbackManager;
    manager.isConnected = true;
    manager.actualDeviceConfig = { lora: { txEnabled: true } };
    manager.localNodeInfo = { nodeNum: 1234567890, nodeId: '!12345678', longName: 'Test Node', shortName: 'TN' };
    manager.lastRemoteLocalStatsSentTime = 0;
    manager.remoteLocalStatsLastSentAt = new Map();
    manager.requestRemoteLocalStats = vi.fn().mockResolvedValue({ packetId: 1, requestId: 1 });
    mockGetNodesNeedingRemoteLocalStatsAsync.mockResolvedValue([mockTargetNode]);
    mockGetSetting.mockReturnValue(null);
    dbDefault.telemetry.getLatestTelemetryPerNodeAndTypeSince.mockResolvedValue([]);
  });

  afterEach(() => {
    manager.remoteLocalStatsIntervalMinutes = 0;
    if (manager.remoteLocalStatsJitterTimeout) { clearTimeout(manager.remoteLocalStatsJitterTimeout); manager.remoteLocalStatsJitterTimeout = null; }
    if (manager.remoteLocalStatsInterval) { clearInterval(manager.remoteLocalStatsInterval); manager.remoteLocalStatsInterval = null; }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('settleRemoteLocalStatsRetries', () => {
    it('counts a miss when no telemetry arrived since the request', async () => {
      const now = 10_000_000;
      dbDefault.telemetry.getLatestTelemetryPerNodeAndTypeSince.mockResolvedValue([]);
      const state = new Map<number, any>([
        [88888, { missCount: 0, cooldownUntil: null, lastRequestAt: now - 200_000, settledAt: null }],
      ]);
      const changed = await manager['settleRemoteLocalStatsRetries'](state, DEFAULT_RETRY_CONFIG, now);
      expect(changed).toBe(true);
      expect(state.get(88888).missCount).toBe(1);
      expect(state.get(88888).cooldownUntil).toBeNull();
      expect(state.get(88888).settledAt).toBe(now - 200_000);
    });

    it('resets on success when telemetry arrived after the request', async () => {
      const now = 10_000_000;
      dbDefault.telemetry.getLatestTelemetryPerNodeAndTypeSince.mockResolvedValue([
        { nodeNum: 88888, nodeId: '!00088888', telemetryType: 'x', timestamp: now - 100_000, value: 1, createdAt: now },
      ]);
      const state = new Map<number, any>([
        [88888, { missCount: 3, cooldownUntil: null, lastRequestAt: now - 200_000, settledAt: null }],
      ]);
      await manager['settleRemoteLocalStatsRetries'](state, DEFAULT_RETRY_CONFIG, now);
      expect(state.get(88888).missCount).toBe(0);
      expect(state.get(88888).cooldownUntil).toBeNull();
    });

    it('arms the cooldown on the Nth miss and resets the counter', async () => {
      const now = 10_000_000;
      dbDefault.telemetry.getLatestTelemetryPerNodeAndTypeSince.mockResolvedValue([]);
      const state = new Map<number, any>([
        [88888, { missCount: DEFAULT_RETRY_CONFIG.maxAttempts - 1, cooldownUntil: null, lastRequestAt: now - 200_000, settledAt: null }],
      ]);
      await manager['settleRemoteLocalStatsRetries'](state, DEFAULT_RETRY_CONFIG, now);
      expect(state.get(88888).missCount).toBe(0);
      expect(state.get(88888).cooldownUntil).toBe(now + DEFAULT_RETRY_CONFIG.cooldownMs);
    });

    it('does not settle a request younger than the retry delay', async () => {
      const now = 10_000_000;
      const state = new Map<number, any>([
        [88888, { missCount: 0, cooldownUntil: null, lastRequestAt: now - 10_000, settledAt: null }],
      ]);
      const changed = await manager['settleRemoteLocalStatsRetries'](state, DEFAULT_RETRY_CONFIG, now);
      expect(changed).toBe(false);
      expect(dbDefault.telemetry.getLatestTelemetryPerNodeAndTypeSince).not.toHaveBeenCalled();
    });
  });

  it('skips a node that is serving a persisted cooldown (survives restart)', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const future = Date.now() + 60 * 60_000;
    // A fresh scheduler re-reads the blob a prior run persisted; the cooldown holds.
    mockGetSetting.mockImplementation((key: string) =>
      key === RETRY_STATE_KEY
        ? JSON.stringify({ '88888': { missCount: 0, cooldownUntil: future, lastRequestAt: null, settledAt: null } })
        : null,
    );
    manager.remoteLocalStatsIntervalMinutes = 1;
    manager['startRemoteLocalStatsScheduler'].bind(manager)();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.requestRemoteLocalStats).not.toHaveBeenCalled();
  });

  it('records the request in the persisted retry state when it polls a node', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    manager.remoteLocalStatsIntervalMinutes = 1;
    manager['startRemoteLocalStatsScheduler'].bind(manager)();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.requestRemoteLocalStats).toHaveBeenCalledTimes(1);
    const saveCall = mockSetSetting.mock.calls.find((c: any[]) => c[0] === RETRY_STATE_KEY);
    expect(saveCall).toBeDefined();
    const blob = JSON.parse(saveCall![1]);
    expect(blob['88888']).toBeDefined();
    expect(typeof blob['88888'].lastRequestAt).toBe('number');
  });
});
