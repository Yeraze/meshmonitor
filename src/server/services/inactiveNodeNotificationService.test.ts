/**
 * Tests for InactiveNodeNotificationService
 *
 * Verifies:
 * - Database-agnostic queries via DatabaseService facade
 * - User monitoring list parsing and filtering
 * - Notification cooldown logic
 * - Inactive node detection threshold
 * - #4020: split-row merge (eligibility/monitored-nodes resolved across ALL
 *   of a user's (userId, sourceId) rows, not just one)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before any imports
const mockGetUsersWithInactiveNodeNotifications = vi.fn();
const mockGetInactiveMonitoredNodesAsync = vi.fn();
const mockGetInactiveMeshcoreNodes = vi.fn();
const mockFindUserByIdAsync = vi.fn();
const mockFindUserByUsernameAsync = vi.fn();
const mockCheckPermissionAsync = vi.fn();
const mockGetUserPermissionSetAsync = vi.fn();
const mockGetUserPreferenceRows = vi.fn();
const mockGetAllPreferenceUserIds = vi.fn();

const mockGetSource = vi.fn();
vi.mock('../../services/database.js', () => ({
  default: {
    notifications: {
      getUsersWithInactiveNodeNotifications: mockGetUsersWithInactiveNodeNotifications,
      getUserPreferenceRows: mockGetUserPreferenceRows,
      getAllPreferenceUserIds: mockGetAllPreferenceUserIds,
    },
    nodes: {
      getInactiveMonitoredNodes: mockGetInactiveMonitoredNodesAsync,
    },
    meshcore: {
      getInactiveMeshcoreNodes: mockGetInactiveMeshcoreNodes,
    },
    sources: {
      getSource: mockGetSource,
    },
    findUserByIdAsync: mockFindUserByIdAsync,
    findUserByUsernameAsync: mockFindUserByUsernameAsync,
    checkPermissionAsync: mockCheckPermissionAsync,
    getUserPermissionSetAsync: mockGetUserPermissionSetAsync,
  },
}));

// Phase C: mock the source manager registry so the inactivity scan has at least one source
const mockGetAllManagers = vi.fn();
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getAllManagers: mockGetAllManagers,
  },
}));

const mockBroadcastToPreferenceUsers = vi.fn();
vi.mock('./notificationService.js', () => ({
  notificationService: {
    broadcastToPreferenceUsers: mockBroadcastToPreferenceUsers,
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/** Build a flagged preference row as returned by getUsersWithInactiveNodeNotifications. */
function makeRow(overrides: Partial<{
  userId: number;
  sourceId: string;
  notifyOnInactiveNode: boolean;
  notifyOnMessage: boolean;
  appriseEnabled: boolean;
  monitoredNodes: string | null;
  appriseUrlCount: number;
}> = {}) {
  return {
    userId: 1,
    sourceId: '',
    notifyOnInactiveNode: true,
    notifyOnMessage: true,
    appriseEnabled: false,
    monitoredNodes: null,
    appriseUrlCount: 0,
    ...overrides,
  };
}

