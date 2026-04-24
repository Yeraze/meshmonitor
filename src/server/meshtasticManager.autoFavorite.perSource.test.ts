import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks (must be defined before importing meshtasticManager) ──────────────

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockGetSettingForSource = vi.fn();
const mockSetSourceSetting = vi.fn();
const mockGetNode = vi.fn();
const mockSetNodeFavorite = vi.fn();
const mockGetAllNodes = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    auditLogAsync: vi.fn().mockResolvedValue(undefined),
    findUserByIdAsync: vi.fn().mockResolvedValue(null),
    findUserByUsernameAsync: vi.fn().mockResolvedValue(null),
    checkPermissionAsync: vi.fn().mockResolvedValue(true),
    getUserPermissionSetAsync: vi.fn().mockResolvedValue({ resources: {}, isAdmin: false }),
    settings: {
      getSetting: mockGetSetting,
      setSetting: mockSetSetting,
      getSettingForSource: mockGetSettingForSource,
      setSourceSetting: mockSetSourceSetting,
      getAllSettings: vi.fn().mockResolvedValue({}),
      setSettings: vi.fn().mockResolvedValue(undefined),
    },
    nodes: {
      getNode: mockGetNode,
      getAllNodes: mockGetAllNodes,
      getActiveNodes: vi.fn().mockResolvedValue([]),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      markNodeAsWelcomedIfNotAlready: vi.fn().mockResolvedValue(false),
      getNodeCount: vi.fn().mockResolvedValue(0),
      setNodeFavorite: mockSetNodeFavorite,
      setNodeFavoriteLocked: vi.fn().mockResolvedValue(undefined),
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
    getAllTraceroutesForRecalculation: vi.fn().mockReturnValue([]),
    updateRecordHolderSegment: vi.fn(),
    suppressGhostNode: vi.fn(),
    isNodeSuppressed: vi.fn().mockReturnValue(false),
    isAutoTimeSyncEnabled: vi.fn().mockReturnValue(false),
    getAutoTimeSyncIntervalMinutes: vi.fn().mockReturnValue(0),
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
  default: { initialize: vi.fn(), createMeshPacket: vi.fn() },
}));

vi.mock('./protobufService.js', () => ({
  default: { encode: vi.fn(), decode: vi.fn() },
  convertIpv4ConfigToStrings: vi.fn(),
}));

vi.mock('./protobufLoader.js', () => ({ getProtobufRoot: vi.fn() }));

vi.mock('./tcpTransport.js', () => ({ TcpTransport: vi.fn() }));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./services/notificationService.js', () => ({
  notificationService: { checkAndSendNotifications: vi.fn() },
}));

vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeConnected: vi.fn(),
    notifyNodeDisconnected: vi.fn(),
  },
}));

vi.mock('./services/packetLogService.js', () => ({
  default: { logPacket: vi.fn() },
}));

vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: { tryDecrypt: vi.fn() },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: { emit: vi.fn(), on: vi.fn() },
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
  return { messageQueueService: mockInstance, MessageQueueService };
});

