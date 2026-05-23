/**
 * Tests for the upgradeService auto-upgrade circuit breaker.
 *
 * Issue #2871: when AUTO_UPGRADE_ENABLED=true on a deployment whose image is
 * pinned in docker-compose.yml, scheduled upgrades fail forever in a silent
 * loop. The circuit breaker trips after N consecutive failures so retries
 * stop until the operator acknowledges.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const settingsStore = vi.hoisted(() => new Map<string, string>());

const mockDb = vi.hoisted(() => ({
  miscRepo: {
    countConsecutiveFailedUpgrades: vi.fn().mockResolvedValue(0),
    markUpgradeFailed: vi.fn().mockResolvedValue(undefined),
    markUpgradeComplete: vi.fn().mockResolvedValue(undefined),
    createUpgradeHistory: vi.fn().mockResolvedValue(undefined),
    findStaleUpgrades: vi.fn().mockResolvedValue([]),
    countInProgressUpgrades: vi.fn().mockResolvedValue(0),
    getLastUpgrade: vi.fn().mockResolvedValue(null),
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
    mockDb.miscRepo.countConsecutiveFailedUpgrades.mockResolvedValue(0);
    mockDb.miscRepo.findStaleUpgrades.mockResolvedValue([]);
    mockDb.miscRepo.countInProgressUpgrades.mockResolvedValue(0);
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
    mockDb.miscRepo.getLastUpgrade.mockResolvedValue({
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
    mockDb.miscRepo.getLastUpgrade.mockResolvedValue({
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
    expect(mockDb.miscRepo.createUpgradeHistory).not.toHaveBeenCalled();
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
});
