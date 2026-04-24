/**
 * Tests for node identity guards:
 * 1. Local node echo filtering in processNodeInfoMessageProtobuf
 * 2. Local node + ghost-suppressed exclusion from key repair
 * 3. Reboot merge transition guard blocking broadcasts/repairs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before any imports
const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockUpsertNode = vi.fn();
const mockGetNode = vi.fn();
const mockGetNodesNeedingKeyRepairAsync = vi.fn();
const mockGetKeyRepairLogAsync = vi.fn();
const mockIsNodeSuppressed = vi.fn();
const mockLogKeyRepairAttempt = vi.fn();
const mockFindUserByIdAsync = vi.fn();
const mockFindUserByUsernameAsync = vi.fn();
const mockCheckPermissionAsync = vi.fn();
const mockGetUserPermissionSetAsync = vi.fn();
const mockDeleteNode = vi.fn();
const mockSuppressGhostNode = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    upsertNode: mockUpsertNode,
    getNode: mockGetNode,
    deleteNode: mockDeleteNode,
    suppressGhostNode: mockSuppressGhostNode,
    getNodesNeedingKeyRepairAsync: mockGetNodesNeedingKeyRepairAsync,
    getKeyRepairLogAsync: mockGetKeyRepairLogAsync,
    isNodeSuppressed: mockIsNodeSuppressed,
    isNodeSuppressedAsync: vi.fn().mockImplementation((...args: any[]) => Promise.resolve(mockIsNodeSuppressed(...args))),
    logKeyRepairAttempt: mockLogKeyRepairAttempt,
    logKeyRepairAttemptAsync: mockLogKeyRepairAttempt,
    clearKeyRepairStateAsync: vi.fn().mockResolvedValue(undefined),
    deleteNodeAsync: mockDeleteNode,
    findUserByIdAsync: mockFindUserByIdAsync,
    findUserByUsernameAsync: mockFindUserByUsernameAsync,
    checkPermissionAsync: mockCheckPermissionAsync,
    getUserPermissionSetAsync: mockGetUserPermissionSetAsync,
    settings: {
      getSetting: mockGetSetting,
      setSetting: mockSetSetting,
      // Per-source settings lookup — delegates to the same stub used for
      // global settings so tests can assert against `mockGetSetting`.
      getSettingForSource: vi.fn((_sourceId: string, key: string) => mockGetSetting(key)),
      setSettingForSource: vi.fn((_sourceId: string, key: string, value: string) => mockSetSetting(key, value)),
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
    recordTracerouteRequest: vi.fn(),
    isAutoTimeSyncEnabled: vi.fn().mockReturnValue(false),
    getAutoTimeSyncIntervalMinutes: vi.fn().mockReturnValue(0),
    getNodeNeedingTracerouteAsync: vi.fn().mockResolvedValue(null),
    logAutoTracerouteAttemptAsync: vi.fn().mockResolvedValue(0),
    getNodeNeedingTimeSyncAsync: vi.fn().mockResolvedValue(null),
    getNodeNeedingRemoteAdminCheckAsync: vi.fn().mockResolvedValue(null),
    updateNodeRemoteAdminStatusAsync: vi.fn().mockResolvedValue(undefined),
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

const LOCAL_NODE_NUM = 1234567890;
const LOCAL_NODE_ID = '!499602d2';
const REMOTE_NODE_NUM = 987654321;

describe('MeshtasticManager - Node Identity Guards', () => {
  let manager: any;
  let loggerModule: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    const module = await import('./meshtasticManager.js');
    manager = module.default;
    loggerModule = await import('../utils/logger.js');

    // Set up the manager with local node info
    manager.isConnected = true;
    manager.localNodeInfo = {
      nodeNum: LOCAL_NODE_NUM,
      nodeId: LOCAL_NODE_ID,
      longName: 'Test Local Node',
      shortName: 'TLN',
    };
  });

  describe('processNodeInfoMessageProtobuf - local node echo filtering', () => {
    it('should skip processing when fromNum matches local node', async () => {
      const meshPacket = { from: LOCAL_NODE_NUM, id: 100 };
      const user = { longName: 'Test Local Node', shortName: 'TLN', hwModel: 1 };

      // Call the private method directly
      await manager.processNodeInfoMessageProtobuf(meshPacket, user);

      // Should log the skip
      expect(loggerModule.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Skipping NodeInfo processing for local node')
      );

      // Should NOT upsert the node (processing was skipped)
      expect(mockUpsertNode).not.toHaveBeenCalled();
    });

    it('should process normally when fromNum is a remote node', async () => {
      const meshPacket = { from: REMOTE_NODE_NUM, id: 200 };
      const user = { longName: 'Remote Node', shortName: 'RN', hwModel: 2 };

      mockGetNode.mockReturnValue(null);

      await manager.processNodeInfoMessageProtobuf(meshPacket, user);

      // Should NOT log the skip
      expect(loggerModule.logger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('Skipping NodeInfo processing for local node')
      );

      // Should upsert the remote node
      expect(mockUpsertNode).toHaveBeenCalledWith(
        expect.objectContaining({ nodeNum: REMOTE_NODE_NUM }),
        expect.anything()
      );
    });

    it('should process normally when localNodeInfo is not yet set', async () => {
      manager.localNodeInfo = null;

      const meshPacket = { from: LOCAL_NODE_NUM, id: 300 };
      const user = { longName: 'Test Node', shortName: 'TN', hwModel: 1 };

      mockGetNode.mockReturnValue(null);

      await manager.processNodeInfoMessageProtobuf(meshPacket, user);

      // Should NOT log the skip (localNodeInfo is null)
      expect(loggerModule.logger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('Skipping NodeInfo processing for local node')
      );

      // Should upsert the node since we can't identify it as local
      expect(mockUpsertNode).toHaveBeenCalled();
    });
  });

  describe('processKeyRepairs - local node and ghost exclusion', () => {
    beforeEach(() => {
      // Set up key repair config
      manager.keyRepairIntervalMinutes = 5;
      manager.keyRepairMaxExchanges = 3;
      manager.keyRepairAutoPurge = false;
      manager.keyRepairImmediatePurge = false;

      // Mock sendNodeInfoRequest to avoid actual sends
      manager.sendNodeInfoRequest = vi.fn().mockResolvedValue(undefined);
    });

    it('should skip key repair for the local node', async () => {
      mockGetNodesNeedingKeyRepairAsync.mockResolvedValue([
        {
          nodeNum: LOCAL_NODE_NUM,
          nodeId: LOCAL_NODE_ID,
          longName: 'Test Local Node',
          attemptCount: 0,
          lastAttemptTime: null,
        },
      ]);

      await manager.processKeyRepairs();

      expect(loggerModule.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining(`Key repair: skipping local node ${LOCAL_NODE_NUM}`)
      );

      // Should not attempt repair
      expect(manager.sendNodeInfoRequest).not.toHaveBeenCalled();
    });

    it('should skip key repair for ghost-suppressed nodes', async () => {
      const ghostNodeNum = 555555;
      mockGetNodesNeedingKeyRepairAsync.mockResolvedValue([
        {
          nodeNum: ghostNodeNum,
          nodeId: '!00555555',
          longName: 'Ghost Node',
          attemptCount: 0,
          lastAttemptTime: null,
        },
      ]);
      mockIsNodeSuppressed.mockReturnValue(true);

      await manager.processKeyRepairs();

      expect(loggerModule.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining(`Key repair: skipping ghost-suppressed node ${ghostNodeNum}`)
      );

      expect(manager.sendNodeInfoRequest).not.toHaveBeenCalled();
    });

    it('should process key repair for eligible remote nodes', async () => {
      const remoteNode = {
        nodeNum: REMOTE_NODE_NUM,
        nodeId: '!3ade68b1',
        longName: 'Remote Node',
        attemptCount: 0,
        lastAttemptTime: null,
        channel: 0,
      };
      mockGetNodesNeedingKeyRepairAsync.mockResolvedValue([remoteNode]);
      mockIsNodeSuppressed.mockReturnValue(false);
      mockGetNode.mockReturnValue(remoteNode);

      await manager.processKeyRepairs();

      // Should attempt repair on the remote node
      expect(manager.sendNodeInfoRequest).toHaveBeenCalledWith(REMOTE_NODE_NUM, 0);
    });

    it('should skip all repairs when reboot merge is in progress', async () => {
      manager.rebootMergeInProgress = true;

      mockGetNodesNeedingKeyRepairAsync.mockResolvedValue([
        {
          nodeNum: REMOTE_NODE_NUM,
          nodeId: '!3ade68b1',
          longName: 'Remote Node',
          attemptCount: 0,
          lastAttemptTime: null,
        },
      ]);

      await manager.processKeyRepairs();

      expect(loggerModule.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Key repair: skipping - reboot merge in progress')
      );

      // Should not even fetch nodes
      expect(mockGetNodesNeedingKeyRepairAsync).not.toHaveBeenCalled();
    });
  });

  describe('rebootMergeInProgress guard', () => {
    it('should block sendAutoAnnouncement during reboot merge', async () => {
      manager.rebootMergeInProgress = true;

      await manager.sendAutoAnnouncement();

      expect(loggerModule.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Skipping auto-announcement - reboot merge in progress')
      );

      // Should not attempt to read announcement settings
      expect(mockGetSetting).not.toHaveBeenCalledWith('autoAnnounceMessage');
    });

    it('should block broadcastNodeInfoToChannels during reboot merge', async () => {
      manager.rebootMergeInProgress = true;

      await manager.broadcastNodeInfoToChannels([0, 1], 5);

      expect(loggerModule.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Skipping NodeInfo broadcast - reboot merge in progress')
      );
    });

    it('should allow sendAutoAnnouncement when no merge in progress', async () => {
      manager.rebootMergeInProgress = false;
      mockGetSetting.mockReturnValue('Test announcement');

      // Will try to send but may fail due to missing transport — that's fine,
      // we just verify the guard didn't block it
      try {
        await manager.sendAutoAnnouncement();
      } catch {
        // Expected — transport not set up in test
      }

      // Should have attempted to read announcement settings (past the guard)
      expect(mockGetSetting).toHaveBeenCalledWith('autoAnnounceMessage');
    });

    it('should allow broadcastNodeInfoToChannels when no merge in progress', async () => {
      manager.rebootMergeInProgress = false;
      // Not connected — will return early after the merge guard
      manager.isConnected = false;

      await manager.broadcastNodeInfoToChannels([0], 5);

      // Should have reached the connection check (past the merge guard)
      expect(loggerModule.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Cannot broadcast NodeInfo - not connected')
      );
    });

    it('rebootMergeInProgress defaults to false', () => {
      // Fresh manager should not be blocking
      expect(manager.rebootMergeInProgress).toBe(false);
    });
  });
});
