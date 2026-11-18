/**
 * Local-node LocalStats: each scheduler start armed an untracked 30-second
 * "first request" timer that nothing cleared, so N settings saves or
 * reconnects sent N extra LocalStats requests, and a disconnect did not stop
 * the pending one. The timer is now tracked and cleared with the interval, and
 * a save with an unchanged interval leaves the scheduler alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const store = new Map<string, string>();
const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
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
      getSetting: vi.fn(async (key: string) => store.get(`global:${key}`) ?? null),
      setSetting: vi.fn(async (key: string, value: string) => { store.set(`global:${key}`, value); }),
      getSettingForSource: vi.fn(async (sourceId: string, key: string) => store.get(`${sourceId}:${key}`) ?? null),
      setSourceSetting: vi.fn(async (sourceId: string, key: string, value: string) => { store.set(`${sourceId}:${key}`, value); }),
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

// Loaded once while the file is collected, not inside a hook (see
// meshtasticManager.remoteLocalStatsLastSent.test.ts).
const { MeshtasticManager } = await import('./meshtasticManager.js');

const MIN = 60 * 1000;

describe('MeshtasticManager - local LocalStats scheduler does not leak its first-request timer', () => {
  const managers: any[] = [];

  function makeManager(): any {
    const m: any = new MeshtasticManager('src-a');
    m.isConnected = true;
    m.localNodeInfo = { nodeNum: 1234567890, nodeId: '!499602d2', longName: 'Test Node', shortName: 'TN' };
    m.requestLocalStats = vi.fn().mockResolvedValue(undefined);
    m.saveSystemNodeMetrics = vi.fn().mockResolvedValue(undefined);
    managers.push(m);
    return m;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const m of managers.splice(0)) m.stopLocalStatsScheduler();
    vi.useRealTimers();
  });

  it('several interval changes send one first request, not one per change', async () => {
    const m = makeManager();
    m.setLocalStatsInterval(10);
    m.setLocalStatsInterval(20);
    m.setLocalStatsInterval(30);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.requestLocalStats).toHaveBeenCalledTimes(1);
  });

  it('a save with the same interval sends no extra request', async () => {
    const m = makeManager();
    m.setLocalStatsInterval(10);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(m.requestLocalStats).toHaveBeenCalledTimes(1); // the 30 s first request

    m.setLocalStatsInterval(10);
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(m.requestLocalStats).toHaveBeenCalledTimes(1); // no second first request
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(m.requestLocalStats).toHaveBeenCalledTimes(2); // the 10-minute tick, on time
  });

  it('stopping during the first 30 seconds cancels the first request', async () => {
    const m = makeManager();
    m.setLocalStatsInterval(10);
    await vi.advanceTimersByTimeAsync(10_000);
    m.stopLocalStatsScheduler();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(m.requestLocalStats).not.toHaveBeenCalled();
  });
});
