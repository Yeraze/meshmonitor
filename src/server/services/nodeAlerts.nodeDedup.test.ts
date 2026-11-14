/**
 * Inactive-node and low-battery alerts dedup BY NODE across sources (#5729,
 * decision 4):
 *  - inactive fires only when no source the user can read still hears the node;
 *  - low battery fires once per node and lists the sources (only those the
 *    user can read).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({
  getUsersWithInactiveNodeNotifications: vi.fn(),
  getUsersWithLowBatteryNotifications: vi.fn(),
  getInactiveMonitoredNodes: vi.fn(),
  getInactiveMeshcoreNodes: vi.fn(),
  heardOnAnySource: vi.fn(),
  heardOnAnySourceByKeyPrefix: vi.fn(),
  getLowBatteryMonitoredNodes: vi.fn(),
  getLowVoltageNodes: vi.fn(),
  checkPermissionAsync: vi.fn(),
  getAllManagers: vi.fn(),
  broadcastToPreferenceUsers: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    notifications: {
      getUsersWithInactiveNodeNotifications: m.getUsersWithInactiveNodeNotifications,
      getUsersWithLowBatteryNotifications: m.getUsersWithLowBatteryNotifications,
      getUserPreferenceRows: vi.fn(async () => []),
      getAllPreferenceUserIds: vi.fn(async () => []),
    },
    nodes: {
      getInactiveMonitoredNodes: m.getInactiveMonitoredNodes,
      heardOnAnySource: m.heardOnAnySource,
      getLowBatteryMonitoredNodes: m.getLowBatteryMonitoredNodes,
    },
    meshcore: {
      getInactiveMeshcoreNodes: m.getInactiveMeshcoreNodes,
      heardOnAnySourceByKeyPrefix: m.heardOnAnySourceByKeyPrefix,
      getLowVoltageNodes: m.getLowVoltageNodes,
    },
    sources: { getSource: async (id: string) => ({ id, name: `Name-${id}` }) },
    settings: { getSettingForSource: async () => null },
    checkPermissionAsync: m.checkPermissionAsync,
  },
}));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: { getAllManagers: m.getAllManagers } }));
vi.mock('./notificationService.js', () => ({ notificationService: { broadcastToPreferenceUsers: m.broadcastToPreferenceUsers } }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const MT = 'meshtastic_tcp';
const row = (over: Record<string, unknown> = {}) => ({
  userId: 1, sourceId: '', notifyOnInactiveNode: true, notifyOnLowBattery: true, notifyOnMessage: true,
  appriseEnabled: false, monitoredNodes: '["!aaaaaaaa"]', lowBatteryThreshold: 20, lowBatteryVoltageThreshold: 3300,
  appriseUrlCount: 0, ...over,
});
const quietNode = () => [{ nodeNum: 0xaaaaaaaa, nodeId: '!aaaaaaaa', longName: 'Ridge', shortName: 'RDG', lastHeard: Math.floor(Date.now() / 1000) - 3 * 86400 }];

describe('node-level dedup across sources (#5729)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
    m.getAllManagers.mockReturnValue([{ sourceId: 'A', sourceType: MT }, { sourceId: 'B', sourceType: MT }]);
    m.checkPermissionAsync.mockResolvedValue(true);
    m.broadcastToPreferenceUsers.mockResolvedValue({ sent: 1, failed: 0, filtered: 0 });
    m.getInactiveMeshcoreNodes.mockResolvedValue([]);
    m.getLowVoltageNodes.mockResolvedValue([]);
    m.heardOnAnySource.mockResolvedValue(false);
    m.heardOnAnySourceByKeyPrefix.mockResolvedValue(false);
    m.getUsersWithInactiveNodeNotifications.mockResolvedValue([row()]);
    m.getUsersWithLowBatteryNotifications.mockResolvedValue([row()]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('inactive node', () => {
    async function tick() {
      const { inactiveNodeNotificationService: svc } = await import('./inactiveNodeNotificationService.js');
      const s = svc as unknown as { lastNotifiedNodes: Map<string, number>; nextRunAt: Map<string, number>; tick: () => Promise<void> };
      return s;
    }

    it('quiet on every readable source: one alert, not one per source', async () => {
      m.getInactiveMonitoredNodes.mockResolvedValue(quietNode());
      const s = await tick();
      s.lastNotifiedNodes = new Map();
      s.nextRunAt.clear();
      await s.tick();
      expect(m.broadcastToPreferenceUsers).toHaveBeenCalledTimes(1);
      expect(m.broadcastToPreferenceUsers).toHaveBeenCalledWith('notifyOnInactiveNode', expect.objectContaining({ sourceId: 'A' }), 1);
    });

    it('quiet on A but still heard on B: no alert', async () => {
      m.getInactiveMonitoredNodes.mockImplementation(async (_ids: string[], _c: number, sourceId: string) => (sourceId === 'A' ? quietNode() : []));
      m.heardOnAnySource.mockImplementation(async (_n: number, sourceIds: string[]) => sourceIds.includes('B'));
      const s = await tick();
      s.lastNotifiedNodes = new Map();
      s.nextRunAt.clear();
      await s.tick();
      expect(m.heardOnAnySource).toHaveBeenCalledWith(0xaaaaaaaa, ['B'], expect.any(Number));
      expect(m.broadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('a source the user cannot read does not count as "still heard"', async () => {
      m.getInactiveMonitoredNodes.mockImplementation(async (_ids: string[], _c: number, sourceId: string) => (sourceId === 'A' ? quietNode() : []));
      m.checkPermissionAsync.mockImplementation(async (_u: number, _r: string, _a: string, sourceId: string) => sourceId !== 'B');
      m.heardOnAnySource.mockImplementation(async (_n: number, sourceIds: string[]) => sourceIds.includes('B'));
      const s = await tick();
      s.lastNotifiedNodes = new Map();
      s.nextRunAt.clear();
      await s.tick();
      expect(m.broadcastToPreferenceUsers).toHaveBeenCalledTimes(1);
      const payload = m.broadcastToPreferenceUsers.mock.calls[0][1] as { body: string };
      expect(payload.body).not.toContain('Name-B');
    });

    it('MeshCore: the same key on two sources is one node', async () => {
      m.getAllManagers.mockReturnValue([{ sourceId: 'MA', sourceType: 'meshcore' }, { sourceId: 'MB', sourceType: 'meshcore' }]);
      m.getUsersWithInactiveNodeNotifications.mockResolvedValue([row({ monitoredNodes: '["mc:MA:abcdef012345","mc:MB:abcdef012345"]' })]);
      m.getInactiveMeshcoreNodes.mockImplementation(async (sourceId: string) => [
        { publicKey: 'abcdef0123456789', name: `Rpt-${sourceId}`, lastHeard: Date.now() - 3 * 86400_000 },
      ]);
      const s = await tick();
      s.lastNotifiedNodes = new Map();
      s.nextRunAt.clear();
      await s.tick();
      expect(m.heardOnAnySourceByKeyPrefix).toHaveBeenCalledWith('abcdef012345', ['MB'], expect.any(Number));
      expect(m.broadcastToPreferenceUsers).toHaveBeenCalledTimes(1);
    });
  });

  describe('low battery', () => {
    async function check() {
      const { lowBatteryNotificationService: svc } = await import('./lowBatteryNotificationService.js');
      const s = svc as unknown as { lastNotifiedNodes: Map<string, number>; checkLowBatteryNodes: () => Promise<void> };
      s.lastNotifiedNodes = new Map();
      await s.checkLowBatteryNodes();
      return s;
    }
    const lowNode = [{ nodeNum: 0xaaaaaaaa, nodeId: '!aaaaaaaa', longName: 'Ridge', shortName: 'RDG', batteryLevel: 9 }];

    it('low on two sources: one alert that lists both', async () => {
      m.getLowBatteryMonitoredNodes.mockResolvedValue(lowNode);
      await check();
      expect(m.broadcastToPreferenceUsers).toHaveBeenCalledTimes(1);
      const payload = m.broadcastToPreferenceUsers.mock.calls[0][1] as { body: string; sourceId: string };
      expect(payload.body.startsWith('[Name-A, Name-B] RDG')).toBe(true);
      expect(payload.sourceId).toBe('A');
    });

    it('a source the user cannot read is not listed', async () => {
      m.getLowBatteryMonitoredNodes.mockResolvedValue(lowNode);
      m.checkPermissionAsync.mockImplementation(async (_u: number, _r: string, _a: string, sourceId: string) => sourceId !== 'B');
      await check();
      const payload = m.broadcastToPreferenceUsers.mock.calls[0][1] as { body: string };
      expect(payload.body.startsWith('[Name-A] RDG')).toBe(true);
      expect(payload.body).not.toContain('Name-B');
    });

    it('the cooldown is per node, so a second check does not re-alert from the other source', async () => {
      m.getLowBatteryMonitoredNodes.mockResolvedValue(lowNode);
      const s = await check();
      await s.checkLowBatteryNodes();
      expect(m.broadcastToPreferenceUsers).toHaveBeenCalledTimes(1);
      expect([...s.lastNotifiedNodes.keys()]).toEqual(['1:mt:2863311530']);
    });
  });
});
