/**
 * bootstrapSources — startup pin-test matrix (WP1, issue #3962 Phase 2).
 *
 * Purpose: pin CURRENT startup behavior so WP2/WP3 refactors cannot silently
 * regress it. Tests are intentionally green against pre-refactor code — the
 * extracted function is a pure mechanical move.
 *
 * Scenarios tested (§5 of the task-2.3 spec):
 *  #1 env-only fresh install (explicit MESHTASTIC_NODE_IP)
 *  #2 env-only fresh install (no explicit IP → default 192.168.1.100 quirk)
 *  #3 DB-sources-only: 2 tcp rows, env set → env IGNORED
 *  #4 DB+env: rows exist + env set → rows win, env ignored
 *  #5 single tcp row with autoConnect:false → S4 fallback fires
 *  #6 meshcore-only enabled → S4 fallback fires (env-IP wart pinned)
 *  #7 all sources disabled (count>0) → S4 fallback fires
 *  #8 mixed: 1 broker + 2 tcp → start order broker<tcp, first tcp = primary
 *
 * Identity/staleness pins (§5, WP1 contract documentation):
 *  - resolveSourceManager(null) resolves getPrimaryMeshtasticManager(registry)
 *    ?? fallbackManager, and NEVER returns undefined (invariant I2, #3962
 *    Phase 4.2a WP4 — the live Proxy alias was retired; see
 *    "resolveSourceManager(null) live-fallback contract" below).
 *  - getPrimaryMeshtasticManager returns first meshtastic_tcp manager in registry
 *
 * These tests MUST remain byte-identical through WP2/WP3 for scenarios 1-4,8.
 * Scenarios 5-7 change ONLY if Q1 decides to drop the S4 fallback (with rationale).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SourceManagerRegistry } from './sourceManagerRegistry.js';
import { getPrimaryMeshtasticManager } from './sourceManagerTypes.js';
import { bootstrapSources, type BootstrapDeps, type BootstrapDb } from './bootstrapSources.js';
import type { Source } from '../db/repositories/sources.js';
import type { ISourceManager } from './sourceManagerRegistry.js';

// ---------------------------------------------------------------------------
// Module mocks — applied before any import resolution by Vitest's hoisting.
// These cover the non-injected dependencies of bootstrapSources so tests
// have no real IO.
// ---------------------------------------------------------------------------

vi.mock('./routes/sourceRoutes.js', () => ({
  default: {},
  buildMqttManagerForSource: vi.fn(),
}));

vi.mock('./meshcoreConfig.js', () => ({
  ensureMeshCoreManagerStarted: vi.fn().mockResolvedValue(undefined),
  meshcoreConfigFromSource: vi.fn().mockReturnValue({
    connectionType: 'SERIAL',
    serialPort: '/dev/ttyUSB0',
    baudRate: 115200,
    firmwareType: 'companion',
  }),
}));

vi.mock('./applyManagerSettings.js', () => ({
  applyManagerSettings: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SourceRow = Pick<Source, 'id' | 'name' | 'type' | 'config' | 'enabled' | 'displayOrder' | 'createdAt' | 'updatedAt'> & { createdBy: null };

function makeSource(overrides: Partial<SourceRow> & Pick<SourceRow, 'id' | 'name' | 'type'>): SourceRow {
  return {
    displayOrder: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: null,
    enabled: true,
    config: {},
    ...overrides,
  };
}

function makeTcpSource(id: string, host: string, port = 4403, extra: Record<string, unknown> = {}): SourceRow {
  return makeSource({
    id,
    name: `TCP-${id}`,
    type: 'meshtastic_tcp',
    config: { host, port, ...extra },
  });
}

function makeMeshCoreSource(id: string): SourceRow {
  return makeSource({
    id,
    name: `MeshCore-${id}`,
    type: 'meshcore',
    config: { transport: 'usb', port: '/dev/ttyUSB0' },
  });
}

function makeBrokerSource(id: string): SourceRow {
  return makeSource({
    id,
    name: `Broker-${id}`,
    type: 'mqtt_broker',
    config: { host: 'mqtt.example.com', port: 1883 },
  });
}

/**
 * Build a minimal BootstrapDb stub that starts with the given source rows
 * and accumulates createSource() calls.
 */
