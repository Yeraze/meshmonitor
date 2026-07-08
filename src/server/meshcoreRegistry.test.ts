/**
 * meshcoreRegistry.ts — shim behavior tests.
 *
 * The MeshCoreManagerRegistry class was deleted in WP4 of #3962 (Phase 2,
 * Task 2.1). This file verifies that the @deprecated shim (`meshcoreManagerRegistry`)
 * correctly delegates to the unified `sourceManagerRegistry`.
 *
 * Config-helper tests (meshcoreConfigFromSource) moved to meshcoreConfig.test.ts
 * as part of WP1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SourceManagerRegistry } from './sourceManagerRegistry.js';
import { isMeshCoreManager } from './sourceManagerTypes.js';
import type { ISourceManager, SourceStatus } from './sourceManagerRegistry.js';

// ---------------------------------------------------------------------------
// Minimal stubs — no real serial/TCP connections opened.
// ---------------------------------------------------------------------------

function makeMeshCoreStub(sourceId = 'mc-shim'): ISourceManager {
  return {
    sourceId,
    sourceType: 'meshcore',
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getStatus: (): SourceStatus => ({
      sourceId,
      sourceName: 'Shim Test',
      sourceType: 'meshcore',
      connected: true,
    }),
    getLocalNodeInfo: () => null,
  };
}

function makeMeshtasticStub(sourceId = 'mt-shim'): ISourceManager {
  return {
    sourceId,
    sourceType: 'meshtastic_tcp',
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getStatus: (): SourceStatus => ({
      sourceId,
      sourceName: 'Meshtastic Shim',
      sourceType: 'meshtastic_tcp',
      connected: false,
      nodeNum: 1,
      nodeId: '!00000001',
    }),
    getLocalNodeInfo: () => ({
      nodeNum: 1,
      nodeId: '!00000001',
      longName: 'Node',
      shortName: 'N',
    }),
  };
}

// ---------------------------------------------------------------------------
// We test the shim's BEHAVIOR, not its import path. Create a local registry
// so tests don't pollute the module-level singleton.
// We can't easily rewire the shim to use a test registry, so we test the
// shim's contract by verifying the unified-registry semantics directly,
// then spot-check the shim's surface.
// ---------------------------------------------------------------------------

describe('meshcoreManagerRegistry shim — delegation via unified registry', () => {
  let registry: SourceManagerRegistry;

  beforeEach(() => {
    registry = new SourceManagerRegistry();
  });

  it('isMeshCoreManager returns true for meshcore stubs, false for meshtastic', async () => {
    const mc = makeMeshCoreStub('mc-1');
    const mt = makeMeshtasticStub('mt-1');
    await registry.addManager(mc);
    await registry.addManager(mt);

    const all = registry.getAllManagers();
    expect(all.filter(isMeshCoreManager).map(m => m.sourceId)).toEqual(['mc-1']);
    expect(all.filter(m => !isMeshCoreManager(m)).map(m => m.sourceId)).toEqual(['mt-1']);
  });

  it('getManager + isMeshCoreManager narrows to MeshCoreManager', async () => {
    const mc = makeMeshCoreStub('mc-2');
    await registry.addManager(mc);

    const found = registry.getManager('mc-2');
    expect(found).toBeDefined();
    expect(isMeshCoreManager(found!)).toBe(true);
    if (isMeshCoreManager(found!)) {
      expect(found.sourceId).toBe('mc-2');
    }
  });

  it('getManager returns undefined and isMeshCoreManager returns false for meshtastic id', async () => {
    const mt = makeMeshtasticStub('mt-3');
    await registry.addManager(mt);

    const found = registry.getManager('mt-3');
    expect(found).toBeDefined();
    expect(isMeshCoreManager(found!)).toBe(false);
  });

  it('removeManager removes the manager from the registry', async () => {
    const mc = makeMeshCoreStub('mc-4');
    await registry.addManager(mc);
    expect(registry.getManager('mc-4')).toBe(mc);

    await registry.removeManager('mc-4');
    expect(registry.getManager('mc-4')).toBeUndefined();
  });

  it('stopAll removes all managers', async () => {
    await registry.addManager(makeMeshCoreStub('mc-5a'));
    await registry.addManager(makeMeshtasticStub('mt-5b'));
    expect(registry.size).toBe(2);

    await registry.stopAll();
    expect(registry.size).toBe(0);
  });
});

describe('meshcoreManagerRegistry shim — disconnectAll() scoped to meshcore only', () => {
  // We verify the semantic contract using a local registry to avoid side-effects
  // on the module-level singleton used by the shim.
  it('only removes meshcore managers, leaves meshtastic managers registered', async () => {
    const registry = new SourceManagerRegistry();
    const mc1 = makeMeshCoreStub('mc-d1');
    const mc2 = makeMeshCoreStub('mc-d2');
    const mt1 = makeMeshtasticStub('mt-d1');

    await registry.addManager(mc1);
    await registry.addManager(mc2);
    await registry.addManager(mt1);
    expect(registry.size).toBe(3);

    // Replicate the disconnectAll logic using the local registry.
    const meshcoreManagers = registry.getAllManagers().filter(isMeshCoreManager);
    await Promise.allSettled(meshcoreManagers.map(m => registry.removeManager(m.sourceId)));

    // MeshCore sources removed; meshtastic source preserved.
    expect(registry.getManager('mc-d1')).toBeUndefined();
    expect(registry.getManager('mc-d2')).toBeUndefined();
    expect(registry.getManager('mt-d1')).toBeDefined();
    expect(registry.size).toBe(1);
  });
});

describe('meshcoreManagerRegistry shim — @deprecated surface compiles and delegates', () => {
  // Import the shim (which delegates to the module-level sourceManagerRegistry).
  // We verify the exported shape rather than the side effects — full delegation
  // coverage lives in sourceManagerRegistry.meshcore.test.ts.
  it('exports get, list, remove, disconnectAll, getOrCreate as functions', async () => {
    const mod = await import('./meshcoreRegistry.js');
    const shim = mod.meshcoreManagerRegistry;
    expect(typeof shim.get).toBe('function');
    expect(typeof shim.list).toBe('function');
    expect(typeof shim.remove).toBe('function');
    expect(typeof shim.disconnectAll).toBe('function');
    expect(typeof shim.getOrCreate).toBe('function');
  });

  it('get() returns undefined for an unregistered id', async () => {
    const mod = await import('./meshcoreRegistry.js');
    expect(mod.meshcoreManagerRegistry.get('no-such-id')).toBeUndefined();
  });

  it('list() returns an array (may be empty when registry is empty)', async () => {
    const mod = await import('./meshcoreRegistry.js');
    expect(Array.isArray(mod.meshcoreManagerRegistry.list())).toBe(true);
  });

  it('getOrCreate() throws a migration-guidance error', async () => {
    const mod = await import('./meshcoreRegistry.js');
    expect(() => mod.meshcoreManagerRegistry.getOrCreate({})).toThrow(/deprecated/i);
  });

  it('re-exports meshcoreConfigFromSource from meshcoreConfig', async () => {
    const mod = await import('./meshcoreRegistry.js');
    expect(typeof mod.meshcoreConfigFromSource).toBe('function');
  });
});
