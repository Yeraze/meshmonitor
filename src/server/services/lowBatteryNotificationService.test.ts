/**
 * Tests for LowBatteryNotificationService
 *
 * Verifies:
 * - Database-agnostic queries via DatabaseService facade
 * - User monitoring list parsing and filtering
 * - Per-user battery threshold handling
 * - Notification cooldown logic
 * - Per-source permission gating
 * - #4020: split-row merge (eligibility/monitored-nodes/threshold resolved
 *   across ALL of a user's (userId, sourceId) rows, not just one)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before any imports
const mockGetUsersWithLowBatteryNotifications = vi.fn();
const mockGetLowBatteryMonitoredNodes = vi.fn();
const mockGetLowVoltageNodes = vi.fn();
const mockCheckPermissionAsync = vi.fn();
const mockGetSource = vi.fn();
const mockGetUserPreferenceRows = vi.fn();
const mockGetAllPreferenceUserIds = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    notifications: {
      getUsersWithLowBatteryNotifications: mockGetUsersWithLowBatteryNotifications,
      getUserPreferenceRows: mockGetUserPreferenceRows,
      getAllPreferenceUserIds: mockGetAllPreferenceUserIds,
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

/** Build a flagged preference row as returned by getUsersWithLowBatteryNotifications. */
function makeRow(overrides: Partial<{
  userId: number;
  sourceId: string;
  notifyOnLowBattery: boolean;
  notifyOnMessage: boolean;
  appriseEnabled: boolean;
  monitoredNodes: string | null;
  lowBatteryThreshold: number | null;
  lowBatteryVoltageThreshold: number | null;
  appriseUrlCount: number;
}> = {}) {
  return {
    userId: 1,
    sourceId: '',
    notifyOnLowBattery: true,
    notifyOnMessage: true,
    appriseEnabled: false,
    monitoredNodes: null,
    lowBatteryThreshold: 20,
    lowBatteryVoltageThreshold: 3300,
    appriseUrlCount: 0,
    ...overrides,
  };
}