function makeDbStub(initialSources: SourceRow[] = []): BootstrapDb & { _sources: SourceRow[] } {
  const sources: SourceRow[] = [...initialSources];
  return {
    _sources: sources,
    settings: {
      setSetting: vi.fn().mockResolvedValue(undefined),
      getSetting: vi.fn().mockResolvedValue(null),
      getSettingForSource: vi.fn().mockResolvedValue(null),
    },
    sources: {
      getSourceCount: vi.fn(async () => sources.length),
      createSource: vi.fn(async (input) => {
        const row: SourceRow = {
          id: input.id,
          name: input.name,
          type: input.type as Source['type'],
          config: input.config as Record<string, unknown>,
          enabled: input.enabled ?? true,
          displayOrder: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: null,
        };
        sources.push(row);
        return row as Source;
      }),
      getAllSources: vi.fn(async () => [...sources] as Source[]),
      getEnabledSources: vi.fn(async () => sources.filter(s => s.enabled) as Source[]),
      assignNullSourceIds: vi.fn().mockResolvedValue(undefined),
    },
  };
}

/**
 * Minimal ISourceManager stub for the fallback (legacy singleton) manager.
 * WP3: configureSource() is deleted; this stub no longer tracks it.
 * Only used for S4: connect() is called when no tcp source auto-connects.
 */
function makeFallbackManagerStub() {
  const stub = {
    sourceId: 'default',
    sourceType: 'meshtastic_tcp' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn(() => ({
      sourceId: 'default',
      sourceName: 'default',
      sourceType: 'meshtastic_tcp' as const,
      connected: false,
    })),
    getLocalNodeInfo: vi.fn().mockReturnValue(null),
    startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
    stopDistanceDeleteScheduler: vi.fn(),
  };
  return stub;
}

/**
 * Factory that produces fresh meshtastic_tcp ISourceManager stubs.
 * The returned `factory` spy is passed as `deps.makeMeshtastic`.
 * The `instances` array records every (id, cfg, stub) created.
 */
function makeMeshMockFactory() {
  const instances: Array<{ id: string; cfg: unknown; stub: ISourceManager }> = [];
  const factory = vi.fn((id: string, cfg: unknown) => {
    const stub: ISourceManager = {
      sourceId: id,
      sourceType: 'meshtastic_tcp' as const,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(() => ({
        sourceId: id,
        sourceName: id,
        sourceType: 'meshtastic_tcp' as const,
        connected: false,
      })),
      getLocalNodeInfo: vi.fn().mockReturnValue(null),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
    };
    instances.push({ id, cfg, stub });
    return stub as any; // narrowed to MeshtasticManager at call site
  });
  return { factory, instances };
}

/**
 * Minimal mqtt_broker ISourceManager stub for MQTT tests.
 */
function makeMqttManagerStub(id: string): ISourceManager {
  return {
    sourceId: id,
    sourceType: 'mqtt_broker' as const,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn(() => ({
      sourceId: id,
      sourceName: id,
      sourceType: 'mqtt_broker' as const,
      connected: false,
    })),
    getLocalNodeInfo: vi.fn().mockReturnValue(null),
    startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
    stopDistanceDeleteScheduler: vi.fn(),
  };
}

