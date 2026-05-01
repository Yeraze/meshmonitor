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
vi.mock('fs', () => {
  const noop = () => {};
  return {
    default: {
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue(''),
      writeFileSync: noop,
      renameSync: noop,
      unlinkSync: noop,
      statfsSync: vi.fn().mockReturnValue({ bavail: 1_000_000, bsize: 4096 }),
      mkdirSync: noop,
      accessSync: noop,
      constants: { W_OK: 2 },
    },
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: noop,
    renameSync: noop,
    unlinkSync: noop,
    statfsSync: vi.fn().mockReturnValue({ bavail: 1_000_000, bsize: 4096 }),
    mkdirSync: noop,
    accessSync: noop,
    constants: { W_OK: 2 },
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