describe('InactiveNodeNotificationService', () => {
  let service: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));

    // Phase C defaults: one Meshtastic source, no MeshCore sources
    mockGetAllManagers.mockReturnValue([{ sourceId: 'src1', sourceType: 'meshtastic_tcp' }]);
    mockGetSource.mockResolvedValue({ id: 'src1', name: 'Source One' });
    mockCheckPermissionAsync.mockResolvedValue(true);
    mockGetUserPreferenceRows.mockResolvedValue([]);
    mockGetAllPreferenceUserIds.mockResolvedValue([]);
    mockBroadcastToPreferenceUsers.mockResolvedValue({ sent: 1, failed: 0, filtered: 0 });

    const module = await import('./inactiveNodeNotificationService.js');
    service = module.inactiveNodeNotificationService;

    // Reset internal state
    service.lastNotifiedNodes = new Map();
    service.currentThresholdHours = 24;
    service.currentCooldownHours = 24;
    service.hourlyLog.reset();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  describe('checkInactiveNodes', () => {
    it('should skip when no users have notifications enabled', async () => {
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([]);

      await service.checkInactiveNodes();

      expect(mockGetUsersWithInactiveNodeNotifications).toHaveBeenCalled();
      expect(mockGetInactiveMonitoredNodesAsync).not.toHaveBeenCalled();
    });

    it('should skip users with no monitored nodes', async () => {
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: null }),
      ]);

      await service.checkInactiveNodes();

      expect(mockGetInactiveMonitoredNodesAsync).not.toHaveBeenCalled();
      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should skip users with empty monitored nodes list', async () => {
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: '[]' }),
      ]);

      await service.checkInactiveNodes();

      expect(mockGetInactiveMonitoredNodesAsync).not.toHaveBeenCalled();
    });

    it('should query for inactive nodes using parsed monitored list', async () => {
      const monitoredNodes = ['!aabbccdd', '!11223344'];
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: JSON.stringify(monitoredNodes) }),
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([]);

      await service.checkInactiveNodes();

      expect(mockGetInactiveMonitoredNodesAsync).toHaveBeenCalledWith(
        monitoredNodes,
        expect.any(Number),
        'src1'
      );
    });

    it('should send notification for inactive nodes', async () => {
      const now = Date.now();
      const lastHeardSeconds = Math.floor(now / 1000) - 48 * 3600; // 48 hours ago

      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: '["!aabbccdd"]' }),
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([
        { nodeNum: 2864434397, nodeId: '!aabbccdd', longName: 'Test Node', shortName: 'TN', lastHeard: lastHeardSeconds },
      ]);

      await service.checkInactiveNodes();

      expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledWith(
        'notifyOnInactiveNode',
        expect.objectContaining({
          title: expect.stringContaining('Test Node'),
          body: expect.stringContaining('inactive'),
        }),
        1
      );
    });

    it('should respect notification cooldown', async () => {
      const now = Date.now();
      const lastHeardSeconds = Math.floor(now / 1000) - 48 * 3600;

      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: '["!aabbccdd"]' }),
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([
        { nodeNum: 2864434397, nodeId: '!aabbccdd', longName: 'Test Node', shortName: 'TN', lastHeard: lastHeardSeconds },
      ]);

      // First check — should send
      await service.checkInactiveNodes();
      expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledTimes(1);

      // Second check immediately — should be cooled down
      mockBroadcastToPreferenceUsers.mockClear();
      await service.checkInactiveNodes();
      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should handle malformed monitored_nodes JSON gracefully', async () => {
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: 'not valid json' }),
      ]);

      await service.checkInactiveNodes();

      // Should not crash, should not query for nodes
      expect(mockGetInactiveMonitoredNodesAsync).not.toHaveBeenCalled();
    });

    it('should not send notification when no nodes are inactive', async () => {
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: '["!aabbccdd"]' }),
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([]);

      await service.checkInactiveNodes();

      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should use threshold hours for cutoff calculation', async () => {
      service.currentThresholdHours = 12; // 12 hour threshold
      const now = Date.now();
      const expectedCutoff = Math.floor(now / 1000) - 12 * 3600;

      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: '["!aabbccdd"]' }),
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([]);

      await service.checkInactiveNodes();

      expect(mockGetInactiveMonitoredNodesAsync).toHaveBeenCalledWith(
        ['!aabbccdd'],
        expectedCutoff,
        'src1'
      );
    });
  });

  describe('#4020 — split-row fragmentation regression', () => {
    it('flag on one row, monitored nodes on another row for the same user', async () => {
      const now = Date.now();
      const lastHeardSeconds = Math.floor(now / 1000) - 48 * 3600;

      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ userId: 1, sourceId: '', notifyOnInactiveNode: true, notifyOnMessage: false, monitoredNodes: null }),
        makeRow({ userId: 1, sourceId: 'src1', notifyOnInactiveNode: false, monitoredNodes: '["!aabbccdd"]' }),
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([
        { nodeNum: 2864434397, nodeId: '!aabbccdd', longName: 'Test Node', shortName: 'TN', lastHeard: lastHeardSeconds },
      ]);

      await service.checkInactiveNodes();

      // Prior to #4020, the gate query returned only one arbitrary row, so
      // either the flag or the monitored-nodes data was missing and the
      // check silently no-opped.
      expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledWith(
        'notifyOnInactiveNode',
        expect.objectContaining({ title: expect.stringContaining('Test Node') }),
        1
      );
    });

    it('unions monitored nodes across rows (dedup)', async () => {
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ userId: 1, sourceId: '', monitoredNodes: '["!aabbccdd"]' }),
        makeRow({ userId: 1, sourceId: 'other-src', monitoredNodes: '["!aabbccdd", "!11223344"]' }),
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([]);

      await service.checkInactiveNodes();

      const call = mockGetInactiveMonitoredNodesAsync.mock.calls[0];
      expect(call[0].sort()).toEqual(['!11223344', '!aabbccdd']);
    });
  });

  describe('checkInactiveNodes (MeshCore source)', () => {
    // pubkey.substring(0,12) → 'aabbccddeeff'; monitored id is mc:<sourceId>:<pubkey12>
    const PUBKEY = 'aabbccddeeff00112233445566778899';
    const MC_NODE_ID = 'mc:mc1:aabbccddeeff';

    beforeEach(() => {
      // MeshCore managers now live in the unified sourceManagerRegistry.
      // The service calls getAllManagers() which returns all source types.
      mockGetAllManagers.mockReturnValue([{ sourceId: 'mc1', sourceType: 'meshcore' }]);
      mockGetSource.mockResolvedValue({ id: 'mc1', name: 'MeshCore One' });
    });

    it('queries getInactiveMeshcoreNodes with a millisecond cutoff (lastHeard is ms)', async () => {
      service.currentThresholdHours = 12;
      const now = Date.now();
      const expectedCutoffMs = now - 12 * 60 * 60 * 1000;

      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ sourceId: 'mc1', monitoredNodes: JSON.stringify([MC_NODE_ID]) }),
      ]);
      mockGetInactiveMeshcoreNodes.mockResolvedValue([]);

      await service.checkInactiveNodes();

      // Meshtastic query must NOT be used for a MeshCore source
      expect(mockGetInactiveMonitoredNodesAsync).not.toHaveBeenCalled();
      expect(mockGetInactiveMeshcoreNodes).toHaveBeenCalledWith('mc1', expectedCutoffMs);
    });

    it('sends a notification for an inactive MeshCore node it monitors', async () => {
      const now = Date.now();
      const lastHeardMs = now - 48 * 60 * 60 * 1000; // 48 hours ago, in milliseconds

      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ sourceId: 'mc1', monitoredNodes: JSON.stringify([MC_NODE_ID]) }),
      ]);
      mockGetInactiveMeshcoreNodes.mockResolvedValue([
        { publicKey: PUBKEY, name: 'MC Node', batteryMv: 3500, lastHeard: lastHeardMs },
      ]);

      await service.checkInactiveNodes();

      expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledWith(
        'notifyOnInactiveNode',
        expect.objectContaining({
          title: expect.stringContaining('MC Node'),
          body: expect.stringContaining('48'),
          sourceId: 'mc1',
        }),
        1
      );
    });

    it('ignores MeshCore nodes that are not in the user\'s monitored list', async () => {
      const now = Date.now();
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ sourceId: 'mc1', monitoredNodes: JSON.stringify(['mc:mc1:ffffffffffff']) }),
      ]);
      mockGetInactiveMeshcoreNodes.mockResolvedValue([
        { publicKey: PUBKEY, name: 'MC Node', batteryMv: 3500, lastHeard: now - 48 * 60 * 60 * 1000 },
      ]);

      await service.checkInactiveNodes();

      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });
  });

  describe('start/stop', () => {
    it('should start and stop cleanly', () => {
      service.start(24, 60, 24);
      expect(service.getStatus().running).toBe(true);

      service.stop();
      expect(service.getStatus().running).toBe(false);
    });
  });
});
