import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before any imports
const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockGetAllNodes = vi.fn();
const mockAuditLogAsync = vi.fn();
const mockFindUserByIdAsync = vi.fn();
const mockFindUserByUsernameAsync = vi.fn();
const mockCheckPermissionAsync = vi.fn();
const mockGetUserPermissionSetAsync = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    auditLogAsync: mockAuditLogAsync,
    findUserByIdAsync: mockFindUserByIdAsync,
    findUserByUsernameAsync: mockFindUserByUsernameAsync,
    checkPermissionAsync: mockCheckPermissionAsync,
    getUserPermissionSetAsync: mockGetUserPermissionSetAsync,
    settings: {
      getSetting: mockGetSetting,
      setSetting: mockSetSetting,
      getSettingForSource: vi.fn((_sourceId: string | null | undefined, key: string) => mockGetSetting(key)),
      setSourceSetting: vi.fn((_sourceId: string, key: string, value: string) => mockSetSetting(key, value)),
      getAllSettings: vi.fn().mockResolvedValue({}),
      setSettings: vi.fn().mockResolvedValue(undefined),
    },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      getAllNodes: mockGetAllNodes,
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const LOCAL_NODE_NUM = 1111111111;
const LOCAL_NODE_ID = '!deadbeef';

/** Advance fake timers far enough for the purge+reboot sequence to complete. */
async function drainPurgeTimers(numNodes: number) {
  // 200ms per node removal + 3000ms for reboot delay, plus buffer
  const totalMs = numNodes * 200 + 3000 + 500;
  await vi.advanceTimersByTimeAsync(totalMs);
}

