/**
 * Tests for the upgradeService auto-upgrade circuit breaker and boot-time
 * upgrade status reconciliation.
 *
 * Issue #2871: when AUTO_UPGRADE_ENABLED=true on a deployment whose image is
 * pinned in docker-compose.yml, scheduled upgrades fail forever in a silent
 * loop. The circuit breaker trips after N consecutive failures so retries
 * stop until the operator acknowledges.
 *
 * Issue #3228: on a successful Docker+watchdog auto-upgrade the
 * upgrade_history row stays pending after container recreate. After 30 min
 * the stale-timeout reconciler marks it failed, eventually tripping the
 * circuit breaker even though the upgrade succeeded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const settingsStore = vi.hoisted(() => new Map<string, string>());

const mockDb = vi.hoisted(() => ({
  upgradeHistoryRepo: {
    countConsecutiveFailedUpgrades: vi.fn().mockResolvedValue(0),
    markUpgradeFailed: vi.fn().mockResolvedValue(undefined),
    markUpgradeComplete: vi.fn().mockResolvedValue(undefined),
    createUpgradeHistory: vi.fn().mockResolvedValue(undefined),
    findStaleUpgrades: vi.fn().mockResolvedValue([]),
    countInProgressUpgrades: vi.fn().mockResolvedValue(0),
    getLastUpgrade: vi.fn().mockResolvedValue(null),
    findMostRecentPendingUpgrade: vi.fn().mockResolvedValue(null),
  },
  settings: {
    getSetting: vi.fn(async (key: string) => settingsStore.get(key) ?? null),
    setSetting: vi.fn(async (key: string, value: string) => {
      settingsStore.set(key, value);
    }),
  },
  auditLogAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/database.js', () => ({
  default: mockDb,
}));

// fs is touched on import; provide enough to avoid touching the real disk.
const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(''),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  statfsSync: vi.fn().mockReturnValue({ bavail: 1_000_000, bsize: 4096 }),
  mkdirSync: vi.fn(),
  accessSync: vi.fn(),
}));

vi.mock('fs', () => {
  const api = {
    ...fsMocks,
    constants: { W_OK: 2 },
  };
  return {
    default: api,
    ...api,
  };
});

const { upgradeService, AUTO_UPGRADE_FAILURE_THRESHOLD } = await import('./upgradeService.js');

describe('upgradeService circuit breaker', () => {
  beforeEach(() => {
    settingsStore.clear();
    vi.clearAllMocks();
    mockDb.upgradeHistoryRepo.countConsecutiveFailedUpgrades.mockResolvedValue(0);
    mockDb.upgradeHistoryRepo.findStaleUpgrades.mockResolvedValue([]);
    mockDb.upgradeHistoryRepo.countInProgressUpgrades.mockResolvedValue(0);
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readFileSync.mockReturnValue('');
  });

  it('exposes the configured threshold (default 3)', () => {
    expect(AUTO_UPGRADE_FAILURE_THRESHOLD).toBeGreaterThanOrEqual(1);
  });

  it('getAutoUpgradeBlock returns not-blocked by default', async () => {
    const state = await upgradeService.getAutoUpgradeBlock();
    expect(state.blocked).toBe(false);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.threshold).toBe(AUTO_UPGRADE_FAILURE_THRESHOLD);
  });

  it('getAutoUpgradeBlock reflects persisted blocked state', async () => {
    settingsStore.set('autoUpgradeBlocked', 'true');
    settingsStore.set('autoUpgradeBlockedReason', 'pinned image');

    const state = await upgradeService.getAutoUpgradeBlock();
    expect(state.blocked).toBe(true);
    expect(state.reason).toBe('pinned image');
  });

  it('auto-heals stale block flag when most recent upgrade is complete', async () => {
    // Regression: production users reported the "auto-upgrade halted" red
    // banner persisting after a successful auto-upgrade. The persisted
    // `autoUpgradeBlocked` setting is supposed to be cleared by
    // markCompleteAndClear() during the watchdog status sync, but that path
    // can be skipped (e.g. no frontend session was open to poll
    // /api/upgrade/status after the container restarted). Treat the persisted
    // flag as a cache: if the most recent upgrade row is 'complete', the
    // failure streak is over and the flag must clear on next status read.
    settingsStore.set('autoUpgradeBlocked', 'true');
    settingsStore.set('autoUpgradeBlockedReason', 'old failures');
    mockDb.upgradeHistoryRepo.getLastUpgrade.mockResolvedValue({
      id: 'abc',
      status: 'complete',
    });

    const state = await upgradeService.getAutoUpgradeBlock();

    expect(state.blocked).toBe(false);
    expect(state.reason).toBeNull();
    // The flag must be cleared in the store (durable), not just masked in
    // this response — otherwise the next read would re-trigger the heal.
    expect(settingsStore.get('autoUpgradeBlocked')).toBe('false');
    expect(settingsStore.get('autoUpgradeBlockedReason')).toBe('');
  });

  it('does NOT auto-heal when most recent upgrade is failed', async () => {
    settingsStore.set('autoUpgradeBlocked', 'true');
    settingsStore.set('autoUpgradeBlockedReason', 'pinned image');
    mockDb.upgradeHistoryRepo.getLastUpgrade.mockResolvedValue({
      id: 'def',
      status: 'failed',
    });

    const state = await upgradeService.getAutoUpgradeBlock();

    expect(state.blocked).toBe(true);
    expect(state.reason).toBe('pinned image');
    expect(settingsStore.get('autoUpgradeBlocked')).toBe('true');
  });

  it('does NOT auto-heal when upgrade history is empty', async () => {
    // Defensive: a manually-set flag with no upgrade history at all must
    // not be cleared. (getLastUpgrade returns null by default.)
    settingsStore.set('autoUpgradeBlocked', 'true');

    const state = await upgradeService.getAutoUpgradeBlock();

    expect(state.blocked).toBe(true);
    expect(settingsStore.get('autoUpgradeBlocked')).toBe('true');
  });

  it('clearAutoUpgradeBlock unsets persisted block', async () => {
    settingsStore.set('autoUpgradeBlocked', 'true');
    settingsStore.set('autoUpgradeBlockedReason', 'something');

    await upgradeService.clearAutoUpgradeBlock();

    const state = await upgradeService.getAutoUpgradeBlock();
    expect(state.blocked).toBe(false);
  });

  it('triggerUpgrade refuses scheduled attempts when blocked', async () => {
    settingsStore.set('autoUpgradeBlocked', 'true');
    settingsStore.set('autoUpgradeBlockedReason', 'pinned image tag');

    // Need AUTO_UPGRADE_ENABLED + docker for triggerUpgrade to reach the breaker.
    // The constructor read env at import time; bypass by faking deployment via property:
    Object.assign(upgradeService, { UPGRADE_ENABLED: true, DEPLOYMENT_METHOD: 'docker' });

    const result = await upgradeService.triggerUpgrade(
      { targetVersion: 'latest' },
      '1.0.0',
      'system-scheduled-auto-upgrade'
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/blocked/i);
    expect(mockDb.upgradeHistoryRepo.createUpgradeHistory).not.toHaveBeenCalled();
  });

  it('triggerUpgrade clears stale .upgrade-status before writing trigger', async () => {
    // Regression: a previous failed run left "failed" in the watchdog status
    // file. Without clearing it, getUpgradeStatus() / getActiveUpgrade() sync
    // the new in-progress row to "failed" before the watchdog touches it,
    // producing a spurious "Upgrade failed" toast and leaving the circuit
    // breaker tripped after the watchdog quietly succeeds in the background.
    Object.assign(upgradeService, { UPGRADE_ENABLED: true, DEPLOYMENT_METHOD: 'docker' });

    const STATUS_FILE = '/data/.upgrade-status';
    fsMocks.existsSync.mockImplementation((p: string) => p === STATUS_FILE);
    fsMocks.readFileSync.mockReturnValue('failed');

    const result = await upgradeService.triggerUpgrade(
      { targetVersion: 'latest', force: true },
      '1.0.0',
      '42'
    );

    expect(result.success).toBe(true);
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(STATUS_FILE);

    // The clear must happen before the trigger file is written, otherwise the
    // watchdog can race ahead of us.
    const unlinkOrder = fsMocks.unlinkSync.mock.invocationCallOrder[0];
    const renameOrder = fsMocks.renameSync.mock.invocationCallOrder[0];
    expect(unlinkOrder).toBeDefined();
    expect(renameOrder).toBeDefined();
    expect(unlinkOrder).toBeLessThan(renameOrder);
  });

  it('triggerUpgrade tolerates missing .upgrade-status (no-op clear)', async () => {
    // No prior run; status file does not exist. Clear must be a silent no-op.
    Object.assign(upgradeService, { UPGRADE_ENABLED: true, DEPLOYMENT_METHOD: 'docker' });

    fsMocks.existsSync.mockReturnValue(false);

    const result = await upgradeService.triggerUpgrade(
      { targetVersion: 'latest', force: true },
      '1.0.0',
      '42'
    );

    expect(result.success).toBe(true);
    expect(fsMocks.unlinkSync).not.toHaveBeenCalled();
  });

  it('triggerUpgrade allows manual user attempt even when blocked', async () => {
    settingsStore.set('autoUpgradeBlocked', 'true');

    Object.assign(upgradeService, { UPGRADE_ENABLED: true, DEPLOYMENT_METHOD: 'docker' });

    const result = await upgradeService.triggerUpgrade(
      { targetVersion: 'latest', force: true },
      '1.0.0',
      '42' // numeric user id, not 'system-*'
    );

    // Either the manual attempt succeeded or it failed for an unrelated reason
    // (e.g. mocked filesystem), but it must NOT be the breaker rejection.
    expect(result.message ?? '').not.toMatch(/blocked after .* consecutive/i);
  });

  // ── Issue #3228: isUpgradeInProgress stale-check respects watchdog status ──

  it('isUpgradeInProgress marks stale row complete (not failed) when status file says complete', async () => {
    // Regression: the stale-timeout path in isUpgradeInProgress() called
    // markFailedAndEvaluate() unconditionally, even when the watchdog had
    // already written 'complete' to the status file. This falsely incremented
    // the consecutive-failure counter and could trip the circuit breaker.
    const staleRow = {
      id: 'stale-1',
      status: 'pending',
      currentStep: 'Preparing upgrade',
      startedAt: Date.now() - 35 * 60 * 1000, // 35 min ago
      fromVersion: '4.6.0',
      toVersion: '4.6.1',
    };
    mockDb.upgradeHistoryRepo.findStaleUpgrades.mockResolvedValue([staleRow]);
    mockDb.upgradeHistoryRepo.countInProgressUpgrades.mockResolvedValue(0);

    const STATUS_FILE = '/data/.upgrade-status';
    fsMocks.existsSync.mockImplementation((p: string) =>
      p === STATUS_FILE
    );
    fsMocks.readFileSync.mockImplementation((p: string) =>
      p === STATUS_FILE ? 'complete' : ''
    );

    await upgradeService.isUpgradeInProgress();

    // Must have marked complete, not failed
    expect(mockDb.upgradeHistoryRepo.markUpgradeComplete).toHaveBeenCalledWith('stale-1');
    expect(mockDb.upgradeHistoryRepo.markUpgradeFailed).not.toHaveBeenCalled();
    // Circuit breaker must NOT have been tripped
    expect(settingsStore.get('autoUpgradeBlocked')).not.toBe('true');
  });

  it('isUpgradeInProgress still marks stale row failed when status file is absent', async () => {
    const staleRow = {
      id: 'stale-2',
      status: 'pending',
      currentStep: 'Preparing upgrade',
      startedAt: Date.now() - 35 * 60 * 1000,
      fromVersion: '4.6.0',
      toVersion: '4.6.1',
    };
    mockDb.upgradeHistoryRepo.findStaleUpgrades.mockResolvedValue([staleRow]);
    mockDb.upgradeHistoryRepo.countInProgressUpgrades.mockResolvedValue(0);
    fsMocks.existsSync.mockReturnValue(false);

    await upgradeService.isUpgradeInProgress();

    expect(mockDb.upgradeHistoryRepo.markUpgradeFailed).toHaveBeenCalledWith(
      'stale-2',
      expect.stringContaining('timed out')
    );
    expect(mockDb.upgradeHistoryRepo.markUpgradeComplete).not.toHaveBeenCalled();
  });

  // ── Issue #3228: syncPendingUpgradeStatusOnBoot ────────────────────────────

  it('syncPendingUpgradeStatusOnBoot marks pending row complete when status file says complete', async () => {
    const pendingRow = {
      id: 'boot-1',
      status: 'pending',
      fromVersion: '4.6.3',
      toVersion: '4.6.4',
    };
    mockDb.upgradeHistoryRepo.findMostRecentPendingUpgrade.mockResolvedValue(pendingRow);

    const STATUS_FILE = '/data/.upgrade-status';
    fsMocks.existsSync.mockImplementation((p: string) => p === STATUS_FILE);
    fsMocks.readFileSync.mockImplementation((p: string) =>
      p === STATUS_FILE ? 'complete' : ''
    );

    await upgradeService.syncPendingUpgradeStatusOnBoot();

    expect(mockDb.upgradeHistoryRepo.markUpgradeComplete).toHaveBeenCalledWith('boot-1');
    expect(mockDb.upgradeHistoryRepo.markUpgradeFailed).not.toHaveBeenCalled();
    // Status file must be deleted after sync
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(STATUS_FILE);
    // Circuit breaker must be cleared (markCompleteAndClear)
    expect(settingsStore.get('autoUpgradeBlocked')).toBe('false');
  });

  it('syncPendingUpgradeStatusOnBoot marks pending row complete when status file says ready', async () => {
    const pendingRow = { id: 'boot-2', status: 'pending', fromVersion: '4.6.3', toVersion: '4.6.4' };
    mockDb.upgradeHistoryRepo.findMostRecentPendingUpgrade.mockResolvedValue(pendingRow);

    const STATUS_FILE = '/data/.upgrade-status';
    fsMocks.existsSync.mockImplementation((p: string) => p === STATUS_FILE);
    fsMocks.readFileSync.mockImplementation((p: string) =>
      p === STATUS_FILE ? 'ready' : ''
    );

    await upgradeService.syncPendingUpgradeStatusOnBoot();

    expect(mockDb.upgradeHistoryRepo.markUpgradeComplete).toHaveBeenCalledWith('boot-2');
    expect(mockDb.upgradeHistoryRepo.markUpgradeFailed).not.toHaveBeenCalled();
  });

  it('syncPendingUpgradeStatusOnBoot marks pending row failed when status file says failed', async () => {
    const pendingRow = { id: 'boot-3', status: 'pending', fromVersion: '4.6.3', toVersion: '4.6.4' };
    mockDb.upgradeHistoryRepo.findMostRecentPendingUpgrade.mockResolvedValue(pendingRow);

    const STATUS_FILE = '/data/.upgrade-status';
    fsMocks.existsSync.mockImplementation((p: string) => p === STATUS_FILE);
    fsMocks.readFileSync.mockImplementation((p: string) =>
      p === STATUS_FILE ? 'failed' : ''
    );

    await upgradeService.syncPendingUpgradeStatusOnBoot();

    expect(mockDb.upgradeHistoryRepo.markUpgradeFailed).toHaveBeenCalledWith(
      'boot-3',
      expect.stringContaining('watchdog status on boot')
    );
    expect(mockDb.upgradeHistoryRepo.markUpgradeComplete).not.toHaveBeenCalled();
  });

  it('syncPendingUpgradeStatusOnBoot is a no-op when status file does not exist', async () => {
    fsMocks.existsSync.mockReturnValue(false);

    await upgradeService.syncPendingUpgradeStatusOnBoot();

    expect(mockDb.upgradeHistoryRepo.findMostRecentPendingUpgrade).not.toHaveBeenCalled();
    expect(mockDb.upgradeHistoryRepo.markUpgradeComplete).not.toHaveBeenCalled();
    expect(mockDb.upgradeHistoryRepo.markUpgradeFailed).not.toHaveBeenCalled();
  });

  it('syncPendingUpgradeStatusOnBoot is a no-op when status file contains non-terminal value', async () => {
    const STATUS_FILE = '/data/.upgrade-status';
    fsMocks.existsSync.mockImplementation((p: string) => p === STATUS_FILE);
    fsMocks.readFileSync.mockImplementation((p: string) =>
      p === STATUS_FILE ? 'downloading' : ''
    );

    await upgradeService.syncPendingUpgradeStatusOnBoot();

    expect(mockDb.upgradeHistoryRepo.findMostRecentPendingUpgrade).not.toHaveBeenCalled();
    expect(mockDb.upgradeHistoryRepo.markUpgradeComplete).not.toHaveBeenCalled();
  });

  it('syncPendingUpgradeStatusOnBoot deletes orphaned status file when no pending row exists', async () => {
    mockDb.upgradeHistoryRepo.findMostRecentPendingUpgrade.mockResolvedValue(null);

    const STATUS_FILE = '/data/.upgrade-status';
    fsMocks.existsSync.mockImplementation((p: string) => p === STATUS_FILE);
    fsMocks.readFileSync.mockImplementation((p: string) =>
      p === STATUS_FILE ? 'complete' : ''
    );

    await upgradeService.syncPendingUpgradeStatusOnBoot();

    // No DB mutation — just file cleanup
    expect(mockDb.upgradeHistoryRepo.markUpgradeComplete).not.toHaveBeenCalled();
    expect(mockDb.upgradeHistoryRepo.markUpgradeFailed).not.toHaveBeenCalled();
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(STATUS_FILE);
  });
});
