/**
 * Unit tests for MeshtasticManager's adoption of DistanceDeleteScheduler (#3962 task 2.2d).
 *
 * Verifies:
 * - MeshtasticManager creates a DistanceDeleteScheduler lazily on the first
 *   startDistanceDeleteScheduler() call and delegates lifecycle methods.
 * - Regression: stop() within the 2-minute initial-run window cancels the pending
 *   setTimeout, so no runDeleteCycle fires when auto-delete is disabled quickly after
 *   connect (latent bug in the prior inline implementation where the handle was discarded).
 *
 * Implementation note: MeshtasticManager uses a dynamic import() for DistanceDeleteScheduler
 * to avoid a static circular dependency:
 *   meshtasticManager → distanceDeleteScheduler → autoDeleteByDistanceService
 *   → resolveSourceManager → meshtasticManager
 * The lazy-init pattern is transparent to callers and preserves all runtime behavior.
 *
 * Uses the same minimal-mock pattern as meshtasticManager.reconnectAddress.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Stubs (minimal — mirrors meshtasticManager.reconnectAddress.test.ts) -------

vi.mock('./tcpTransport.js', () => ({
  TcpTransport: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    off = vi.fn();
    removeAllListeners = vi.fn();
    isConnected = () => false;
    setStaleConnectionTimeout = vi.fn();
    setConnectTimeout = vi.fn();
    setReconnectTiming = vi.fn();
  },
}));

const getSettingForSource = vi.fn();
vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
      getSettingForSource: (...args: unknown[]) => getSettingForSource(...args),
    },
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      getAllNodes: vi.fn().mockResolvedValue([]),
      getActiveNodes: vi.fn().mockResolvedValue([]),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

// --- Imports (after vi.mock hoisting) ------------------------------------------

import { MeshtasticManager } from './meshtasticManager.js';
import { DistanceDeleteScheduler } from './services/distanceDeleteScheduler.js';
import { autoDeleteByDistanceService } from './services/autoDeleteByDistanceService.js';

// -------------------------------------------------------------------------------

describe('MeshtasticManager — DistanceDeleteScheduler adoption (#3962 task 2.2d)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSettingForSource.mockReset();
    // Default: disabled so scheduler creation doesn't trigger DB reads unnecessarily.
    getSettingForSource.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('distanceDeleteScheduler field is null before any start() call (lazy init)', () => {
    const mgr = new MeshtasticManager('test-source-1');
    // Lazy — null until startDistanceDeleteScheduler() creates it.
    expect((mgr as any).distanceDeleteScheduler).toBeNull();
  });

  it('startDistanceDeleteScheduler() creates a DistanceDeleteScheduler and delegates to start()', async () => {
    getSettingForSource.mockImplementation((_: string, key: string) =>
      Promise.resolve(key === 'autoDeleteByDistanceEnabled' ? 'false' : null));

    // Spy on the prototype so we catch the instance's start() call regardless
    // of when the instance is created.
    const startSpy = vi.spyOn(DistanceDeleteScheduler.prototype, 'start').mockResolvedValue(undefined);

    const mgr = new MeshtasticManager('test-source-2');
    await mgr.startDistanceDeleteScheduler();

    expect((mgr as any).distanceDeleteScheduler).toBeInstanceOf(DistanceDeleteScheduler);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('stopDistanceDeleteScheduler() is a no-op when never started', () => {
    const mgr = new MeshtasticManager('test-source-3a');
    // Must not throw even when the scheduler was never created.
    expect(() => mgr.stopDistanceDeleteScheduler()).not.toThrow();
  });

  it('stopDistanceDeleteScheduler() delegates to the scheduler stop() after a start', async () => {
    getSettingForSource.mockImplementation((_: string, key: string) =>
      Promise.resolve(key === 'autoDeleteByDistanceEnabled' ? 'false' : null));

    vi.spyOn(DistanceDeleteScheduler.prototype, 'start').mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(DistanceDeleteScheduler.prototype, 'stop').mockImplementation(() => {});

    const mgr = new MeshtasticManager('test-source-3b');
    await mgr.startDistanceDeleteScheduler(); // creates scheduler
    mgr.stopDistanceDeleteScheduler();

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('regression: stop() within the 2-minute initial window cancels the pending run (latent inline bug fix)', async () => {
    // Spy on the underlying service to detect any stray delete-cycle fires.
    const runSpy = vi.spyOn(autoDeleteByDistanceService, 'runDeleteCycle')
      .mockResolvedValue({ deletedCount: 0 });

    // Configure: auto-delete enabled with a 1-hour interval.
    getSettingForSource.mockImplementation((_sourceId: string, key: string) =>
      Promise.resolve(key === 'autoDeleteByDistanceEnabled' ? 'true' : '1'));

    const mgr = new MeshtasticManager('test-source-reg');

    // ARM — creates and starts the DistanceDeleteScheduler (simulates the connect path).
    await mgr.startDistanceDeleteScheduler();

    // Advance 30 s — still inside the 2-minute initial window; no run yet.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runSpy).not.toHaveBeenCalled();

    // DISARM before the initial run fires — shared class cancels initialTimeout.
    mgr.stopDistanceDeleteScheduler();

    // Advance well past 2 minutes AND one interval tick.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); // 2h

    // No stray fire: the shared DistanceDeleteScheduler.stop() cancels initialTimeout.
    // The prior inline implementation discarded the setTimeout handle (latent bug).
    expect(runSpy).not.toHaveBeenCalled();
  });
});