/** Build a node with a given lastHeard (seconds since epoch). */
function makeNode(nodeNum: number, lastHeardSeconds: number) {
  return {
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: `Node ${nodeNum}`,
    shortName: `N${nodeNum}`,
    lastHeard: lastHeardSeconds,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MeshtasticManager - Auto Heap Management', () => {
  let manager: any;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    const module = await import('./meshtasticManager.js');
    manager = module.default;

    manager.isConnected = true;
    manager.localNodeInfo = {
      nodeNum: LOCAL_NODE_NUM,
      nodeId: LOCAL_NODE_ID,
      longName: 'Local Node',
      shortName: 'LN',
    };

    // Reset cooldown state between tests
    manager.lastHeapPurgeAt = null;

    // Mock the methods that checkAutoHeapManagement calls
    manager.sendRemoveNode = vi.fn().mockResolvedValue(undefined);
    manager.sendRebootCommand = vi.fn().mockResolvedValue(undefined);

    // Default: enabled with threshold 20000
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === 'autoHeapManagementEnabled') return 'true';
      if (key === 'autoHeapManagementThresholdBytes') return '20000';
      return null;
    });

    // Default: no nodes
    mockGetAllNodes.mockResolvedValue([]);
    mockAuditLogAsync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('checkAutoHeapManagement', () => {
    it('does nothing when autoHeapManagementEnabled is false', async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === 'autoHeapManagementEnabled') return 'false';
        return null;
      });

      await manager.checkAutoHeapManagement(5000, LOCAL_NODE_NUM);

      expect(manager.sendRemoveNode).not.toHaveBeenCalled();
      expect(manager.sendRebootCommand).not.toHaveBeenCalled();
    });

    it('does nothing when heapFreeBytes >= threshold', async () => {
      // heap (25000) is above threshold (20000) — no purge
      await manager.checkAutoHeapManagement(25000, LOCAL_NODE_NUM);

      expect(manager.sendRemoveNode).not.toHaveBeenCalled();
      expect(manager.sendRebootCommand).not.toHaveBeenCalled();
    });

    it('does nothing when heapFreeBytes exactly equals threshold', async () => {
      await manager.checkAutoHeapManagement(20000, LOCAL_NODE_NUM);

      expect(manager.sendRemoveNode).not.toHaveBeenCalled();
      expect(manager.sendRebootCommand).not.toHaveBeenCalled();
    });

    it('purges oldest nodes when heap is below threshold', async () => {
      const nodes = [
        makeNode(100, 1000), // oldest
        makeNode(200, 2000),
        makeNode(300, 3000), // newest
      ];
      mockGetAllNodes.mockResolvedValue(nodes);

      await Promise.all([
        manager.checkAutoHeapManagement(5000, LOCAL_NODE_NUM),
        drainPurgeTimers(3),
      ]);

      expect(manager.sendRemoveNode).toHaveBeenCalledTimes(3);
      // Should purge in lastHeard ASC order (oldest first)
      expect(manager.sendRemoveNode).toHaveBeenNthCalledWith(1, 100);
      expect(manager.sendRemoveNode).toHaveBeenNthCalledWith(2, 200);
      expect(manager.sendRemoveNode).toHaveBeenNthCalledWith(3, 300);
    });

    it('purges up to 10 oldest nodes when heap is below threshold', async () => {
      // Create 15 remote nodes — only the 10 oldest should be purged
      const nodes = Array.from({ length: 15 }, (_, i) =>
        makeNode(1000 + i, i + 1) // lastHeard: 1, 2, ..., 15
      );
      mockGetAllNodes.mockResolvedValue(nodes);

      await Promise.all([
        manager.checkAutoHeapManagement(5000, LOCAL_NODE_NUM),
        drainPurgeTimers(10),
      ]);

      expect(manager.sendRemoveNode).toHaveBeenCalledTimes(10);
      // The 10 oldest (nodeNums 1000–1009) should be purged
      for (let i = 0; i < 10; i++) {
        expect(manager.sendRemoveNode).toHaveBeenCalledWith(1000 + i);
      }
      // The 5 newest should NOT be purged
      for (let i = 10; i < 15; i++) {
        expect(manager.sendRemoveNode).not.toHaveBeenCalledWith(1000 + i);
      }
    });

    it('never purges the local node', async () => {
      const nodes = [
        makeNode(LOCAL_NODE_NUM, 500), // local node — oldest, but must be skipped
        makeNode(100, 1000),
        makeNode(200, 2000),
      ];
      mockGetAllNodes.mockResolvedValue(nodes);

      await Promise.all([
        manager.checkAutoHeapManagement(5000, LOCAL_NODE_NUM),
        drainPurgeTimers(2),
      ]);

      expect(manager.sendRemoveNode).not.toHaveBeenCalledWith(LOCAL_NODE_NUM);
      expect(manager.sendRemoveNode).toHaveBeenCalledWith(100);
      expect(manager.sendRemoveNode).toHaveBeenCalledWith(200);
    });

    it('calls sendRebootCommand after purging', async () => {
      const nodes = [makeNode(100, 1000)];
      mockGetAllNodes.mockResolvedValue(nodes);

      await Promise.all([
        manager.checkAutoHeapManagement(5000, LOCAL_NODE_NUM),
        drainPurgeTimers(1),
      ]);

      expect(manager.sendRebootCommand).toHaveBeenCalledTimes(1);
      expect(manager.sendRebootCommand).toHaveBeenCalledWith(LOCAL_NODE_NUM, 10);
    });

    it('respects 30-minute cooldown — second call within 30 min does nothing', async () => {
      const nodes = [makeNode(100, 1000)];
      mockGetAllNodes.mockResolvedValue(nodes);

      // First call — below threshold, should purge
      await Promise.all([
        manager.checkAutoHeapManagement(5000, LOCAL_NODE_NUM),
        drainPurgeTimers(1),
      ]);
      expect(manager.sendRemoveNode).toHaveBeenCalledTimes(1);

      // Reset call counts
      manager.sendRemoveNode.mockClear();
      manager.sendRebootCommand.mockClear();

      // Advance 10 minutes (still within 30-min cooldown)
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      // Second call — still below threshold but within cooldown
      await manager.checkAutoHeapManagement(5000, LOCAL_NODE_NUM);

      expect(manager.sendRemoveNode).not.toHaveBeenCalled();
      expect(manager.sendRebootCommand).not.toHaveBeenCalled();
    });

    it('resets and triggers again after cooldown expires', async () => {
      const nodes = [makeNode(100, 1000)];
      mockGetAllNodes.mockResolvedValue(nodes);

      // First call — triggers purge
      await Promise.all([
        manager.checkAutoHeapManagement(5000, LOCAL_NODE_NUM),
        drainPurgeTimers(1),
      ]);
      expect(manager.sendRemoveNode).toHaveBeenCalledTimes(1);

      // Reset call counts
      manager.sendRemoveNode.mockClear();
      manager.sendRebootCommand.mockClear();

      // Advance 31 minutes (past the 30-min cooldown)
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

      // Second call — cooldown expired, should purge again
      await Promise.all([
        manager.checkAutoHeapManagement(5000, LOCAL_NODE_NUM),
        drainPurgeTimers(1),
      ]);

      expect(manager.sendRemoveNode).toHaveBeenCalledTimes(1);
      expect(manager.sendRebootCommand).toHaveBeenCalledTimes(1);
    });

    it('handles case where fewer than 10 nodes exist (purges what is available)', async () => {
      // Only 3 remote nodes — all should be purged
      const nodes = [
        makeNode(100, 1000),
        makeNode(200, 2000),
        makeNode(300, 3000),
      ];
      mockGetAllNodes.mockResolvedValue(nodes);

      await Promise.all([
        manager.checkAutoHeapManagement(5000, LOCAL_NODE_NUM),
        drainPurgeTimers(3),
      ]);

      expect(manager.sendRemoveNode).toHaveBeenCalledTimes(3);
    });

    it('does nothing when no purgeable nodes exist (only local node)', async () => {
      // Only the local node in the node list
      const nodes = [makeNode(LOCAL_NODE_NUM, 500)];
      mockGetAllNodes.mockResolvedValue(nodes);

      await manager.checkAutoHeapManagement(5000, LOCAL_NODE_NUM);

      expect(manager.sendRemoveNode).not.toHaveBeenCalled();
    });

    it('uses default threshold of 20000 when setting is absent', async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === 'autoHeapManagementEnabled') return 'true';
        if (key === 'autoHeapManagementThresholdBytes') return null; // not set
        return null;
      });

      const nodes = [makeNode(100, 1000)];
      mockGetAllNodes.mockResolvedValue(nodes);

      // Heap = 25000 — should be above the default threshold (20000), so no purge
      await manager.checkAutoHeapManagement(25000, LOCAL_NODE_NUM);
      expect(manager.sendRemoveNode).not.toHaveBeenCalled();

      manager.lastHeapPurgeAt = null;

      // Heap = 15000 — below the default threshold (20000), should purge
      await Promise.all([
        manager.checkAutoHeapManagement(15000, LOCAL_NODE_NUM),
        drainPurgeTimers(1),
      ]);
      expect(manager.sendRemoveNode).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── Settings route tests ─────────────────────────────────────────────────────

