/**
 * The hourly auto-favorite staleness sweep is armed each time config capture
 * completes, which happens again on every reconnect. It used to be a bare
 * setInterval, so every reconnect stacked another hourly sweep. It is now held
 * on the manager, replaced on re-arm, and cleared on disconnect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: vi.fn().mockResolvedValue(undefined),
    nodes: { getNode: vi.fn().mockResolvedValue(null), upsertNode: vi.fn(), getAllNodes: vi.fn().mockResolvedValue([]) },
    telemetry: { insertTelemetry: vi.fn().mockResolvedValue(undefined) },
    messages: { getDirectMessages: vi.fn().mockResolvedValue([]), getMessage: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Loaded once while the file is collected, not inside a hook. A dynamic import in
// `beforeEach` charged the manager's module load (~2 s idle, 10 s+ on a busy
// host) to the first test's hook budget; collection has no such budget.
const managerModule = await import('./meshtasticManager.js');

describe('MeshtasticManager auto-favorite sweep timer', () => {
  let manager: any;
  const HOUR = 60 * 60 * 1000;

  beforeEach(async () => {
    vi.useFakeTimers();
    manager = managerModule.fallbackManager;
    vi.spyOn(manager, 'autoFavoriteSweep').mockResolvedValue(undefined);
  });

  afterEach(() => {
    manager.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('re-arming (a reconnect) keeps exactly one hourly sweep', () => {
    manager.armAutoFavoriteSweep();
    manager.armAutoFavoriteSweep();
    manager.armAutoFavoriteSweep();
    vi.advanceTimersByTime(HOUR);
    expect(manager.autoFavoriteSweep).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOUR);
    expect(manager.autoFavoriteSweep).toHaveBeenCalledTimes(2);
  });

  it('disconnect stops the sweep', () => {
    manager.armAutoFavoriteSweep();
    manager.disconnect();
    vi.advanceTimersByTime(3 * HOUR);
    expect(manager.autoFavoriteSweep).not.toHaveBeenCalled();
  });
});
