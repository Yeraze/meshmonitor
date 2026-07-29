/**
 * InactiveNodeNotificationService — per-source scheduling cadence (#4412
 * Phase 2 WP4).
 *
 * Headline proof for the restructure: ONE scheduler tick (a single
 * `setInterval`), with each source's threshold/checkInterval/cooldown
 * resolved independently via `getInactiveNodeConfig()` on every pass, and a
 * per-source `nextRunAt` map so a source with a short check interval doesn't
 * force every other source onto the same cadence (and vice versa).
 * Timer-per-source was explicitly rejected (lifecycle coupling + cleanup
 * failure modes) — see inactiveNodeNotificationService.ts's class doc.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetUsersWithInactiveNodeNotifications = vi.fn();
const mockGetInactiveMonitoredNodesAsync = vi.fn();
const mockGetInactiveMeshcoreNodes = vi.fn();
const mockCheckPermissionAsync = vi.fn();
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

const SOURCE_A = 'srcA';
const SOURCE_B = 'srcB';

function makeRow(overrides: Partial<{
  userId: number;
  sourceId: string;
  monitoredNodes: string | null;
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

interface SourceCfg { threshold: number; checkInterval: number; cooldown: number }
const configs = new Map<string, SourceCfg>();

function setSourceConfig(sourceId: string, cfg: SourceCfg): void {
  configs.set(sourceId, cfg);
}

describe('InactiveNodeNotificationService — per-source scheduling cadence', () => {
  let service: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
    configs.clear();

    mockGetAllManagers.mockReturnValue([
      { sourceId: SOURCE_A, sourceType: 'meshtastic_tcp' },
      { sourceId: SOURCE_B, sourceType: 'meshtastic_tcp' },
    ]);
    mockGetSource.mockImplementation(async (sourceId: string) => ({ id: sourceId, name: sourceId }));
    mockCheckPermissionAsync.mockResolvedValue(true);
    mockGetUserPreferenceRows.mockResolvedValue([]);
    mockGetAllPreferenceUserIds.mockResolvedValue([]);
    mockGetInactiveMeshcoreNodes.mockResolvedValue([]);
    mockBroadcastToPreferenceUsers.mockResolvedValue({ sent: 1, failed: 0, filtered: 0 });

    mockGetSettingForSource.mockImplementation(async (sourceId: string | null | undefined, key: string) => {
      const cfg = sourceId ? configs.get(sourceId) : undefined;
      if (!cfg) return null;
      if (key === 'inactiveNodeThresholdHours') return String(cfg.threshold);
      if (key === 'inactiveNodeCheckIntervalMinutes') return String(cfg.checkInterval);
      if (key === 'inactiveNodeCooldownHours') return String(cfg.cooldown);
      return null;
    });

    // A: short threshold/interval/cooldown. B: long (near the historical
    // 24h/60min/24h default). Deliberately different so a due-ness or
    // config-resolution bug that ignores sourceId shows up immediately.
    setSourceConfig(SOURCE_A, { threshold: 1, checkInterval: 1, cooldown: 1 });
    setSourceConfig(SOURCE_B, { threshold: 720, checkInterval: 60, cooldown: 720 });

    mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
      makeRow({ monitoredNodes: '["!aaaaaaaa"]' }),
    ]);

    // srcA's monitored node always reads back as inactive; srcB's does not.
    // Keyed on the sourceId argument so this test isolates SCHEDULING
    // cadence from cutoff-window arithmetic (covered separately by
    // inactiveNodeNotificationService.test.ts).
    mockGetInactiveMonitoredNodesAsync.mockImplementation(async (_ids: string[], _cutoff: number, sourceId: string) => {
      if (sourceId === SOURCE_A) {
        return [{ nodeNum: 1, nodeId: '!aaaaaaaa', longName: 'A Node', shortName: 'ANOD', lastHeard: Math.floor(Date.now() / 1000) - 7200 }];
      }
      return [];
    });

    const module = await import('./inactiveNodeNotificationService.js');
    service = module.inactiveNodeNotificationService;
    service.stop();
    service.lastNotifiedNodes = new Map();
    service.hourlyLog.reset();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  it('installs exactly one recurring timer regardless of how many sources are registered', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    service.start();
    expect(setIntervalSpy).not.toHaveBeenCalled(); // warm-up hasn't fired yet

    await vi.advanceTimersByTimeAsync(60_000); // warm-up tick installs the recurring interval
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    // Advancing several more ticks must not create additional timers.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('two sources with different check intervals run on independent cadences', async () => {
    service.start();

    // t = 60s: warm-up tick. Both sources start with an empty nextRunAt, so
    // both are due on this very first pass — but only srcA's mocked query
    // reports an inactive node.
    await vi.advanceTimersByTimeAsync(60_000);
    let sourceIdsQueried = mockGetInactiveMonitoredNodesAsync.mock.calls.map((c) => c[2]);
    expect(sourceIdsQueried).toEqual(expect.arrayContaining([SOURCE_A, SOURCE_B]));
    expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledWith(
      'notifyOnInactiveNode',
      expect.objectContaining({ sourceId: SOURCE_A }),
      1
    );

    // t = 120s: srcA's 1-minute interval has elapsed again; srcB's 60-minute
    // interval has not.
    mockGetInactiveMonitoredNodesAsync.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    sourceIdsQueried = mockGetInactiveMonitoredNodesAsync.mock.calls.map((c) => c[2]);
    expect(sourceIdsQueried).toEqual([SOURCE_A]);

    // Advance well past srcB's 60-minute interval (measured from its own
    // first run at t=60s) — it must now run too.
    mockGetInactiveMonitoredNodesAsync.mockClear();
    await vi.advanceTimersByTimeAsync(65 * 60_000);
    sourceIdsQueried = mockGetInactiveMonitoredNodesAsync.mock.calls.map((c) => c[2]);
    expect(sourceIdsQueried).toEqual(expect.arrayContaining([SOURCE_B]));
  });

  it('honours each source\'s own cooldown independently', async () => {
    setSourceConfig(SOURCE_A, { threshold: 1, checkInterval: 1, cooldown: 1 });
    setSourceConfig(SOURCE_B, { threshold: 1, checkInterval: 1, cooldown: 720 });

    mockGetInactiveMonitoredNodesAsync.mockImplementation(async (_ids: string[], _cutoff: number, sourceId: string) => [{
      nodeNum: sourceId === SOURCE_A ? 1 : 2,
      nodeId: sourceId === SOURCE_A ? '!aaaaaaaa' : '!bbbbbbbb',
      longName: 'N',
      shortName: 'N',
      lastHeard: Math.floor(Date.now() / 1000) - 7200,
    }]);
    mockGetUsersWithInactiveNodeNotifications.mockResolvedValue([
      makeRow({ monitoredNodes: '["!aaaaaaaa","!bbbbbbbb"]' }),
    ]);

    service.start();
    await vi.advanceTimersByTimeAsync(60_000); // t=60s: both sources notify once
    expect(mockBroadcastToPreferenceUsers).toHaveBeenCalledTimes(2);

    mockBroadcastToPreferenceUsers.mockClear();
    await vi.advanceTimersByTimeAsync(60 * 60_000); // +1h: srcA's cooldown elapsed, srcB's (720h) has not
    const notifiedSourceIds = mockBroadcastToPreferenceUsers.mock.calls.map((c) => (c[1] as { sourceId: string }).sourceId);
    expect(notifiedSourceIds).toContain(SOURCE_A);
    expect(notifiedSourceIds).not.toContain(SOURCE_B);
  });

  it('prunes nextRunAt when a manager deregisters — bounded map growth', async () => {
    service.start();
    await vi.advanceTimersByTimeAsync(60_000); // both sources run once; nextRunAt now has 2 entries
    expect(service.nextRunAt.size).toBe(2);
    expect(service.nextRunAt.has(SOURCE_B)).toBe(true);

    // srcB deregisters (no longer returned by the registry).
    mockGetAllManagers.mockReturnValue([{ sourceId: SOURCE_A, sourceType: 'meshtastic_tcp' }]);

    await vi.advanceTimersByTimeAsync(60_000); // next tick prunes the stale entry
    expect(service.nextRunAt.has(SOURCE_B)).toBe(false);
    expect(service.nextRunAt.size).toBe(1);
  });
});