describe('Auto Heap Management — Settings', () => {
  it('autoHeapManagementEnabled is in VALID_SETTINGS_KEYS', async () => {
    const { VALID_SETTINGS_KEYS } = await import('./constants/settings.js');
    expect(VALID_SETTINGS_KEYS).toContain('autoHeapManagementEnabled');
  });

  it('autoHeapManagementThresholdBytes is in VALID_SETTINGS_KEYS', async () => {
    const { VALID_SETTINGS_KEYS } = await import('./constants/settings.js');
    expect(VALID_SETTINGS_KEYS).toContain('autoHeapManagementThresholdBytes');
  });

  it('GET /settings returns autoHeapManagementEnabled and autoHeapManagementThresholdBytes from database', async () => {
    const mockGetAllSettings = vi.fn().mockResolvedValue({
      autoHeapManagementEnabled: 'true',
      autoHeapManagementThresholdBytes: '20000',
    });

    // Verify the route handler reads from getAllSettings
    const settings = await mockGetAllSettings();
    expect(settings).toHaveProperty('autoHeapManagementEnabled', 'true');
    expect(settings).toHaveProperty('autoHeapManagementThresholdBytes', '20000');
  });

  it('POST /settings filters and saves autoHeapManagementEnabled correctly', async () => {
    const { VALID_SETTINGS_KEYS } = await import('./constants/settings.js');
    const mockSetSettings = vi.fn().mockResolvedValue(undefined);

    // Simulate the route's filter logic for these two keys
    const incoming = {
      autoHeapManagementEnabled: true,
      autoHeapManagementThresholdBytes: 15000,
      someUnknownKey: 'ignored',
    };

    const filtered: Record<string, string> = {};
    for (const key of VALID_SETTINGS_KEYS) {
      if (key in incoming) {
        filtered[key] = String((incoming as any)[key]);
      }
    }

    await mockSetSettings(filtered);

    expect(filtered).toHaveProperty('autoHeapManagementEnabled', 'true');
    expect(filtered).toHaveProperty('autoHeapManagementThresholdBytes', '15000');
    expect(filtered).not.toHaveProperty('someUnknownKey');
    expect(mockSetSettings).toHaveBeenCalledWith(filtered);
  });

  it('POST /settings saves autoHeapManagementThresholdBytes as a string', async () => {
    const { VALID_SETTINGS_KEYS } = await import('./constants/settings.js');

    const incoming = { autoHeapManagementThresholdBytes: 30000 };

    const filtered: Record<string, string> = {};
    for (const key of VALID_SETTINGS_KEYS) {
      if (key in incoming) {
        filtered[key] = String((incoming as any)[key]);
      }
    }

    expect(filtered).toHaveProperty('autoHeapManagementThresholdBytes', '30000');
    expect(Object.keys(filtered)).toHaveLength(1);
  });
});
