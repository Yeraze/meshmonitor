/**
 * Tests for InactiveNodeNotificationService
 *
 * Verifies:
 * - Database-agnostic queries via DatabaseService facade
 * - User monitoring list parsing and filtering
 * - Notification cooldown logic
 * - Inactive node detection threshold
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before any imports
const mockGetUsersWithInactiveNodeNotificationsAsync = vi.fn();
const mockGetInactiveMonitoredNodesAsync = vi.fn();
const mockFindUserByIdAsync = vi.fn();
const mockFindUserByUsernameAsync = vi.fn();
const mockCheckPermissionAsync = vi.fn();
const mockGetUserPermissionSetAsync = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    getUsersWithInactiveNodeNotificationsAsync: mockGetUsersWithInactiveNodeNotificationsAsync,
    getInactiveMonitoredNodesAsync: mockGetInactiveMonitoredNodesAsync,
    findUserByIdAsync: mockFindUserByIdAsync,
    findUserByUsernameAsync: mockFindUserByUsernameAsync,
    checkPermissionAsync: mockCheckPermissionAsync,
    getUserPermissionSetAsync: mockGetUserPermissionSetAsync,
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

describe('InactiveNodeNotificationService', () => {
  let service: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));

    const module = await import('./inactiveNodeNotificationService.js');
    service = module.inactiveNodeNotificationService;

    // Reset internal state
    service.lastNotifiedNodes = new Map();
    service.currentThresholdHours = 24;
    service.currentCooldownHours = 24;
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  describe('checkInactiveNodes', () => {
    it('should skip when no users have notifications enabled', async () => {
      mockGetUsersWithInactiveNodeNotificationsAsync.mockResolvedValue([]);

      await service.checkInactiveNodes();

      expect(mockGetUsersWithInactiveNodeNotificationsAsync).toHaveBeenCalled();
      expect(mockGetInactiveMonitoredNodesAsync).not.toHaveBeenCalled();
    });

    it('should skip users with no monitored nodes', async () => {
      mockGetUsersWithInactiveNodeNotificationsAsync.mockResolvedValue([
        { userId: 1, monitoredNodes: null },
      ]);

      await service.checkInactiveNodes();

      expect(mockGetInactiveMonitoredNodesAsync).not.toHaveBeenCalled();
      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should skip users with empty monitored nodes list', async () => {
      mockGetUsersWithInactiveNodeNotificationsAsync.mockResolvedValue([
        { userId: 1, monitoredNodes: '[]' },
      ]);

      await service.checkInactiveNodes();

      expect(mockGetInactiveMonitoredNodesAsync).not.toHaveBeenCalled();
    });

    it('should query for inactive nodes using parsed monitored list', async () => {
      const monitoredNodes = ['!aabbccdd', '!11223344'];
      mockGetUsersWithInactiveNodeNotificationsAsync.mockResolvedValue([
        { userId: 1, monitoredNodes: JSON.stringify(monitoredNodes) },
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([]);

      await service.checkInactiveNodes();

      expect(mockGetInactiveMonitoredNodesAsync).toHaveBeenCalledWith(
        monitoredNodes,
        expect.any(Number)
      );
    });

    it('should send notification for inactive nodes', async () => {
      const now = Date.now();
      const lastHeardSeconds = Math.floor(now / 1000) - 48 * 3600; // 48 hours ago

      mockGetUsersWithInactiveNodeNotificationsAsync.mockResolvedValue([
        { userId: 1, monitoredNodes: '["!aabbccdd"]' },
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([
        { nodeNum: 2864434397, nodeId: '!aabbccdd', longName: 'Test Node', shortName: 'TN', lastHeard: lastHeardSeconds },
      ]);
      mockBroadcastToPreferenceUsers.mockResolvedValue(undefined);

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

      mockGetUsersWithInactiveNodeNotificationsAsync.mockResolvedValue([
        { userId: 1, monitoredNodes: '["!aabbccdd"]' },
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([
        { nodeNum: 2864434397, nodeId: '!aabbccdd', longName: 'Test Node', shortName: 'TN', lastHeard: lastHeardSeconds },
      ]);
      mockBroadcastToPreferenceUsers.mockResolvedValue(undefined);

      // First check — should send
      await service.checkInactiveNodes();
      expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledTimes(1);

      // Second check immediately — should be cooled down
      mockBroadcastToPreferenceUsers.mockClear();
      await service.checkInactiveNodes();
      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should handle malformed monitored_nodes JSON gracefully', async () => {
      mockGetUsersWithInactiveNodeNotificationsAsync.mockResolvedValue([
        { userId: 1, monitoredNodes: 'not valid json' },
      ]);

      await service.checkInactiveNodes();

      // Should not crash, should not query for nodes
      expect(mockGetInactiveMonitoredNodesAsync).not.toHaveBeenCalled();
    });

    it('should not send notification when no nodes are inactive', async () => {
      mockGetUsersWithInactiveNodeNotificationsAsync.mockResolvedValue([
        { userId: 1, monitoredNodes: '["!aabbccdd"]' },
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([]);

      await service.checkInactiveNodes();

      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should use threshold hours for cutoff calculation', async () => {
      service.currentThresholdHours = 12; // 12 hour threshold
      const now = Date.now();
      const expectedCutoff = Math.floor(now / 1000) - 12 * 3600;

      mockGetUsersWithInactiveNodeNotificationsAsync.mockResolvedValue([
        { userId: 1, monitoredNodes: '["!aabbccdd"]' },
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([]);

      await service.checkInactiveNodes();

      expect(mockGetInactiveMonitoredNodesAsync).toHaveBeenCalledWith(
        ['!aabbccdd'],
        expectedCutoff
      );
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
