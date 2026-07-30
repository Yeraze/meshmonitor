/**
 * Regression test for #4434: MeshCore Auto-Pathfinding's time interval was
 * not being respected — reports of packets accelerating over time until the
 * source was disabled and re-enabled.
 *
 * Root cause: `startAutoPathfinding()` does `stopAutoPathfinding()` then
 * several sequential `await`s on settings reads before finally installing a
 * jitter `setTimeout` → recurring `setInterval`. There was no guard against
 * two overlapping calls (e.g. a reconnect racing a settings save, or two
 * reconnects racing each other via `attemptReconnect()`/the fire-and-forget
 * call in `connect()`). Each overlapping call's `stopAutoPathfinding()` ran
 * too early to clear a sibling call's not-yet-installed timer, so both calls
 * independently installed their own timer and only the most recently
 * assigned handle remained reachable — the other became an orphan that no
 * future `stopAutoPathfinding()` could ever clear. Every additional race
 * stacked one more orphaned interval, compounding the effective packet rate
 * over a session, matching the reported "accelerates over time" symptom and
 * "disable/re-enable resets it" behavior (a fresh manager has no orphans
 * yet).
 *
 * The fix adds an `autoPathfindingGeneration` counter, bumped by every
 * `stopAutoPathfinding()` call, that a `startAutoPathfinding()` call checks
 * before installing its timer — a superseded call aborts instead of
 * installing an unreachable timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCoreManager } from './meshcoreManager.js';
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

describe('MeshCoreManager.startAutoPathfinding() overlap guard (#4434)', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    // Deterministic jitter: initialJitterMs = Math.random() * maxJitterMs.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('a second overlapping start supersedes the first — only one timer survives', async () => {
    const m = new MeshCoreManager('test-source');
    mockPathfindingSettings();

    const call1 = m.startAutoPathfinding();
    const call2 = m.startAutoPathfinding();
    await Promise.all([call1, call2]);

    // Before the fix both calls independently installed a jitter timeout —
    // the first became an orphan no future stopAutoPathfinding() could
    // clear. Only the most recent call should end up owning one.
    expect(vi.getTimerCount()).toBe(1);
    expect((m as any).autoPathfindingJitterTimeout).not.toBeNull();
  });

  it('three overlapping (re)starts still leave exactly one live interval firing', async () => {
    const m = new MeshCoreManager('test-source');
    mockPathfindingSettings();
    (m as any).connected = true;
    (m as any).getContacts = vi.fn().mockReturnValue([]);

    // Simulates a burst of overlapping calls (reconnect flap racing a
    // settings save, e.g.) — each used to leave the previous timer running
    // and orphaned, compounding the effective packet rate over time.
    await Promise.all([
      m.startAutoPathfinding(),
      m.startAutoPathfinding(),
      m.startAutoPathfinding(),
    ]);

    // Jitter delay is 0ms (Math.random mocked) — let it fire and install the
    // recurring interval.
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(1);
  });

  it('stopAutoPathfinding() invalidates an in-flight start (e.g. a disconnect racing connect())', async () => {
    const m = new MeshCoreManager('test-source');
    mockPathfindingSettings();

    const inFlightStart = m.startAutoPathfinding();
    // Simulate disconnect() running while the settings reads above are still
    // in flight (connect()'s call to startAutoPathfinding() is
    // fire-and-forget).
    m.stopAutoPathfinding();
    await inFlightStart;

    expect(vi.getTimerCount()).toBe(0);
    expect((m as any).autoPathfindingJitterTimeout).toBeNull();
    expect((m as any).autoPathfindingTimer).toBeNull();
  });
});
