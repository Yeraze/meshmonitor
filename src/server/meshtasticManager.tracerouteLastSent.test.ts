/**
 * Auto Traceroute keeps its interval across settings saves, reconnects and
 * process restarts. The last send time is persisted per source
 * (`autoTracerouteLastSentAt`), and a scheduler (re)start never sends sooner
 * than last send + interval.
 *
 * Settings are a Map keyed by `${sourceId}:${key}` so per-source isolation is
 * real, not delegated to a source-blind stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before any imports
const store = new Map<string, string>();
const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockGetNodeNeedingTracerouteAsync = vi.fn();
const mockLogAutoTracerouteAttemptAsync = vi.fn();
const mockUpdateAutoTracerouteResultByNodeAsync = vi.fn();
const mockRecordTracerouteRequest = vi.fn();
const mockFindUserByIdAsync = vi.fn();
const mockFindUserByUsernameAsync = vi.fn();
const mockCheckPermissionAsync = vi.fn();
const mockGetUserPermissionSetAsync = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    getNodeNeedingTracerouteAsync: mockGetNodeNeedingTracerouteAsync,
    logAutoTracerouteAttemptAsync: mockLogAutoTracerouteAttemptAsync,
    updateAutoTracerouteResultByNodeAsync: mockUpdateAutoTracerouteResultByNodeAsync,
    recordTracerouteRequest: mockRecordTracerouteRequest,
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
  // Use a regular function (not arrow) so it's callable with `new`.
  // Returning `mockInstance` from a constructor replaces `this` with it.
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
  nodeNum: 99999,
  nodeId: '!00099999',
  longName: 'Target Node',
  channel: 0,
};

// Loaded once while the file is collected, not inside a hook. A dynamic import in
// `beforeEach` charged the manager's module load (~2 s idle, 10 s+ on a busy
const managerModule = await import('./meshtasticManager.js');
const { MeshtasticManager } = managerModule;

const KEY = 'autoTracerouteLastSentAt';
const MIN = 60 * 1000;

describe('MeshtasticManager - Auto Traceroute keeps its interval across saves and restarts', () => {
  const managers: any[] = [];

  /** A connected manager for `sourceId`, as a fresh process would build it. */
  function makeManager(sourceId: string): any {
    const m: any = new MeshtasticManager(sourceId);
    m.isConnected = true;
    m.localNodeInfo = { nodeNum: 1234567890, nodeId: '!499602d2', longName: 'Test Node', shortName: 'TN' };
    m.sendTraceroute = vi.fn().mockResolvedValue(undefined);
    m.checkTracerouteTimeouts = vi.fn();
    managers.push(m);
    return m;
  }

  /** Start the scheduler the way a reconnect / restart does (configComplete). */
  async function restartScheduler(m: any, minutes: number): Promise<void> {
    m.tracerouteIntervalMinutes = minutes;
    await m.startTracerouteScheduler();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    store.clear();
    // Jitter 0: with nothing persisted the first run is immediate.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mockGetNodeNeedingTracerouteAsync.mockResolvedValue(mockTargetNode);
    mockLogAutoTracerouteAttemptAsync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const m of managers.splice(0)) m.stopTracerouteScheduler();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('persists the send time per source when an auto traceroute goes out', async () => {
    const m = makeManager('src-a');
    await restartScheduler(m, 10);
    await vi.advanceTimersByTimeAsync(0);

    expect(m.sendTraceroute).toHaveBeenCalledTimes(1);
    expect(store.get(`src-a:${KEY}`)).toBe(String(Date.now()));
  });

  it('a save with the same interval does not re-time or send early', async () => {
    const m = makeManager('src-a');
    m.setTracerouteInterval(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.sendTraceroute).toHaveBeenCalledTimes(1);

    // Three saves of the Auto Traceroute section (filters only) in the next minutes.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(2 * MIN);
      m.setTracerouteInterval(10);
    }
    // t = 6 min, then on to just before 10 min: still one send.
    await vi.advanceTimersByTimeAsync(4 * MIN - 1000);
    expect(m.sendTraceroute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(m.sendTraceroute).toHaveBeenCalledTimes(2);
  });

  it('a save with a new interval schedules from the last send time', async () => {
    const m = makeManager('src-a');
    m.setTracerouteInterval(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.sendTraceroute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * MIN);
    m.setTracerouteInterval(5);

    // Next run is last send + 5 min (t = 5), not right after the save.
    await vi.advanceTimersByTimeAsync(3 * MIN - 1000);
    expect(m.sendTraceroute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.sendTraceroute).toHaveBeenCalledTimes(2);

    // Then every 5 minutes.
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(m.sendTraceroute).toHaveBeenCalledTimes(3);
  });

  it('a restart with a recent persisted send waits for last send + interval', async () => {
    store.set(`src-a:${KEY}`, String(Date.now() - 2 * MIN));
    const m = makeManager('src-a');
    await restartScheduler(m, 10);

    await vi.advanceTimersByTimeAsync(8 * MIN - 1000);
    expect(m.sendTraceroute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.sendTraceroute).toHaveBeenCalledTimes(1);
  });

  it('a restart with a stale persisted send runs after the startup jitter', async () => {
    store.set(`src-a:${KEY}`, String(Date.now() - 2 * 60 * MIN));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const m = makeManager('src-a');
    await restartScheduler(m, 10);

    // Jitter = 0.5 * min(10 min, 5 min) = 2.5 min.
    await vi.advanceTimersByTimeAsync(2.5 * MIN - 1000);
    expect(m.sendTraceroute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.sendTraceroute).toHaveBeenCalledTimes(1);
  });

  it('a reconnect right after a send does not send again early', async () => {
    const m = makeManager('src-a');
    await restartScheduler(m, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.sendTraceroute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1 * MIN);
    // configComplete on reconnect restarts the scheduler.
    await restartScheduler(m, 10);
    await vi.advanceTimersByTimeAsync(9 * MIN - 1000);
    expect(m.sendTraceroute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.sendTraceroute).toHaveBeenCalledTimes(2);
  });

  it('keeps each source\'s last send time separate', async () => {
    store.set(`src-a:${KEY}`, String(Date.now() - 1 * MIN));
    const a = makeManager('src-a');
    const b = makeManager('src-b');
    await restartScheduler(a, 10);
    await restartScheduler(b, 10);
    const aBefore = store.get(`src-a:${KEY}`);

    await vi.advanceTimersByTimeAsync(0);
    // B has no history and runs now; A's recent send keeps it waiting.
    expect(b.sendTraceroute).toHaveBeenCalledTimes(1);
    expect(a.sendTraceroute).not.toHaveBeenCalled();
    expect(store.get(`src-b:${KEY}`)).toBe(String(Date.now()));
    expect(store.get(`src-a:${KEY}`)).toBe(aBefore);

    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(a.sendTraceroute).toHaveBeenCalledTimes(1);
  });

  it('a stop while the start is reading the DB arms no timer', async () => {
    const m = makeManager('src-a');
    m.tracerouteIntervalMinutes = 10;
    const pending = m.startTracerouteScheduler();
    m.stopTracerouteScheduler(); // e.g. disconnect
    await pending;

    expect(m.tracerouteJitterTimeout).toBeNull();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(m.sendTraceroute).not.toHaveBeenCalled();
  });

  it('raises an interval of 1 or 2 minutes to 3', () => {
    const m = makeManager('src-a');
    m.isConnected = false;
    m.setTracerouteInterval(2);
    expect(m.tracerouteIntervalMinutes).toBe(3);
    m.setTracerouteInterval(1);
    expect(m.tracerouteIntervalMinutes).toBe(3);
    m.setTracerouteInterval(0);
    expect(m.tracerouteIntervalMinutes).toBe(0);
    expect(() => m.setTracerouteInterval(61)).toThrow();
  });
});
