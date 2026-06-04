/**
 * Tests for LowBatteryNotificationService
 *
 * Verifies:
 * - Database-agnostic queries via DatabaseService facade
 * - User monitoring list parsing and filtering
 * - Per-user battery threshold handling
 * - Notification cooldown logic
 * - Per-source permission gating
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before any imports
const mockGetUsersWithLowBatteryNotifications = vi.fn();
const mockGetLowBatteryMonitoredNodes = vi.fn();
const mockCheckPermissionAsync = vi.fn();
const mockGetSource = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    notifications: {
      getUsersWithLowBatteryNotifications: mockGetUsersWithLowBatteryNotifications,
    },
    nodes: {
      getLowBatteryMonitoredNodes: mockGetLowBatteryMonitoredNodes,
    },
    sources: {
      getSource: mockGetSource,
    },
    checkPermissionAsync: mockCheckPermissionAsync,
  },
}));

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

describe('LowBatteryNotificationService', () => {
  let service: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));

    mockGetAllManagers.mockReturnValue([{ sourceId: 'src1' }]);
    mockGetSource.mockResolvedValue({ id: 'src1', name: 'Source One' });
    mockCheckPermissionAsync.mockResolvedValue(true);

    const module = await import('./lowBatteryNotificationService.js');
    service = module.lowBatteryNotificationService;

    // Reset internal state
    service.lastNotifiedNodes = new Map();
    service.currentCooldownHours = 24;
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  describe('checkLowBatteryNodes', () => {
    it('should skip when no users have notifications enabled', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([]);

      await service.checkLowBatteryNodes();

      expect(mockGetUsersWithLowBatteryNotifications).toHaveBeenCalled();
      expect(mockGetLowBatteryMonitoredNodes).not.toHaveBeenCalled();
    });

    it('should skip users with no monitored nodes', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        { userId: 1, monitoredNodes: null, lowBatteryThreshold: 20 },
      ]);

      await service.checkLowBatteryNodes();

      expect(mockGetLowBatteryMonitoredNodes).not.toHaveBeenCalled();
      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should query using the user threshold', async () => {
      const monitoredNodes = ['!aabbccdd', '!11223344'];
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        { userId: 1, monitoredNodes: JSON.stringify(monitoredNodes), lowBatteryThreshold: 15 },
      ]);
      mockGetLowBatteryMonitoredNodes.mockResolvedValue([]);

      await service.checkLowBatteryNodes();

      expect(mockGetLowBatteryMonitoredNodes).toHaveBeenCalledWith(
        monitoredNodes,
        15,
        'src1'
      );
    });

    it('should fall back to the default threshold when the user threshold is invalid', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        { userId: 1, monitoredNodes: '["!aabbccdd"]', lowBatteryThreshold: null },
      ]);
      mockGetLowBatteryMonitoredNodes.mockResolvedValue([]);

      await service.checkLowBatteryNodes();

      expect(mockGetLowBatteryMonitoredNodes).toHaveBeenCalledWith(
        ['!aabbccdd'],
        20,
        'src1'
      );
    });

    it('should send notification for low battery nodes', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        { userId: 1, monitoredNodes: '["!aabbccdd"]', lowBatteryThreshold: 20 },
      ]);
      mockGetLowBatteryMonitoredNodes.mockResolvedValue([
        { nodeNum: 2864434397, nodeId: '!aabbccdd', longName: 'Test Node', shortName: 'TN', batteryLevel: 8 },
      ]);
      mockBroadcastToPreferenceUsers.mockResolvedValue(undefined);

      await service.checkLowBatteryNodes();

      expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledWith(
        'notifyOnLowBattery',
        expect.objectContaining({
          title: expect.stringContaining('Test Node'),
          body: expect.stringContaining('8%'),
        }),
        1
      );
    });

    it('should respect notification cooldown', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        { userId: 1, monitoredNodes: '["!aabbccdd"]', lowBatteryThreshold: 20 },
      ]);
      mockGetLowBatteryMonitoredNodes.mockResolvedValue([
        { nodeNum: 2864434397, nodeId: '!aabbccdd', longName: 'Test Node', shortName: 'TN', batteryLevel: 8 },
      ]);
      mockBroadcastToPreferenceUsers.mockResolvedValue(undefined);

      await service.checkLowBatteryNodes();
      expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledTimes(1);

      mockBroadcastToPreferenceUsers.mockClear();
      await service.checkLowBatteryNodes();
      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should skip users without nodes:read permission on the source', async () => {
      mockCheckPermissionAsync.mockResolvedValue(false);
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        { userId: 1, monitoredNodes: '["!aabbccdd"]', lowBatteryThreshold: 20 },
      ]);

      await service.checkLowBatteryNodes();

      expect(mockGetLowBatteryMonitoredNodes).not.toHaveBeenCalled();
      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should handle malformed monitored_nodes JSON gracefully', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        { userId: 1, monitoredNodes: 'not valid json', lowBatteryThreshold: 20 },
      ]);

      await service.checkLowBatteryNodes();

      expect(mockGetLowBatteryMonitoredNodes).not.toHaveBeenCalled();
    });

    it('should not send notification when no nodes are below threshold', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        { userId: 1, monitoredNodes: '["!aabbccdd"]', lowBatteryThreshold: 20 },
      ]);
      mockGetLowBatteryMonitoredNodes.mockResolvedValue([]);

      await service.checkLowBatteryNodes();

      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });
  });

  describe('start/stop', () => {
    it('should start and stop cleanly', () => {
      service.start(60, 24);
      expect(service.getStatus().running).toBe(true);

      service.stop();
      expect(service.getStatus().running).toBe(false);
    });
  });
});
