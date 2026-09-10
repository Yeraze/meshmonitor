/**
 * Regression test for #5170: MeshCore Auto-Pathfinding in-flight runs were
 * never cancelled, so every reconnect stacked another concurrent run.
 *
 * Root cause: `startAutoPathfinding()` calls `stopAutoPathfinding()`, which
 * bumps `autoPathfindingGeneration` and clears the jitter/interval timer
 * handles, but an `executeRun()` already iterating its target list has no
 * way to observe that. Its loop only checked `!this.connected` and spent
 * almost all its time inside the per-target `await setTimeout(intervalMs)`
 * sleep. If a reconnect completed within one sleep — which with
 * auto-reconnect it nearly always does — the stale run woke back up, saw
 * `connected === true` again, and kept firing requests alongside the new
 * run the reconnect had just started. #4435 (fix for #4434) stopped
 * overlapping *timer installation*; this fixes overlapping *runs*.
 *
 * The fix has `executeRun()` capture `myGeneration` (already in its closure
 * from `startAutoPathfinding()`) and bail out — once before starting, and
 * once per loop iteration (which covers immediately after the inter-target
 * sleep, since that's where control returns to next) — whenever
 * `myGeneration !== this.autoPathfindingGeneration`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import { logger } from '../utils/logger.js';
import databaseService from '../services/database.js';

function mockPathfindingSettings() {
  return vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(
    async (_sourceId: string | null | undefined, key: string) => {
      switch (key) {
        case 'meshcoreAutoPathfindingEnabled':
          return 'true';
        case 'meshcoreAutoPathfindingPathDiscoveryEnabled':
          return 'true';
        case 'meshcoreAutoPathfindingNeighborsEnabled':
          return 'false';
        case 'meshcoreAutoPathfindingIntervalMinutes':
          return '3';
        case 'meshcoreAutoPathfindingRepeatHours':
          return '1';
        default:
          return null;
      }
    }
  );
}

function makeCompanionContacts(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    publicKey: `pubkey-${i}`,
    advName: `Companion ${i}`,
    name: `Companion ${i}`,
    advType: MeshCoreDeviceType.COMPANION,
  }));
}

describe('MeshCoreManager Auto-Pathfinding run cancellation (#5170)', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    // Deterministic jitter: initialJitterMs = Math.random() * maxJitterMs.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(databaseService, 'getMeshcorePathfindingFilterSettingsAsync').mockResolvedValue({
      enabled: false, targetKeys: [], contactsEnabled: false, regexEnabled: false, nameRegex: '.*',
      lastHeardEnabled: false, lastHeardHours: 168, hopsEnabled: false, hopsMin: 0, hopsMax: 10,
      signalEnabled: false, rssiMin: -200, snrMin: -100,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('stopAutoPathfinding() mid-loop (e.g. disabling the feature) stops the run at its next target, not just its timers', async () => {
    const m = new MeshCoreManager('test-source');
    mockPathfindingSettings();
    (m as any).connected = true;
    (m as any).canTransmit = vi.fn().mockReturnValue(true);
    (m as any).getContacts = vi.fn().mockReturnValue(makeCompanionContacts(5));
    const discoverContactPath = vi.fn().mockResolvedValue(true);
    (m as any).discoverContactPath = discoverContactPath;

    await m.startAutoPathfinding();
    // Fire the jitter timeout (0ms) to start the first run and install the
    // recurring interval.
    await vi.advanceTimersByTimeAsync(0);

    // The run has just sent target 0 and is now asleep for intervalMs
    // (3 minutes) before target 1.
    expect(discoverContactPath).toHaveBeenCalledTimes(1);

    // Disabling Auto-Pathfinding in the UI (or a source teardown) calls
    // stopAutoPathfinding() — it clears the jitter/interval timer handles,
    // but before the fix had no way to reach the sleep this run is
    // currently parked in.
    m.stopAutoPathfinding();

    // Wake that sleep. Before the fix the loop only checked
    // `this.connected`, still true, and would send target 1. After the
    // fix it must observe the bumped generation and stop.
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

    expect(discoverContactPath).toHaveBeenCalledTimes(1);
  });

  it('a reconnect racing the inter-target sleep leaves only the new run sending — the stale run never reaches its next target', async () => {
    const m = new MeshCoreManager('test-source');
    mockPathfindingSettings();
    (m as any).connected = true;
    (m as any).canTransmit = vi.fn().mockReturnValue(true);
    // A reconnect can refresh the contact list, so give the two runs
    // disjoint target sets — this lets the assertions tell which run a
    // given call came from regardless of timer firing order.
    const getContacts = vi.fn()
      .mockReturnValueOnce(makeCompanionContacts(5))
      .mockReturnValue(makeCompanionContacts(5).map(c => ({ ...c, publicKey: `new-${c.publicKey}` })));
    (m as any).getContacts = getContacts;
    const discoverContactPath = vi.fn().mockResolvedValue(true);
    (m as any).discoverContactPath = discoverContactPath;

    await m.startAutoPathfinding();
    await vi.advanceTimersByTimeAsync(0);
    expect(discoverContactPath).toHaveBeenCalledWith('pubkey-0');
    expect(discoverContactPath).toHaveBeenCalledTimes(1);

    // Reconnect completes while the first run is still asleep between
    // targets — connect() calls startAutoPathfinding() again, unawaited,
    // exactly as it does in production.
    void m.startAutoPathfinding();
    await vi.advanceTimersByTimeAsync(0);
    // The new run has sent its own target 0 by now.
    expect(discoverContactPath).toHaveBeenCalledWith('new-pubkey-0');

    // Wake both runs' inter-target sleeps. Before the fix the stale run
    // would still see this.connected === true and send its target 1
    // ('pubkey-1') on top of whatever the new run does, stacking runs on
    // every reconnect. After the fix it observes the generation bump and
    // stops instead.
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(discoverContactPath).not.toHaveBeenCalledWith('pubkey-1');
  });

  it('a superseded run does not start a fresh pass over targets at all', async () => {
    const m = new MeshCoreManager('test-source');
    mockPathfindingSettings();
    (m as any).connected = true;
    (m as any).canTransmit = vi.fn().mockReturnValue(true);
    (m as any).getContacts = vi.fn().mockReturnValue(makeCompanionContacts(3));
    const discoverContactPath = vi.fn().mockResolvedValue(true);
    (m as any).discoverContactPath = discoverContactPath;

    await m.startAutoPathfinding();
    // Bump the generation before the jitter timeout fires (e.g. a
    // disconnect racing the still-pending jitter delay).
    m.stopAutoPathfinding();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(discoverContactPath).not.toHaveBeenCalled();
  });
});