describe('LowBatteryNotificationService', () => {
  let service: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));

    mockGetAllManagers.mockReturnValue([{ sourceId: 'src1', sourceType: 'meshtastic_tcp' }]);
    mockGetSource.mockResolvedValue({ id: 'src1', name: 'Source One' });
    mockCheckPermissionAsync.mockResolvedValue(true);
    mockGetUserPreferenceRows.mockResolvedValue([]);
    mockGetAllPreferenceUserIds.mockResolvedValue([]);
    mockBroadcastToPreferenceUsers.mockResolvedValue({ sent: 1, failed: 0, filtered: 0 });

    const module = await import('./lowBatteryNotificationService.js');
    service = module.lowBatteryNotificationService;

    // Reset internal state
    service.lastNotifiedNodes = new Map();
    service.currentCooldownHours = 24;
    service.hourlyLog.reset();
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
        makeRow({ monitoredNodes: null, lowBatteryThreshold: 20 }),
      ]);

      await service.checkLowBatteryNodes();

      expect(mockGetLowBatteryMonitoredNodes).not.toHaveBeenCalled();
      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should query using the user threshold', async () => {
      const monitoredNodes = ['!aabbccdd', '!11223344'];
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: JSON.stringify(monitoredNodes), lowBatteryThreshold: 15 }),
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
        makeRow({ monitoredNodes: '["!aabbccdd"]', lowBatteryThreshold: null }),
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
        makeRow({ monitoredNodes: '["!aabbccdd"]', lowBatteryThreshold: 20 }),
      ]);
      mockGetLowBatteryMonitoredNodes.mockResolvedValue([
        { nodeNum: 2864434397, nodeId: '!aabbccdd', longName: 'Test Node', shortName: 'TN', batteryLevel: 8 },
      ]);

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
        makeRow({ monitoredNodes: '["!aabbccdd"]', lowBatteryThreshold: 20 }),
      ]);
      mockGetLowBatteryMonitoredNodes.mockResolvedValue([
        { nodeNum: 2864434397, nodeId: '!aabbccdd', longName: 'Test Node', shortName: 'TN', batteryLevel: 8 },
      ]);

      await service.checkLowBatteryNodes();
      expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledTimes(1);

      mockBroadcastToPreferenceUsers.mockClear();
      await service.checkLowBatteryNodes();
      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should skip users without nodes:read permission on the source', async () => {
      mockCheckPermissionAsync.mockResolvedValue(false);
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: '["!aabbccdd"]', lowBatteryThreshold: 20 }),
      ]);

      await service.checkLowBatteryNodes();

      expect(mockGetLowBatteryMonitoredNodes).not.toHaveBeenCalled();
      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should handle malformed monitored_nodes JSON gracefully', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: 'not valid json', lowBatteryThreshold: 20 }),
      ]);

      await service.checkLowBatteryNodes();

      expect(mockGetLowBatteryMonitoredNodes).not.toHaveBeenCalled();
    });

    it('should not send notification when no nodes are below threshold', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: '["!aabbccdd"]', lowBatteryThreshold: 20 }),
      ]);
      mockGetLowBatteryMonitoredNodes.mockResolvedValue([]);

      await service.checkLowBatteryNodes();

      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });
  });

  describe('#4020 — split-row regression', () => {
    it('THE regression test: flag on one row, monitored nodes + threshold on another row for the same user', async () => {
      // Row A: flag is set here, but no monitored nodes, no channel.
      // Row B: flag is OFF here, but monitored nodes AND the voltage threshold live here.
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        makeRow({ userId: 1, sourceId: '', notifyOnLowBattery: true, notifyOnMessage: false, appriseEnabled: false, monitoredNodes: null }),
        makeRow({ userId: 1, sourceId: 'mc-uuid', notifyOnLowBattery: false, monitoredNodes: JSON.stringify(['mc:mc-uuid:aabbccddeeff']), lowBatteryVoltageThreshold: 4200 }),
      ]);
      mockGetAllManagers.mockReturnValue([{ sourceId: 'mc-uuid', sourceType: 'meshcore' }]);
      mockGetSource.mockResolvedValue({ id: 'mc-uuid', name: 'MeshCore Source' });
      mockGetLowVoltageNodes.mockResolvedValue([
        { publicKey: 'aabbccddeeff00112233445566778899', name: 'Repeater A', batteryMv: 3895 },
      ]);

      await service.checkLowBatteryNodes();

      // Prior to #4020 this never fired: the gate query returned only ONE row
      // (whichever the DB happened to pick), so either the flag or the
      // monitored-nodes/threshold data was missing and the check silently
      // no-opped every cycle.
      expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledWith(
        'notifyOnLowBattery',
        expect.objectContaining({
          body: expect.stringContaining('4200mV'),
        }),
        1
      );
    });

    it('threshold precedence: exact-source row wins over the \'\' row', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        makeRow({ userId: 1, sourceId: '', lowBatteryThreshold: 99 }),
        makeRow({ userId: 1, sourceId: 'src1', lowBatteryThreshold: 5, monitoredNodes: '["!aabbccdd"]' }),
      ]);
      mockGetLowBatteryMonitoredNodes.mockResolvedValue([]);

      await service.checkLowBatteryNodes();

      expect(mockGetLowBatteryMonitoredNodes).toHaveBeenCalledWith(['!aabbccdd'], 5, 'src1');
    });

    it('threshold precedence: falls back to the \'\' row when there is no exact-source row', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        makeRow({ userId: 1, sourceId: '', lowBatteryThreshold: 7, monitoredNodes: '["!aabbccdd"]' }),
        makeRow({ userId: 1, sourceId: 'other-src', lowBatteryThreshold: 88 }),
      ]);
      mockGetLowBatteryMonitoredNodes.mockResolvedValue([]);

      await service.checkLowBatteryNodes();

      // src1 (the only configured manager) has no row of its own — falls back to ''.
      expect(mockGetLowBatteryMonitoredNodes).toHaveBeenCalledWith(['!aabbccdd'], 7, 'src1');
    });

    it('threshold precedence: falls back to the first row (by sourceId ASC) when neither exact nor \'\' exist', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        makeRow({ userId: 1, sourceId: 'aaa-src', lowBatteryThreshold: 3, monitoredNodes: '["!aabbccdd"]' }),
        makeRow({ userId: 1, sourceId: 'zzz-src', lowBatteryThreshold: 88 }),
      ]);
      mockGetLowBatteryMonitoredNodes.mockResolvedValue([]);

      await service.checkLowBatteryNodes();

      expect(mockGetLowBatteryMonitoredNodes).toHaveBeenCalledWith(['!aabbccdd'], 3, 'src1');
    });

    it('sends a single notification for a user with 2 eligible rows on the same source (no duplicate sends)', async () => {
      // Both rows resolve to the SAME source ('' falls back to itself as the
      // thresholdRow when there is no exact-source row) — must not double-send.
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        makeRow({ userId: 1, sourceId: '', notifyOnLowBattery: true, monitoredNodes: '["!aabbccdd"]' }),
        makeRow({ userId: 1, sourceId: 'unrelated-src', notifyOnLowBattery: true }),
      ]);
      mockGetLowBatteryMonitoredNodes.mockResolvedValue([
        { nodeNum: 1, nodeId: '!aabbccdd', longName: 'N', shortName: 'N', batteryLevel: 5 },
      ]);

      await service.checkLowBatteryNodes();

      // Only one manager (src1) is registered, so only one send happens
      // regardless of how many preference rows exist for the user.
      expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledTimes(1);
    });

    it('re-emits the MeshCore diagnostic hourly rather than once-per-process', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        makeRow({ userId: 1, sourceId: 'mc1', monitoredNodes: '["mc:mc1:aabbccddeeff"]' }),
      ]);
      mockGetAllManagers.mockReturnValue([{ sourceId: 'mc1', sourceType: 'meshcore' }]);
      mockGetSource.mockResolvedValue({ id: 'mc1', name: 'MeshCore One' });
      mockGetLowVoltageNodes.mockResolvedValue([]);

      const { logger } = await import('../../utils/logger.js');
      const infoSpy = logger.info as any;

      await service.checkLowBatteryNodes();
      const callsAfterFirst = infoSpy.mock.calls.filter((c: any[]) => String(c[0]).includes('[MeshCore low-battery]')).length;
      expect(callsAfterFirst).toBe(1);

      // Immediately re-running should NOT re-log within the hour.
      await service.checkLowBatteryNodes();
      const callsAfterSecond = infoSpy.mock.calls.filter((c: any[]) => String(c[0]).includes('[MeshCore low-battery]')).length;
      expect(callsAfterSecond).toBe(1);

      // Advance more than an hour — should log again.
      vi.setSystemTime(new Date('2026-03-15T13:01:00Z'));
      await service.checkLowBatteryNodes();
      const callsAfterThird = infoSpy.mock.calls.filter((c: any[]) => String(c[0]).includes('[MeshCore low-battery]')).length;
      expect(callsAfterThird).toBe(2);
    });

    it('logs a rate-limited WARN when a matched alert delivers to nobody', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        makeRow({ userId: 1, sourceId: 'src1', monitoredNodes: '["!aabbccdd"]' }),
      ]);
      mockGetLowBatteryMonitoredNodes.mockResolvedValue([
        { nodeNum: 1, nodeId: '!aabbccdd', longName: 'N', shortName: 'N', batteryLevel: 5 },
      ]);
      mockBroadcastToPreferenceUsers.mockResolvedValue({ sent: 0, failed: 0, filtered: 2 });

      const { logger } = await import('../../utils/logger.js');

      await service.checkLowBatteryNodes();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('matched but 0 notifications delivered')
      );
    });
  });

  describe('MeshCore voltage alerts', () => {
    const PUBKEY = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
    const NODE_ID = `mc:mc1:${PUBKEY.substring(0, 12)}`; // mc:mc1:aabbccddeeff

    beforeEach(() => {
      // MeshCore managers now live in the unified sourceManagerRegistry.
      // The service calls getAllManagers() which returns all source types.
      mockGetAllManagers.mockReturnValue([{ sourceId: 'mc1', sourceType: 'meshcore' }]);
      mockGetSource.mockResolvedValue({ id: 'mc1', name: 'MeshCore One' });
    });

    it('queries meshcore low-voltage nodes with the user voltage threshold', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        makeRow({ sourceId: 'mc1', monitoredNodes: JSON.stringify([NODE_ID]), lowBatteryVoltageThreshold: 3200 }),
      ]);
      mockGetLowVoltageNodes.mockResolvedValue([]);

      await service.checkLowBatteryNodes();

      // Voltage path is used, not the Meshtastic percentage path
      expect(mockGetLowVoltageNodes).toHaveBeenCalledWith('mc1', 3200);
      expect(mockGetLowBatteryMonitoredNodes).not.toHaveBeenCalled();
    });

    it('falls back to the default voltage threshold (3300mV) when unset', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        makeRow({ sourceId: 'mc1', monitoredNodes: JSON.stringify([NODE_ID]), lowBatteryVoltageThreshold: null }),
      ]);
      mockGetLowVoltageNodes.mockResolvedValue([]);

      await service.checkLowBatteryNodes();

      expect(mockGetLowVoltageNodes).toHaveBeenCalledWith('mc1', 3300);
    });

    it('sends a voltage-worded notification for a monitored low node', async () => {
      mockGetUsersWithLowBatteryNotifications.mockResolvedValue([
        makeRow({ sourceId: 'mc1', monitoredNodes: JSON.stringify([NODE_ID]), lowBatteryVoltageThreshold: 3300 }),
      ]);
      mockGetLowVoltageNodes.mockResolvedValue([
        { publicKey: PUBKEY, name: 'Repeater A', batteryMv: 3100 },
      ]);

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
        makeRow({ sourceId: 'mc1', monitoredNodes: JSON.stringify(['mc:mc1:ffffffffffff']), lowBatteryVoltageThreshold: 3300 }),
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
