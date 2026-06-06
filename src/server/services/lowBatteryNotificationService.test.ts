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
const mockGetLowVoltageNodes = vi.fn();
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
    meshcore: {
      getLowVoltageNodes: mockGetLowVoltageNodes,
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

    mockGetAllManagers.mockReturnValue([{ sourceId: 'src1', sourceType: 'meshtastic_tcp' }]);
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

  describe('MeshCore voltage alerts', () => {
    const PUBKEY = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
    const NODE_ID = `mc:mc1:${PUBKEY.substring(0, 12)}`; // mc:mc1:aabbccddeeff

    beforeEach(() => {
      // Only a MeshCore source is registered for these tests
      mockGetAllManagers.mockReturnValue([{ sourceId: 'mc1', sourceType: 'meshcore' }]);
      mockGetSource.mockResolvedValue({ id: 'mc1', name: 'MeshCore One' });
    });

    it('queries meshcore low-voltage nodes with the user voltage threshold', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        { userId: 1, monitoredNodes: JSON.stringify([NODE_ID]), lowBatteryThreshold: 20, lowBatteryVoltageThreshold: 3200 },
      ]);
      mockGetLowVoltageNodes.mockResolvedValue([]);

      await service.checkLowBatteryNodes();

      // Voltage path is used, not the Meshtastic percentage path
      expect(mockGetLowVoltageNodes).toHaveBeenCalledWith('mc1', 3200);
      expect(mockGetLowBatteryMonitoredNodes).not.toHaveBeenCalled();
    });

    it('falls back to the default voltage threshold (3300mV) when unset', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        { userId: 1, monitoredNodes: JSON.stringify([NODE_ID]), lowBatteryThreshold: 20, lowBatteryVoltageThreshold: null },
      ]);
      mockGetLowVoltageNodes.mockResolvedValue([]);

      await service.checkLowBatteryNodes();

      expect(mockGetLowVoltageNodes).toHaveBeenCalledWith('mc1', 3300);
    });

    it('sends a voltage-worded notification for a monitored low node', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        { userId: 1, monitoredNodes: JSON.stringify([NODE_ID]), lowBatteryThreshold: 20, lowBatteryVoltageThreshold: 3300 },
      ]);
      mockGetLowVoltageNodes.mockResolvedValue([
        { publicKey: PUBKEY, name: 'Repeater A', batteryMv: 3100 },
      ]);
      mockBroadcastToPreferenceUsers.mockResolvedValue(undefined);

      await service.checkLowBatteryNodes();

      expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledWith(
        'notifyOnLowBattery',
        expect.objectContaining({
          title: expect.stringContaining('Repeater A'),
          body: expect.stringContaining('3100mV'),
        }),
        1
      );
    });

    it('ignores low-voltage nodes that are not in the monitored list', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        { userId: 1, monitoredNodes: JSON.stringify(['mc:mc1:ffffffffffff']), lowBatteryThreshold: 20, lowBatteryVoltageThreshold: 3300 },
      ]);
      mockGetLowVoltageNodes.mockResolvedValue([
        { publicKey: PUBKEY, name: 'Repeater A', batteryMv: 3100 },
      ]);

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
