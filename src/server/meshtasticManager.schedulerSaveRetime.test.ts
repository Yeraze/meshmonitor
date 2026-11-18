/**
 * Saving settings must not re-time the remote admin scanner, time sync or
 * key repair schedulers. Each is a plain setInterval with no first-run send,
 * so a restart starts a fresh full interval: every save pushed the next run
 * back, and frequent saves kept it from ever running. A save that leaves the
 * timing alone now leaves the timer alone, and overlapping async starts can
 * no longer arm two timers.
 *
 * Settings are a Map keyed by `${sourceId}:${key}`.
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
const SOURCE = 'src-a';

describe('MeshtasticManager - settings saves do not re-time the remote admin, time sync and key repair schedulers', () => {
  const managers: any[] = [];

  function makeManager(): any {
    const m: any = new MeshtasticManager(SOURCE);
    m.isConnected = true;
    m.localNodeInfo = { nodeNum: 1234567890, nodeId: '!499602d2', longName: 'Test Node', shortName: 'TN' };
    m.canTransmit = vi.fn(() => true);
    m.isAutomationAirtimeGated = vi.fn().mockResolvedValue(false);
    m.scanNextNodeForRemoteAdmin = vi.fn().mockResolvedValue(undefined);
    m.syncNextNodeTime = vi.fn().mockResolvedValue(undefined);
    m.processKeyRepairs = vi.fn().mockResolvedValue(undefined);
    managers.push(m);
    return m;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    store.clear();
  });

  afterEach(() => {
    for (const m of managers.splice(0)) {
      m.stopRemoteAdminScanner?.();
      m.stopTimeSyncScheduler?.();
      if (m.keyRepairInterval) clearInterval(m.keyRepairInterval);
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('remote admin scanner', () => {
    it('a save with the same interval does not push the next scan back', async () => {
      const m = makeManager();
      m.setRemoteAdminScannerInterval(10);
      await vi.advanceTimersByTimeAsync(10 * MIN - 1000);
      expect(m.scanNextNodeForRemoteAdmin).not.toHaveBeenCalled();

      m.setRemoteAdminScannerInterval(10);
      await vi.advanceTimersByTimeAsync(1000);
      expect(m.scanNextNodeForRemoteAdmin).toHaveBeenCalledTimes(1);
    });

    it('a new interval still restarts the scanner', async () => {
      const m = makeManager();
      m.setRemoteAdminScannerInterval(10);
      await vi.advanceTimersByTimeAsync(5 * MIN);
      m.setRemoteAdminScannerInterval(20);
      await vi.advanceTimersByTimeAsync(20 * MIN - 1000);
      expect(m.scanNextNodeForRemoteAdmin).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(m.scanNextNodeForRemoteAdmin).toHaveBeenCalledTimes(1);
    });

    it('overlapping starts that read the DB arm one timer', async () => {
      store.set(`${SOURCE}:remoteAdminScannerIntervalMinutes`, '10');
      const m = makeManager();
      // Two reconnect-style starts while the first still awaits the DB.
      void m.startRemoteAdminScanner();
      m.remoteAdminScannerIntervalMinutes = 0;
      void m.startRemoteAdminScanner();
      await vi.advanceTimersByTimeAsync(10 * MIN);
      expect(m.scanNextNodeForRemoteAdmin).toHaveBeenCalledTimes(1);
    });
  });

  describe('time sync', () => {
    beforeEach(() => {
      store.set(`${SOURCE}:autoTimeSyncEnabled`, 'true');
    });

    it('a save with the same interval does not push the next sync back', async () => {
      const m = makeManager();
      m.setTimeSyncInterval(15);
      await vi.advanceTimersByTimeAsync(15 * MIN - 1000);
      expect(m.syncNextNodeTime).not.toHaveBeenCalled();

      m.setTimeSyncInterval(15);
      await vi.advanceTimersByTimeAsync(1000);
      expect(m.syncNextNodeTime).toHaveBeenCalledTimes(1);
    });

    it('two saves back to back arm one timer, at the newer interval', async () => {
      const m = makeManager();
      m.setTimeSyncInterval(15);
      m.setTimeSyncInterval(30);
      await vi.advanceTimersByTimeAsync(30 * MIN);
      expect(m.syncNextNodeTime).toHaveBeenCalledTimes(1);
    });

    it('disabling stops the scheduler', async () => {
      const m = makeManager();
      m.setTimeSyncInterval(15);
      await vi.advanceTimersByTimeAsync(0);
      // The route saves the flag before it calls the setter.
      store.set(`${SOURCE}:autoTimeSyncEnabled`, 'false');
      m.setTimeSyncInterval(0);
      await vi.advanceTimersByTimeAsync(60 * MIN);
      expect(m.syncNextNodeTime).not.toHaveBeenCalled();
    });
  });

  describe('key repair', () => {
    it('a max-exchanges or purge change does not push the next pass back', async () => {
      const m = makeManager();
      m.setKeyRepairSettings({ enabled: true, intervalMinutes: 5 });
      await vi.advanceTimersByTimeAsync(5 * MIN - 1000);
      expect(m.processKeyRepairs).not.toHaveBeenCalled();

      m.setKeyRepairSettings({ enabled: true, intervalMinutes: 5, maxExchanges: 4, autoPurge: true });
      await vi.advanceTimersByTimeAsync(1000);
      expect(m.processKeyRepairs).toHaveBeenCalledTimes(1);
    });

    it('a new interval restarts it and disabling stops it', async () => {
      const m = makeManager();
      m.setKeyRepairSettings({ enabled: true, intervalMinutes: 5 });
      await vi.advanceTimersByTimeAsync(3 * MIN);
      m.setKeyRepairSettings({ intervalMinutes: 10 });
      await vi.advanceTimersByTimeAsync(10 * MIN - 1000);
      expect(m.processKeyRepairs).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(m.processKeyRepairs).toHaveBeenCalledTimes(1);

      m.setKeyRepairSettings({ enabled: false });
      await vi.advanceTimersByTimeAsync(60 * MIN);
      expect(m.processKeyRepairs).toHaveBeenCalledTimes(1);
    });
  });
});
