/**
 * PUT /:id — Analyzer Observer hot-swap (#4457 Phase 2, WP6, spec §5).
 *
 * An edit that touches ONLY the `observer` sub-block hot-swaps the publisher
 * in place via `sourceManagerRegistry.reconfigureObserver()` — the companion
 * device connection stays up. Any other config change (or a change that also
 * touches `observer`) takes the existing full restart
 * (`removeManager` → `ensureMeshCoreManagerStarted`), which remains the
 * always-correct baseline behavior; the hot-swap branch is strictly an
 * optimization layered on top of it.
 *
 * Uses the real createRouteTestApp harness (real session + auth middleware +
 * real permission SQL) per CLAUDE.md's Route Test Harness guidance.
 * `sourceManagerRegistry`'s singleton export is mocked so the route branch can
 * be observed directly; the real `SourceManagerRegistry` class is left
 * un-mocked (via `vi.importActual`) so the fourth acceptance case can unit-test
 * the actual duck-typed guard in `reconfigureObserver()` end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { SourceManagerRegistry } from '../sourceManagerRegistry.js';
import type { ISourceManager } from '../sourceManagerRegistry.js';

const mockSourceRegistry = vi.hoisted(() => ({
  getManager: vi.fn(),
  reconfigureObserver: vi.fn(),
  removeManager: vi.fn(),
  addManager: vi.fn(),
}));

vi.mock('../sourceManagerRegistry.js', async () => {
  const actual = await vi.importActual<typeof import('../sourceManagerRegistry.js')>('../sourceManagerRegistry.js');
  return {
    ...actual,
    // Only the singleton is replaced — sourceRoutes.ts and meshcoreConfig.ts
    // both import this named export. The `SourceManagerRegistry` class itself
    // stays the real implementation so the last test below can exercise it
    // directly.
    sourceManagerRegistry: mockSourceRegistry,
  };
});

const SOURCE_ID = 'obs-reconfig-source';

const BASE_CONFIG = {
  transport: 'usb' as const,
  port: '/dev/ttyACM0',
  deviceType: 'companion' as const,
};

const OBSERVER_A = {
  enabled: true,
  brokerUrl: 'ws://localhost:8883',
  iataCode: 'test',
  tokenAudience: 'mqtt.local.test',
};

const OBSERVER_B = {
  enabled: true,
  brokerUrl: 'ws://otherbroker.example:8883',
  iataCode: 'mco',
  tokenAudience: 'mqtt.other.test',
};

describe('PUT /:id — Analyzer Observer hot-swap (#4457 Phase 2, WP6)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', sourceRoutes),
    });

    mockSourceRegistry.getManager.mockReset();
    mockSourceRegistry.reconfigureObserver.mockReset();
    mockSourceRegistry.removeManager.mockReset();
    mockSourceRegistry.addManager.mockReset();
    mockSourceRegistry.getManager.mockReturnValue(undefined);
    mockSourceRegistry.reconfigureObserver.mockResolvedValue(true);
    mockSourceRegistry.removeManager.mockResolvedValue(undefined);
    mockSourceRegistry.addManager.mockResolvedValue(undefined);

    await harness.db.sources.deleteSource(SOURCE_ID).catch(() => {});
  });

  afterEach(async () => {
    await harness.db.sources.deleteSource(SOURCE_ID).catch(() => {});
    await harness.cleanup();
  });

  async function seedSource(config: Record<string, unknown>) {
    await harness.db.sources.createSource({
      id: SOURCE_ID,
      name: 'Observer Reconfig Source',
      type: 'meshcore',
      config,
      enabled: true,
    });
  }

  it('an observer-only change calls reconfigureObserver and NOT removeManager', async () => {
    await seedSource({ ...BASE_CONFIG });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put(`/${SOURCE_ID}`).send({
      config: { ...BASE_CONFIG, observer: OBSERVER_A },
    });

    expect(res.status).toBe(200);
    expect(mockSourceRegistry.reconfigureObserver).toHaveBeenCalledTimes(1);
    expect(mockSourceRegistry.reconfigureObserver).toHaveBeenCalledWith(SOURCE_ID, OBSERVER_A);
    expect(mockSourceRegistry.removeManager).not.toHaveBeenCalled();
    expect(mockSourceRegistry.addManager).not.toHaveBeenCalled();
  });

  it('a change touching any other config key (observer unchanged) takes the restart branch', async () => {
    await seedSource({ ...BASE_CONFIG, heartbeatIntervalSeconds: 5 });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put(`/${SOURCE_ID}`).send({
      config: { ...BASE_CONFIG, heartbeatIntervalSeconds: 30 },
    });

    expect(res.status).toBe(200);
    expect(mockSourceRegistry.removeManager).toHaveBeenCalledWith(SOURCE_ID);
    expect(mockSourceRegistry.addManager).toHaveBeenCalledTimes(1);
    expect(mockSourceRegistry.reconfigureObserver).not.toHaveBeenCalled();
  });

  it('a change touching both the observer block and another key takes the restart branch', async () => {
    await seedSource({ ...BASE_CONFIG, heartbeatIntervalSeconds: 5, observer: OBSERVER_A });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put(`/${SOURCE_ID}`).send({
      config: { ...BASE_CONFIG, heartbeatIntervalSeconds: 30, observer: OBSERVER_B },
    });

    expect(res.status).toBe(200);
    expect(mockSourceRegistry.removeManager).toHaveBeenCalledWith(SOURCE_ID);
    expect(mockSourceRegistry.addManager).toHaveBeenCalledTimes(1);
    expect(mockSourceRegistry.reconfigureObserver).not.toHaveBeenCalled();
  });

  it('a no-op resubmission (nothing changed) also takes the restart branch, unchanged from pre-WP6 behavior', async () => {
    await seedSource({ ...BASE_CONFIG, observer: OBSERVER_A });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put(`/${SOURCE_ID}`).send({
      config: { ...BASE_CONFIG, observer: OBSERVER_A },
    });

    expect(res.status).toBe(200);
    expect(mockSourceRegistry.removeManager).toHaveBeenCalledWith(SOURCE_ID);
    expect(mockSourceRegistry.reconfigureObserver).not.toHaveBeenCalled();
  });
});

describe('SourceManagerRegistry.reconfigureObserver — duck-typed guard (#4457 Phase 2, WP6)', () => {
  // Exercises the REAL SourceManagerRegistry class (not the mock above) end to
  // end, per spec §5's "duck-typed typeof check, returns false when
  // unsupported" requirement. Never `instanceof`.
  function stubManager(overrides: Partial<ISourceManager> = {}): ISourceManager {
    return {
      sourceId: 'stub-source',
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: () => ({
        sourceId: 'stub-source',
        sourceName: 'Stub',
        sourceType: 'meshtastic_tcp',
        connected: false,
      }),
      getLocalNodeInfo: () => null,
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
      ...overrides,
    } as ISourceManager;
  }

  it('returns false without throwing when the registered manager has no reconfigureObserver', async () => {
    const registry = new SourceManagerRegistry();
    await registry.addManager(stubManager());

    await expect(registry.reconfigureObserver('stub-source', { enabled: true })).resolves.toBe(false);
  });

  it('returns false without throwing for a sourceId with no registered manager at all', async () => {
    const registry = new SourceManagerRegistry();

    await expect(registry.reconfigureObserver('does-not-exist', undefined)).resolves.toBe(false);
  });

  it('delegates to the manager and returns true when reconfigureObserver is supported', async () => {
    const registry = new SourceManagerRegistry();
    const reconfigureObserver = vi.fn().mockResolvedValue(undefined);
    await registry.addManager(stubManager({ reconfigureObserver } as unknown as Partial<ISourceManager>));

    const cfg = { enabled: true, brokerUrl: 'ws://x', iataCode: 'test', tokenAudience: 'aud' };
    await expect(registry.reconfigureObserver('stub-source', cfg)).resolves.toBe(true);
    expect(reconfigureObserver).toHaveBeenCalledWith(cfg);
  });
});
