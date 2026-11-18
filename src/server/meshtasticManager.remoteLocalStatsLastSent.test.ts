/**
 * Auto Remote LocalStats keeps its interval across settings saves, reconnects
 * and process restarts. The last request time is persisted per source
 * (`remoteLocalStatsLastSentAt`), and a scheduler (re)start never sends sooner
 * than last send + interval. Same contract as Auto Traceroute
 * (meshtasticManager.tracerouteLastSent.test.ts).
 *
 * Settings are a Map keyed by `${sourceId}:${key}` so per-source isolation is
 * real, not delegated to a source-blind stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const store = new Map<string, string>();
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
const { MeshtasticManager } = managerModule;

const KEY = 'remoteLocalStatsLastSentAt';
const MIN = 60 * 1000;

describe('MeshtasticManager - Auto Remote LocalStats keeps its interval across saves and restarts', () => {
  const managers: any[] = [];

  /** A connected manager for `sourceId`, as a fresh process would build it. */
  function makeManager(sourceId: string): any {
    const m: any = new MeshtasticManager(sourceId);
    m.isConnected = true;
    m.localNodeInfo = { nodeNum: 1234567890, nodeId: '!499602d2', longName: 'Test Node', shortName: 'TN' };
    m.requestRemoteLocalStats = vi.fn().mockResolvedValue({ packetId: 1, requestId: 1 });
    m.isAutomationAirtimeGated = vi.fn().mockResolvedValue(false);
    m.settleRemoteLocalStatsRetries = vi.fn().mockResolvedValue(false);
    managers.push(m);
    return m;
  }

  /** Start the scheduler the way a reconnect / restart does (configComplete). */
  async function restartScheduler(m: any, minutes: number): Promise<void> {
    m.remoteLocalStatsIntervalMinutes = minutes;
    await m.startRemoteLocalStatsScheduler();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    store.clear();
    // Jitter 0: with nothing persisted the first run is immediate.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mockGetNodesNeedingRemoteLocalStatsAsync.mockResolvedValue([mockTargetNode]);
  });

  afterEach(() => {
    for (const m of managers.splice(0)) m.stopRemoteLocalStatsScheduler();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('persists the send time per source when a request goes out', async () => {
    const m = makeManager('src-a');
    await restartScheduler(m, 30);
    await vi.advanceTimersByTimeAsync(0);

    expect(m.requestRemoteLocalStats).toHaveBeenCalledTimes(1);
    expect(store.get(`src-a:${KEY}`)).toBe(String(Date.now()));
  });

  it('a save with the same interval does not re-time or send early', async () => {
    const m = makeManager('src-a');
    m.setRemoteLocalStatsInterval(30);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.requestRemoteLocalStats).toHaveBeenCalledTimes(1);

    // Three saves of the section (filters only) over the next minutes.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5 * MIN);
      m.setRemoteLocalStatsInterval(30);
    }
    await vi.advanceTimersByTimeAsync(15 * MIN - 1000);
    expect(m.requestRemoteLocalStats).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(m.requestRemoteLocalStats).toHaveBeenCalledTimes(2);
  });

  it('a save with a new interval schedules from the last send time', async () => {
    const m = makeManager('src-a');
    m.setRemoteLocalStatsInterval(30);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.requestRemoteLocalStats).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * MIN);
    m.setRemoteLocalStatsInterval(10);

    // Next run is last send + 10 min (t = 10), not right after the save.
    await vi.advanceTimersByTimeAsync(5 * MIN - 1000);
    expect(m.requestRemoteLocalStats).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.requestRemoteLocalStats).toHaveBeenCalledTimes(2);
  });

  it('a restart with a recent persisted send waits for last send + interval', async () => {
    store.set(`src-a:${KEY}`, String(Date.now() - 10 * MIN));
    const m = makeManager('src-a');
    await restartScheduler(m, 30);

    await vi.advanceTimersByTimeAsync(20 * MIN - 1000);
    expect(m.requestRemoteLocalStats).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.requestRemoteLocalStats).toHaveBeenCalledTimes(1);
  });

  it('a restart with a stale persisted send runs after the startup jitter', async () => {
    store.set(`src-a:${KEY}`, String(Date.now() - 2 * 60 * MIN));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const m = makeManager('src-a');
    await restartScheduler(m, 30);

    // Jitter = 0.5 * min(30 min, 5 min) = 2.5 min.
    await vi.advanceTimersByTimeAsync(2.5 * MIN - 1000);
    expect(m.requestRemoteLocalStats).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.requestRemoteLocalStats).toHaveBeenCalledTimes(1);
  });

  it('a reconnect right after a send does not send again early', async () => {
    const m = makeManager('src-a');
    await restartScheduler(m, 30);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.requestRemoteLocalStats).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1 * MIN);
    // configComplete on reconnect restarts the scheduler.
    await restartScheduler(m, 30);
    await vi.advanceTimersByTimeAsync(29 * MIN - 1000);
    expect(m.requestRemoteLocalStats).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.requestRemoteLocalStats).toHaveBeenCalledTimes(2);
  });

  it("keeps each source's last send time separate", async () => {
    store.set(`src-a:${KEY}`, String(Date.now() - 1 * MIN));
    const a = makeManager('src-a');
    const b = makeManager('src-b');
    await restartScheduler(a, 30);
    await restartScheduler(b, 30);
    const aBefore = store.get(`src-a:${KEY}`);

    await vi.advanceTimersByTimeAsync(0);
    // B has no history and runs now; A's recent send keeps it waiting.
    expect(b.requestRemoteLocalStats).toHaveBeenCalledTimes(1);
    expect(a.requestRemoteLocalStats).not.toHaveBeenCalled();
    expect(store.get(`src-b:${KEY}`)).toBe(String(Date.now()));
    expect(store.get(`src-a:${KEY}`)).toBe(aBefore);

    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(a.requestRemoteLocalStats).toHaveBeenCalledTimes(1);
  });

  it('a stop while the start is reading the DB arms no timer', async () => {
    const m = makeManager('src-a');
    m.remoteLocalStatsIntervalMinutes = 30;
    const pending = m.startRemoteLocalStatsScheduler();
    m.stopRemoteLocalStatsScheduler(); // e.g. disconnect
    await pending;

    expect(m.remoteLocalStatsJitterTimeout).toBeNull();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(m.requestRemoteLocalStats).not.toHaveBeenCalled();
  });
});
