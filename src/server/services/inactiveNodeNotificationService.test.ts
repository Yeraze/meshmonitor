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
 * - #4412 Phase 2 WP4: one scheduler tick, per-source config resolved via
 *   getInactiveNodeConfig()/getSettingForSource() instead of instance fields
 *   captured at start() time. See inactiveNodeNotificationService.perSource.test.ts
 *   for the two-source cadence proof.
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
const mockGetSettingForSource = vi.fn();

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
    settings: {
      getSettingForSource: mockGetSettingForSource,
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

/**
 * Drives the mocked `getSettingForSource` used by getInactiveNodeConfig().
 * Every source resolves the SAME threshold/checkInterval/cooldown unless a
 * test overrides it — mirrors the pre-restructure defaults (24h / 60min / 24h).
 */
function setInactiveNodeConfig(overrides: { threshold?: number; checkInterval?: number; cooldown?: number } = {}) {
  const { threshold = 24, checkInterval = 60, cooldown = 24 } = overrides;
  mockGetSettingForSource.mockImplementation(async (_sourceId: string | null | undefined, key: string) => {
    switch (key) {
      case 'inactiveNodeThresholdHours':
        return String(threshold);
      case 'inactiveNodeCheckIntervalMinutes':
        return String(checkInterval);
      case 'inactiveNodeCooldownHours':
        return String(cooldown);
      default:
        return null;
    }
  });
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
    setInactiveNodeConfig();

    const module = await import('./inactiveNodeNotificationService.js');
    service = module.inactiveNodeNotificationService;

    // Reset internal state (stop() clears tickTimer/initialTimeout/running/nextRunAt).
    service.stop();
    service.lastNotifiedNodes = new Map();
    service.hourlyLog.reset();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  describe('tick (scheduler pass)', () => {
    it('should skip when no users have notifications enabled', async () => {
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([]);

      await service.tick();

      expect(mockGetUsersWithInactiveNodeNotifications).toHaveBeenCalled();
      expect(mockGetInactiveMonitoredNodesAsync).not.toHaveBeenCalled();
    });

    it('should skip users with no monitored nodes', async () => {
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: null }),
      ]);

      await service.tick();

      expect(mockGetInactiveMonitoredNodesAsync).not.toHaveBeenCalled();
      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should skip users with empty monitored nodes list', async () => {
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: '[]' }),
      ]);

      await service.tick();

      expect(mockGetInactiveMonitoredNodesAsync).not.toHaveBeenCalled();
    });

    it('should query for inactive nodes using parsed monitored list', async () => {
      const monitoredNodes = ['!aabbccdd', '!11223344'];
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: JSON.stringify(monitoredNodes) }),
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([]);

      await service.tick();

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

      await service.tick();

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

      // First tick — should send
      await service.tick();
      expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledTimes(1);

      // Second tick immediately — the source's own checkIntervalMinutes (60)
      // would normally make it not-due yet; force it due via reschedule()
      // (its own public API) so this test isolates cooldown behaviour from
      // scheduling cadence (that's inactiveNodeNotificationService.perSource.test.ts).
      mockBroadcastToPreferenceUsers.mockClear();
      service.reschedule();
      await service.tick();
      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should handle malformed monitored_nodes JSON gracefully', async () => {
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: 'not valid json' }),
      ]);

      await service.tick();

      // Should not crash, should not query for nodes
      expect(mockGetInactiveMonitoredNodesAsync).not.toHaveBeenCalled();
    });

    it('should not send notification when no nodes are inactive', async () => {
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: '["!aabbccdd"]' }),
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([]);

      await service.tick();

      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('should use this source\'s threshold hours for cutoff calculation', async () => {
      setInactiveNodeConfig({ threshold: 12 });
      const now = Date.now();
      const expectedCutoff = Math.floor(now / 1000) - 12 * 3600;

      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: '["!aabbccdd"]' }),
      ]);
      mockGetInactiveMonitoredNodesAsync.mockResolvedValue([]);

      await service.tick();

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

      await service.tick();

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

      await service.tick();

      const call = mockGetInactiveMonitoredNodesAsync.mock.calls[0];
      expect(call[0].sort()).toEqual(['!11223344', '!aabbccdd']);
    });
  });

  describe('tick (MeshCore source)', () => {
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
      setInactiveNodeConfig({ threshold: 12 });
      const now = Date.now();
      const expectedCutoffMs = now - 12 * 60 * 60 * 1000;

      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ sourceId: 'mc1', monitoredNodes: JSON.stringify([MC_NODE_ID]) }),
      ]);
      mockGetInactiveMeshcoreNodes.mockResolvedValue([]);

      await service.tick();

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

      await service.tick();

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

      await service.tick();

      expect(mockBroadcastToPreferenceUsers).not.toHaveBeenCalled();
    });
  });

  describe('start / stop / getStatus', () => {
    it('sets running=true synchronously in start(), before the warm-up timer fires', () => {
      // Regression guard (#4412 Phase 2): getStatus() used to derive `running`
      // from the interval handle, which doesn't exist until t+60s — that would
      // incorrectly report `false` for the first minute after start().
      service.start();
      expect(service.getStatus().running).toBe(true);
    });

    it('stop() clears running, both timers, and nextRunAt', async () => {
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([]);

      service.start();
      service.nextRunAt.set('src1', Date.now() + 999_999);
      service.stop();

      expect(service.getStatus().running).toBe(false);
      expect(service.nextRunAt.size).toBe(0);

      // No pending timers survive the stop — advancing well past both the
      // warm-up delay and a tick interval fires nothing.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(mockGetUsersWithInactiveNodeNotifications).not.toHaveBeenCalled();
    });

    it('calling start() twice warns and does not schedule a second timer pair', async () => {
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([]);

      service.start();
      service.start();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockGetUsersWithInactiveNodeNotifications).toHaveBeenCalledTimes(1);
    });
  });

  describe('reschedule', () => {
    it('reschedule(sourceId) invalidates only that source\'s nextRunAt', () => {
      const now = Date.now();
      service.nextRunAt.set('srcA', now + 999_999);
      service.nextRunAt.set('srcB', now + 999_999);

      service.reschedule('srcA');

      expect(service.nextRunAt.has('srcA')).toBe(false);
      expect(service.nextRunAt.has('srcB')).toBe(true);
    });

    it('reschedule() with no argument invalidates every source', () => {
      const now = Date.now();
      service.nextRunAt.set('srcA', now + 999_999);
      service.nextRunAt.set('srcB', now + 999_999);

      service.reschedule();

      expect(service.nextRunAt.size).toBe(0);
    });
  });

  describe('tick scheduling edge cases', () => {
    it('no eligible users does not advance nextRunAt — the source is retried on the very next tick', async () => {
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([]);

      await service.tick();
      expect(mockGetUsersWithInactiveNodeNotifications).toHaveBeenCalledTimes(1);
      expect(service.nextRunAt.has('src1')).toBe(false);

      await service.tick();
      expect(mockGetUsersWithInactiveNodeNotifications).toHaveBeenCalledTimes(2);
    });

    it('a throwing source does not abort the tick for other sources, and does not hot-loop', async () => {
      mockGetAllManagers.mockReturnValue([
        { sourceId: 'srcA', sourceType: 'meshtastic_tcp' },
        { sourceId: 'srcB', sourceType: 'meshtastic_tcp' },
      ]);
      const lastHeardSeconds = Math.floor(Date.now() / 1000) - 48 * 3600;
      mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
        makeRow({ monitoredNodes: '["!aabbccdd"]' }),
      ]);
      mockGetInactiveMonitoredNodesAsync.mockImplementation(async (_ids: string[], _cutoff: number, sourceId: string) => {
        if (sourceId === 'srcA') throw new Error('boom');
        return [{ nodeNum: 2864434397, nodeId: '!aabbccdd', longName: 'Test Node', shortName: 'TN', lastHeard: lastHeardSeconds }];
      });

      await service.tick();

      // srcB was processed and notified despite srcA throwing.
      expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledTimes(1);
      expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledWith(
        'notifyOnInactiveNode',
        expect.objectContaining({ sourceId: 'srcB' }),
        1
      );

      // srcA's nextRunAt was still advanced (set BEFORE the throwing work),
      // so it is exactly as "not due" as the well-behaved srcB on the very
      // next tick — proving the throw did not leave it hot-looping.
      mockGetInactiveMonitoredNodesAsync.mockClear();
      await service.tick();
      expect(mockGetInactiveMonitoredNodesAsync).not.toHaveBeenCalled();
    });
  });
});