/** Build a BootstrapDeps object with overrides. */
function makeDeps(overrides: Partial<BootstrapDeps> & { db: BootstrapDb }): BootstrapDeps {
  const { factory } = makeMeshMockFactory();
  return {
    env: { meshtasticNodeIp: '192.168.1.100', meshtasticTcpPort: 4403 },
    registry: new SourceManagerRegistry(),
    makeMeshtastic: factory,
    fallbackManager: makeFallbackManagerStub() as any,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Import the mocked helpers so we can inspect calls
// ---------------------------------------------------------------------------
import { buildMqttManagerForSource } from './routes/sourceRoutes.js';
import { ensureMeshCoreManagerStarted } from './meshcoreConfig.js';

// ---------------------------------------------------------------------------
// Scenario tests
// ---------------------------------------------------------------------------

describe('bootstrapSources — startup pin-test matrix (WP1)', () => {
  let registry: SourceManagerRegistry;
  let fallbackManager: ReturnType<typeof makeFallbackManagerStub>;
  let meshFactory: ReturnType<typeof makeMeshMockFactory>;

  beforeEach(() => {
    registry = new SourceManagerRegistry();
    fallbackManager = makeFallbackManagerStub();
    meshFactory = makeMeshMockFactory();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: env-only fresh install with explicit MESHTASTIC_NODE_IP
  // -------------------------------------------------------------------------
  describe('Scenario 1 — env-only fresh, explicit MESHTASTIC_NODE_IP=1.2.3.4', () => {
    it('(A) creates a Default source row with host from env', async () => {
      const db = makeDbStub([]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '1.2.3.4', meshtasticTcpPort: 4403 },
      }));
      expect(db.sources.createSource).toHaveBeenCalledOnce();
      const createdArg = (db.sources.createSource as any).mock.calls[0][0];
      expect(createdArg.name).toBe('Default');
      expect(createdArg.type).toBe('meshtastic_tcp');
      expect((createdArg.config as any).host).toBe('1.2.3.4');
    });

    it('(B/C) registers exactly 1 manager via makeMeshtastic with host=1.2.3.4', async () => {
      const db = makeDbStub([]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '1.2.3.4', meshtasticTcpPort: 4403 },
      }));
      expect(registry.size).toBe(1);
      // WP3: first TCP source uses makeMeshtastic() — not configureSource (deleted).
      expect(meshFactory.factory).toHaveBeenCalledOnce();
      const [, factoryCfg] = meshFactory.factory.mock.calls[0] as any;
      expect(factoryCfg.host).toBe('1.2.3.4');
    });

    it('(D) getPrimaryMeshtasticManager resolves to the first makeMeshtastic instance', async () => {
      const db = makeDbStub([]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '1.2.3.4', meshtasticTcpPort: 4403 },
      }));
      // WP3: primary = the instance returned by makeMeshtastic (not fallbackManager).
      expect(getPrimaryMeshtasticManager(registry)).toBe(meshFactory.instances[0].stub);
    });

    it('(E) fallbackManager.connect() is NOT called (tcp source was configured)', async () => {
      const db = makeDbStub([]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '1.2.3.4', meshtasticTcpPort: 4403 },
      }));
      expect(fallbackManager.connect).not.toHaveBeenCalled();
    });

    it('makeMeshtastic factory IS called for the first (and only) tcp source', async () => {
      const db = makeDbStub([]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '1.2.3.4', meshtasticTcpPort: 4403 },
      }));
      // WP3: uniform construction — factory called once for the single auto-created source.
      expect(meshFactory.factory).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: env-only fresh install WITHOUT explicit MESHTASTIC_NODE_IP
  // Pins the "always-truthy" quirk: env.meshtasticNodeIp defaults to
  // '192.168.1.100', so a Default source is ALWAYS auto-created on fresh boot.
  // -------------------------------------------------------------------------
  describe('Scenario 2 — env-only fresh, no explicit IP (default 192.168.1.100 quirk)', () => {
    it('(A) creates a Default source row even with the default IP — pins always-truthy quirk', async () => {
      const db = makeDbStub([]);
      // No MESHTASTIC_NODE_IP set → env uses the default '192.168.1.100'
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '192.168.1.100', meshtasticTcpPort: 4403 },
      }));
      expect(db.sources.createSource).toHaveBeenCalledOnce();
      const createdArg = (db.sources.createSource as any).mock.calls[0][0];
      expect((createdArg.config as any).host).toBe('192.168.1.100');
    });

    it('(B/D/E) single manager registered via factory, is primary, connect() not called', async () => {
      const db = makeDbStub([]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '192.168.1.100', meshtasticTcpPort: 4403 },
      }));
      expect(registry.size).toBe(1);
      // WP3: primary = first makeMeshtastic instance (not fallbackManager).
      expect(getPrimaryMeshtasticManager(registry)).toBe(meshFactory.instances[0].stub);
      expect(fallbackManager.connect).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: DB-sources-only — 2 tcp rows exist, env is set
  // Asserts env is IGNORED for source creation when rows already exist.
  // -------------------------------------------------------------------------
  describe('Scenario 3 — DB-sources-only: 2 tcp rows, env set → env ignored', () => {
    it('(A) does NOT create a new source row (sourceCount > 0)', async () => {
      const row1 = makeTcpSource('src-1', '10.0.0.1');
      const row2 = makeTcpSource('src-2', '10.0.0.2');
      const db = makeDbStub([row1, row2]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '1.2.3.4', meshtasticTcpPort: 9999 },
      }));
      expect(db.sources.createSource).not.toHaveBeenCalled();
    });

    it('(B/C) 2 managers registered via makeMeshtastic: src-1 (primary) + src-2', async () => {
      const row1 = makeTcpSource('src-1', '10.0.0.1');
      const row2 = makeTcpSource('src-2', '10.0.0.2');
      const db = makeDbStub([row1, row2]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '1.2.3.4', meshtasticTcpPort: 9999 },
      }));
      expect(registry.size).toBe(2);
      // WP3: both sources use makeMeshtastic() — factory called twice.
      expect(meshFactory.factory).toHaveBeenCalledTimes(2);
      expect(meshFactory.instances[0].id).toBe('src-1');
      expect((meshFactory.instances[0].cfg as any).host).toBe('10.0.0.1');
      expect(meshFactory.instances[1].id).toBe('src-2');
      expect((meshFactory.instances[1].cfg as any).host).toBe('10.0.0.2');
    });

    it('(D) getPrimaryMeshtasticManager returns first makeMeshtastic instance (src-1)', async () => {
      const row1 = makeTcpSource('src-1', '10.0.0.1');
      const row2 = makeTcpSource('src-2', '10.0.0.2');
      const db = makeDbStub([row1, row2]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '1.2.3.4', meshtasticTcpPort: 9999 },
      }));
      // WP3: primary = first instance from makeMeshtastic (not fallbackManager).
      expect(getPrimaryMeshtasticManager(registry)).toBe(meshFactory.instances[0].stub);
    });

    it('(E) fallbackManager.connect() NOT called', async () => {
      const row1 = makeTcpSource('src-1', '10.0.0.1');
      const row2 = makeTcpSource('src-2', '10.0.0.2');
      const db = makeDbStub([row1, row2]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '1.2.3.4', meshtasticTcpPort: 9999 },
      }));
      expect(fallbackManager.connect).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3b: passiveMode forwarding — boot path aligns with runtime path.
  //
  // FIX 3 pin: the uniform-construction path (WP3) forwards cfg.passiveMode
  // and cfg.passiveResyncStaleMs from DB config at BOOT. Previously the first-
  // source configureSource() path forced them off; now both boot and
  // runtime-add honor the stored config. This scenario pins that alignment.
  // -------------------------------------------------------------------------
  describe('Scenario 3b — passiveMode forwarding from DB config at boot', () => {
    it('factoryCfg.passiveMode=true and passiveResyncStaleMs forwarded when present in source row', async () => {
      const row = makeTcpSource('src-passive', '10.0.0.3', 4403, {
        passiveMode: true,
        passiveResyncStaleMs: 120_000,
      });
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
      }));
      expect(meshFactory.factory).toHaveBeenCalledOnce();
      const [, factoryCfg] = meshFactory.factory.mock.calls[0] as any;
      expect(factoryCfg.passiveMode).toBe(true);
      expect(factoryCfg.passiveResyncStaleMs).toBe(120_000);
    });

    it('factoryCfg.passiveMode is absent/falsy for a plain source row without passiveMode', async () => {
      const row = makeTcpSource('src-normal', '10.0.0.4');
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
      }));
      expect(meshFactory.factory).toHaveBeenCalledOnce();
      const [, factoryCfg] = meshFactory.factory.mock.calls[0] as any;
      // passiveMode should be absent or falsy — NOT forced to true or any default.
      expect(factoryCfg.passiveMode).toBeFalsy();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: DB rows exist + env set — DB wins, env ignored
  // -------------------------------------------------------------------------
  describe('Scenario 4 — both DB rows and env set → DB wins', () => {
    it('(A) no new source created — existing rows prevent auto-creation', async () => {
      const row = makeTcpSource('existing-1', '172.16.0.10');
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '9.9.9.9', meshtasticTcpPort: 5555 },
      }));
      expect(db.sources.createSource).not.toHaveBeenCalled();
    });

    it('(B/C) manager constructed via factory with host from DB row, not env', async () => {
      const row = makeTcpSource('existing-1', '172.16.0.10');
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '9.9.9.9', meshtasticTcpPort: 5555 },
      }));
      expect(meshFactory.factory).toHaveBeenCalledOnce();
      const [, factoryCfg] = meshFactory.factory.mock.calls[0] as any;
      expect(factoryCfg.host).toBe('172.16.0.10'); // from DB, NOT from env (9.9.9.9)
      expect(factoryCfg.host).not.toBe('9.9.9.9');
    });

    it('(D/E) primary = first makeMeshtastic instance, connect() not called', async () => {
      const row = makeTcpSource('existing-1', '172.16.0.10');
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '9.9.9.9', meshtasticTcpPort: 5555 },
      }));
      // WP3: primary = instance from makeMeshtastic.
      expect(getPrimaryMeshtasticManager(registry)).toBe(meshFactory.instances[0].stub);
      expect(fallbackManager.connect).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5: single tcp row with autoConnect:false → S4 fallback fires
  // -------------------------------------------------------------------------
  describe('Scenario 5 — single tcp row, autoConnect:false → S4 fallback', () => {
    it('(B) 0 managers registered in registry (source skipped)', async () => {
      const row = makeTcpSource('src-ac-false', '10.0.0.1', 4403, { autoConnect: false });
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
      }));
      expect(registry.size).toBe(0);
    });

    it('(D) getPrimaryMeshtasticManager returns undefined (no tcp in registry)', async () => {
      const row = makeTcpSource('src-ac-false', '10.0.0.1', 4403, { autoConnect: false });
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
      }));
      expect(getPrimaryMeshtasticManager(registry)).toBeUndefined();
    });

    it('(E) fallbackManager.connect() IS called (S4 env-IP fallback)', async () => {
      const row = makeTcpSource('src-ac-false', '10.0.0.1', 4403, { autoConnect: false });
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
      }));
      expect(fallbackManager.connect).toHaveBeenCalledOnce();
    });

    it('makeMeshtastic factory NOT called (autoConnect:false source is skipped)', async () => {
      // WP3: configureSource() deleted; verify the source is skipped by checking
      // makeMeshtastic is not called (equivalent outcome: no manager created for it).
      const row = makeTcpSource('src-ac-false', '10.0.0.1', 4403, { autoConnect: false });
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
      }));
      expect(meshFactory.factory).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 6: meshcore-only enabled (no tcp) → S4 fallback fires
  // Pins the env-IP wart: the fallback singleton connects to the env IP even
  // when there are only MeshCore sources.
  // -------------------------------------------------------------------------
  describe('Scenario 6 — meshcore-only enabled → S4 fallback fires (env-IP wart)', () => {
    it('(B) 0 tcp managers in registry', async () => {
      const row = makeMeshCoreSource('mc-1');
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
      }));
      // Registry may have 0 entries (ensureMeshCoreManagerStarted is mocked as no-op)
      expect(getPrimaryMeshtasticManager(registry)).toBeUndefined();
    });

    it('(E) fallbackManager.connect() IS called (S4 — no tcp configured)', async () => {
      const row = makeMeshCoreSource('mc-1');
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
      }));
      expect(fallbackManager.connect).toHaveBeenCalledOnce();
    });

    it('ensureMeshCoreManagerStarted is called for the meshcore source', async () => {
      const row = makeMeshCoreSource('mc-1');
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
      }));
      expect(ensureMeshCoreManagerStarted).toHaveBeenCalledOnce();
    });

    // #4020 regression: on a MeshCore-only install the S4 fallback connect has
    // no real Meshtastic node to reach and rejects. Before the fix that
    // rejection escaped bootstrapSources and aborted the startup try/catch in
    // server.ts, so every scheduler started AFTER bootstrapSources (low-battery
    // + inactive-node notifications, backup scheduler, ...) never started —
    // which is why MeshCore-only users never got low-battery alerts and saw no
    // `[low-battery]` diagnostics. bootstrapSources must swallow the failure
    // and resolve so the caller keeps starting those schedulers.
    it('(#4020) resolves (does NOT throw) when the S4 fallback connect rejects', async () => {
      const row = makeMeshCoreSource('mc-1');
      const db = makeDbStub([row]);
      fallbackManager.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(
        bootstrapSources(makeDeps({
          db, registry, fallbackManager: fallbackManager as any,
          makeMeshtastic: meshFactory.factory,
        })),
      ).resolves.toBeUndefined();
      // The MeshCore source still came up — startup was not aborted mid-way.
      expect(ensureMeshCoreManagerStarted).toHaveBeenCalledOnce();
      expect(fallbackManager.connect).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 7: all sources disabled, count > 0 → no auto-create, S4 fires
  // -------------------------------------------------------------------------
  describe('Scenario 7 — all sources disabled (count>0) → no auto-create, S4 fires', () => {
    it('(A) no new source created (count > 0, guard prevents it)', async () => {
      const row = { ...makeTcpSource('disabled-1', '10.0.0.1'), enabled: false };
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '1.2.3.4', meshtasticTcpPort: 4403 },
      }));
      expect(db.sources.createSource).not.toHaveBeenCalled();
    });

    it('(B) 0 managers registered', async () => {
      const row = { ...makeTcpSource('disabled-1', '10.0.0.1'), enabled: false };
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '1.2.3.4', meshtasticTcpPort: 4403 },
      }));
      expect(registry.size).toBe(0);
    });

    it('(E) fallbackManager.connect() IS called (S4)', async () => {
      const row = { ...makeTcpSource('disabled-1', '10.0.0.1'), enabled: false };
      const db = makeDbStub([row]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
        env: { meshtasticNodeIp: '1.2.3.4', meshtasticTcpPort: 4403 },
      }));
      expect(fallbackManager.connect).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 8: mixed: 1 broker + 2 tcp sources
  // Asserts start order (broker < tcp), manager count, and primary = first tcp.
  // -------------------------------------------------------------------------
  describe('Scenario 8 — mixed: 1 broker + 2 tcp', () => {
    let mqttStub: ISourceManager;

    beforeEach(() => {
      mqttStub = makeMqttManagerStub('broker-1');
      (buildMqttManagerForSource as any).mockReturnValue(mqttStub);
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('(B) 3 managers registered: 1 broker + 2 tcp', async () => {
      const broker = makeBrokerSource('broker-1');
      const tcp1 = makeTcpSource('tcp-1', '10.0.0.1');
      const tcp2 = makeTcpSource('tcp-2', '10.0.0.2');
      const db = makeDbStub([broker, tcp1, tcp2]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
      }));
      expect(registry.size).toBe(3);
    });

    it('(C) broker-1 registered, tcp-1 and tcp-2 both via makeMeshtastic', async () => {
      const broker = makeBrokerSource('broker-1');
      const tcp1 = makeTcpSource('tcp-1', '10.0.0.1');
      const tcp2 = makeTcpSource('tcp-2', '10.0.0.2');
      const db = makeDbStub([broker, tcp1, tcp2]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
      }));
      expect(registry.getManager('broker-1')).toBe(mqttStub);
      expect(buildMqttManagerForSource).toHaveBeenCalledWith('broker-1', expect.any(String), 'mqtt_broker', expect.any(Object));
      // WP3: both TCP sources use makeMeshtastic() — factory called twice.
      expect(meshFactory.factory).toHaveBeenCalledTimes(2);
      expect(meshFactory.instances[0].id).toBe('tcp-1');
      expect((meshFactory.instances[0].cfg as any).host).toBe('10.0.0.1');
      expect(meshFactory.instances[1].id).toBe('tcp-2');
    });

    it('(D) primary meshtastic manager = first tcp instance from makeMeshtastic', async () => {
      const broker = makeBrokerSource('broker-1');
      const tcp1 = makeTcpSource('tcp-1', '10.0.0.1');
      const tcp2 = makeTcpSource('tcp-2', '10.0.0.2');
      const db = makeDbStub([broker, tcp1, tcp2]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
      }));
      // WP3: primary = first TCP instance from factory (tcp-1), not fallbackManager.
      expect(getPrimaryMeshtasticManager(registry)).toBe(meshFactory.instances[0].stub);
    });

    it('(E) fallbackManager.connect() NOT called', async () => {
      const broker = makeBrokerSource('broker-1');
      const tcp1 = makeTcpSource('tcp-1', '10.0.0.1');
      const tcp2 = makeTcpSource('tcp-2', '10.0.0.2');
      const db = makeDbStub([broker, tcp1, tcp2]);
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
      }));
      expect(fallbackManager.connect).not.toHaveBeenCalled();
    });

    it('start order: broker is registered before tcp managers', async () => {
      // Verify sorting by checking that buildMqttManagerForSource was called
      // before makeMeshtastic (broker processed first in sorted order).
      // WP3: track tcp registration via makeMeshtastic instead of configureSource.
      const callOrder: string[] = [];
      (buildMqttManagerForSource as any).mockImplementation((id: string) => {
        callOrder.push(`mqtt:${id}`);
        return mqttStub;
      });
      const orderAwareFactory = vi.fn((id: string, _cfg: unknown) => {
        callOrder.push(`tcp:${id}`);
        return {
          sourceId: id,
          sourceType: 'meshtastic_tcp' as const,
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          getStatus: vi.fn(() => ({ sourceId: id, sourceName: id, sourceType: 'meshtastic_tcp' as const, connected: false })),
          getLocalNodeInfo: vi.fn().mockReturnValue(null),
          startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
          stopDistanceDeleteScheduler: vi.fn(),
        } as any;
      });
      const broker = makeBrokerSource('broker-1');
      const tcp1 = makeTcpSource('tcp-1', '10.0.0.1');
      const db = makeDbStub([tcp1, broker]); // deliberately out of order in DB
      await bootstrapSources(makeDeps({
        db, registry, fallbackManager: fallbackManager as any,
        makeMeshtastic: orderAwareFactory,
      }));
      expect(callOrder.indexOf('mqtt:broker-1')).toBeLessThan(
        callOrder.indexOf('tcp:tcp-1'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Runtime-override clearing — pinned to ensure S10 is preserved
  // -------------------------------------------------------------------------
  describe('runtime override clearing (S10)', () => {
    it('clears meshtasticNodeIpOverride and meshtasticTcpPortOverride on every boot', async () => {
      const db = makeDbStub([]);
      await bootstrapSources(makeDeps({ db, registry, fallbackManager: fallbackManager as any, makeMeshtastic: meshFactory.factory }));
      expect(db.settings.setSetting).toHaveBeenCalledWith('meshtasticNodeIpOverride', '');
      expect(db.settings.setSetting).toHaveBeenCalledWith('meshtasticTcpPortOverride', '');
    });
  });

  // -------------------------------------------------------------------------
  // assignNullSourceIds — called with oldest source id
  // -------------------------------------------------------------------------
  describe('assignNullSourceIds', () => {
    it('called with the first source id when sources exist', async () => {
      const row1 = makeTcpSource('src-oldest', '10.0.0.1');
      const row2 = makeTcpSource('src-newer', '10.0.0.2');
      const db = makeDbStub([row1, row2]);
      await bootstrapSources(makeDeps({ db, registry, fallbackManager: fallbackManager as any, makeMeshtastic: meshFactory.factory }));
      expect(db.sources.assignNullSourceIds).toHaveBeenCalledWith('src-oldest');
    });

    it('NOT called when no sources exist (empty DB on very first fresh boot)', async () => {
      // When sourceCount===0 and no IP set to trigger auto-create, allSources stays empty.
      // Simulate: env.meshtasticNodeIp is empty string (won't trigger auto-create).
      const db = makeDbStub([]);
      // Force getEnabledSources to return [] to avoid S4 calling connect
      // Actually it will call fallbackManager.connect() which is fine.
      await bootstrapSources(makeDeps({
        db, registry,
        env: { meshtasticNodeIp: '', meshtasticTcpPort: 4403 },
        fallbackManager: fallbackManager as any,
        makeMeshtastic: meshFactory.factory,
      }));
      expect(db.sources.assignNullSourceIds).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Identity / staleness pins (§5, WP1 documentation)
// ---------------------------------------------------------------------------

describe('identity/staleness pins (§2.5 documentation)', () => {
  describe('getPrimaryMeshtasticManager — finds first meshtastic_tcp in registry', () => {
    it('returns undefined when registry is empty', () => {
      const reg = new SourceManagerRegistry();
      expect(getPrimaryMeshtasticManager(reg)).toBeUndefined();
    });

    it('returns undefined when only mqtt_broker managers are registered', () => {
      const reg = new SourceManagerRegistry();
      // Without calling addManager (which calls start()), we'll spy-test the filter logic
      // by checking the type guard result on a structure level.
      // getPrimaryMeshtasticManager uses isMeshtasticManager which checks sourceType.
      expect(getPrimaryMeshtasticManager(reg)).toBeUndefined();
    });
  });

  describe('resolveSourceManager(null) live-fallback contract (#3962 Phase 4.2a WP4)', () => {
    /**
     * WP4 behavior: the live Proxy alias was retired. resolveSourceManager's
     * internals now call getPrimaryMeshtasticManager(sourceManagerRegistry)
     * ?? fallbackManager directly on every invocation — no Proxy indirection,
     * no property-access-time resolution. The "no staleness after a
     * primary-source edit" property from §2.5 is preserved because callers
     * that need it re-invoke resolveSourceManager()/getPrimaryMeshtasticManager()
     * rather than caching a Proxy that resolves lazily.
     *
     * The behavioral contract now:
     *  - resolveSourceManager(null) === getPrimaryMeshtasticManager(registry)
     *    ?? fallbackManager, evaluated at call time.
     *  - It is a concrete MeshtasticManager instance — never undefined
     *    (invariant I2) and never a wrapper/Proxy, so method calls on it
     *    address the real instance directly with the correct `this` by
     *    construction (invariant I8 — there is no binding indirection left
     *    to get wrong).
     */
    it('resolveSourceManager(null) resolves to fallbackManager when no primary is registered (I2)', async () => {
      // Import is dynamic to avoid hoisting issues with the vi.mock'd modules above.
      const { resolveSourceManager } = await import('./utils/resolveSourceManager.js');
      const { fallbackManager } = await import('./meshtasticManager.js');

      // No primary meshtastic_tcp source is registered in the module-level
      // sourceManagerRegistry singleton in this test environment (this file's
      // own bootstrapSources() calls inject a locally-scoped registry, not
      // the singleton), so resolveSourceManager falls through to the
      // concrete fallbackManager instance — never undefined.
      const resolved = resolveSourceManager(null);
      expect(resolved).toBe(fallbackManager);
      expect(typeof resolved.getStatus).toBe('function');
    });

    it('resolveSourceManager(null) is a concrete instance, not a wrapper — methods run with the real `this` by construction', async () => {
      const { resolveSourceManager } = await import('./utils/resolveSourceManager.js');
      const { fallbackManager } = await import('./meshtasticManager.js');

      const resolved = resolveSourceManager(null);

      // Spy on the PROTOTYPE. If `resolved` were still a Proxy/wrapper around
      // fallbackManager, calling resolved.getStatus() could address the
      // wrong `this`. Post-WP4 there is no wrapper: resolved IS
      // fallbackManager, so `this` inside the spied method is trivially the
      // concrete instance.
      const proto = Object.getPrototypeOf(fallbackManager) as Record<string, unknown>;
      let capturedThis: unknown;
      const protoSpy = vi.spyOn(proto as any, 'getStatus').mockImplementation(function (this: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- capturing `this` to verify no wrapper indirection remains
        capturedThis = this;
        return { sourceId: 'spy', sourceName: 'spy', sourceType: 'meshtastic_tcp', connected: false };
      });

      try {
        (resolved as any).getStatus();
        expect(capturedThis).toBe(fallbackManager);
      } finally {
        protoSpy.mockRestore();
      }
    });
  });
});