vi.mock('./utils/cronScheduler.js', () => ({
  validateCron: vi.fn(() => true),
  scheduleCron: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('./config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => ({ NODE_IP: '127.0.0.1', TCP_PORT: 4403, LOG_LEVEL: 'info' })),
}));

vi.mock('../utils/autoResponderUtils.js', () => ({ normalizeTriggerPatterns: vi.fn() }));

vi.mock('../utils/nodeHelpers.js', () => ({ isNodeComplete: vi.fn() }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SOURCE_A = 'source-a';
const LOCAL_NODE_NUM = 1111111111;
const REMOTE_NODE_NUM = 2222222222;
const REMOTE_NODE_ID = '!84844384';

// DeviceRole.ROUTER = 2 (see src/constants/index.ts)
const ROLE_ROUTER = 2;

function remoteRouter(overrides: Record<string, any> = {}) {
  return {
    nodeNum: REMOTE_NODE_NUM,
    nodeId: REMOTE_NODE_ID,
    longName: 'Remote Router',
    shortName: 'RR',
    role: ROLE_ROUTER,
    hopsAway: 0,
    viaMqtt: false,
    isFavorite: false,
    favoriteLocked: false,
    lastHeard: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function localRouter() {
  return {
    nodeNum: LOCAL_NODE_NUM,
    nodeId: `!${LOCAL_NODE_NUM.toString(16).padStart(8, '0')}`,
    longName: 'Local',
    shortName: 'L',
    role: ROLE_ROUTER,
    hopsAway: 0,
    viaMqtt: false,
    isFavorite: true,
    favoriteLocked: true,
    lastHeard: Math.floor(Date.now() / 1000),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MeshtasticManager - Auto Favorite per-source scoping', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    const module = await import('./meshtasticManager.js');
    manager = module.default;

    // Pin the singleton to a known sourceId for assertions
    manager.sourceId = SOURCE_A;
    manager.isConnected = true;
    manager.localNodeInfo = {
      nodeNum: LOCAL_NODE_NUM,
      nodeId: `!${LOCAL_NODE_NUM.toString(16).padStart(8, '0')}`,
      longName: 'Local',
      shortName: 'L',
    };

    // Stub device-sync methods so DB-only paths can be exercised
    manager.sendFavoriteNode = vi.fn().mockResolvedValue(undefined);
    manager.sendRemoveFavoriteNode = vi.fn().mockResolvedValue(undefined);
    manager.supportsFavorites = vi.fn().mockReturnValue(true);
    manager.autoFavoritingNodes = new Set<number>();

    // Default: feature enabled, empty tracking list, sane stale window.
    mockGetSettingForSource.mockImplementation(async (_sourceId: string, key: string) => {
      if (key === 'autoFavoriteEnabled') return 'true';
      if (key === 'autoFavoriteNodes') return '[]';
      if (key === 'autoFavoriteStaleHours') return '72';
      return null;
    });

    // localNodeNum is persisted per-source via the localNodeSettingKey helper —
    // for non-'default' sourceIds the key is suffixed (e.g. `localNodeNum_source-a`).
    // Answer both the per-source and bare keys so the test is resilient to the
    // helper returning either form.
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === 'localNodeNum' || key === `localNodeNum_${SOURCE_A}`) return String(LOCAL_NODE_NUM);
      return null;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkAutoFavorite', () => {
    it('passes sourceId to getNode for both local and target lookups', async () => {
      // getNode returns: first call = local (scoped), second call = target (scoped)
      mockGetNode.mockImplementation(async (nodeNum: number, sourceId?: string) => {
        expect(sourceId).toBe(SOURCE_A);
        if (nodeNum === LOCAL_NODE_NUM) return localRouter();
        if (nodeNum === REMOTE_NODE_NUM) return remoteRouter();
        return null;
      });

      await manager.checkAutoFavorite(REMOTE_NODE_NUM, REMOTE_NODE_ID);

      // Both lookups must carry the source
      expect(mockGetNode).toHaveBeenCalledWith(LOCAL_NODE_NUM, SOURCE_A);
      expect(mockGetNode).toHaveBeenCalledWith(REMOTE_NODE_NUM, SOURCE_A);

      // And the write is per-source as well
      expect(mockSetNodeFavorite).toHaveBeenCalledWith(REMOTE_NODE_NUM, true, SOURCE_A, false);
      expect(mockSetSourceSetting).toHaveBeenCalledWith(
        SOURCE_A,
        'autoFavoriteNodes',
        expect.stringContaining(String(REMOTE_NODE_NUM))
      );
    });

    it('does not auto-favorite when the per-source target row is locked', async () => {
      // If another source's row were read instead, the lock flag could be wrong.
      // The per-source row must be the one consulted.
      mockGetNode.mockImplementation(async (nodeNum: number, sourceId?: string) => {
        expect(sourceId).toBe(SOURCE_A);
        if (nodeNum === LOCAL_NODE_NUM) return localRouter();
        if (nodeNum === REMOTE_NODE_NUM) return remoteRouter({ favoriteLocked: true });
        return null;
      });

      await manager.checkAutoFavorite(REMOTE_NODE_NUM, REMOTE_NODE_ID);

      expect(mockSetNodeFavorite).not.toHaveBeenCalled();
      expect(mockSetSourceSetting).not.toHaveBeenCalled();
    });

    it('does not auto-favorite when per-source target is multi-hop', async () => {
      mockGetNode.mockImplementation(async (nodeNum: number, _sourceId?: string) => {
        if (nodeNum === LOCAL_NODE_NUM) return localRouter();
        if (nodeNum === REMOTE_NODE_NUM) return remoteRouter({ hopsAway: 2 });
        return null;
      });

      await manager.checkAutoFavorite(REMOTE_NODE_NUM, REMOTE_NODE_ID);

      expect(mockSetNodeFavorite).not.toHaveBeenCalled();
    });
  });

  describe('autoFavoriteSweep', () => {
    it('passes sourceId to getNode for every tracked node', async () => {
      const trackedA = 3000000001;
      const trackedB = 3000000002;

      mockGetSettingForSource.mockImplementation(async (_sourceId: string, key: string) => {
        if (key === 'autoFavoriteEnabled') return 'true';
        if (key === 'autoFavoriteNodes') return JSON.stringify([trackedA, trackedB]);
        if (key === 'autoFavoriteStaleHours') return '72';
        return null;
      });

      mockGetNode.mockImplementation(async (nodeNum: number, sourceId?: string) => {
        expect(sourceId).toBe(SOURCE_A);
        if (nodeNum === LOCAL_NODE_NUM) return localRouter();
        return remoteRouter({ nodeNum });
      });

      await manager.autoFavoriteSweep();

      expect(mockGetNode).toHaveBeenCalledWith(LOCAL_NODE_NUM, SOURCE_A);
      expect(mockGetNode).toHaveBeenCalledWith(trackedA, SOURCE_A);
      expect(mockGetNode).toHaveBeenCalledWith(trackedB, SOURCE_A);
    });

    it('passes sourceId to getNode in the feature-disabled cleanup branch', async () => {
      const trackedA = 4000000001;

      mockGetSettingForSource.mockImplementation(async (_sourceId: string, key: string) => {
        if (key === 'autoFavoriteEnabled') return 'false'; // disabled → cleanup path
        if (key === 'autoFavoriteNodes') return JSON.stringify([trackedA]);
        return null;
      });

      mockGetNode.mockImplementation(async (nodeNum: number, sourceId?: string) => {
        expect(sourceId).toBe(SOURCE_A);
        return remoteRouter({ nodeNum, favoriteLocked: false });
      });

      await manager.autoFavoriteSweep();

      expect(mockGetNode).toHaveBeenCalledWith(trackedA, SOURCE_A);
      expect(mockSetNodeFavorite).toHaveBeenCalledWith(trackedA, false, SOURCE_A, false);
      // Per-source tracking list must be cleared via the per-source API
      expect(mockSetSourceSetting).toHaveBeenCalledWith(SOURCE_A, 'autoFavoriteNodes', '[]');
    });

    it('skips sweep removal when the per-source row is locked', async () => {
      const tracked = 5000000001;

      mockGetSettingForSource.mockImplementation(async (_sourceId: string, key: string) => {
        if (key === 'autoFavoriteEnabled') return 'true';
        if (key === 'autoFavoriteNodes') return JSON.stringify([tracked]);
        if (key === 'autoFavoriteStaleHours') return '72';
        return null;
      });

      // Stale + locked → sweep would otherwise remove, but lock must win
      mockGetNode.mockImplementation(async (nodeNum: number, _sourceId?: string) => {
        if (nodeNum === LOCAL_NODE_NUM) return localRouter();
        return remoteRouter({
          nodeNum,
          favoriteLocked: true,
          lastHeard: 1, // very stale
        });
      });

      await manager.autoFavoriteSweep();

      expect(mockSetNodeFavorite).not.toHaveBeenCalled();
    });
  });
});
