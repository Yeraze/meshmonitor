/**
 * Unit tests for sourceManagerTypes.ts — type-guard predicates.
 * Tests the truth table over all 4 sourceTypes to ensure the guards
 * partition managers correctly.
 *
 * Also covers SourceManagerRegistry primary-designation lifecycle (FIX 2):
 *  - removeManager clears the primary designation when the primary is removed.
 *  - Re-designation is accepted after the designation is cleared.
 *  - Fallback scan covers the interim window between remove and re-designation.
 */
import { describe, it, expect, vi } from 'vitest';
import { isMeshCoreManager, isMeshtasticManager, getPrimaryMeshtasticManager } from './sourceManagerTypes.js';
import { SourceManagerRegistry } from './sourceManagerRegistry.js';
import type { ISourceManager } from './sourceManagerRegistry.js';

/**
 * Minimal stub of an ISourceManager for testing guard predicates.
 * Only sourceType is needed; other fields are stubs.
 */
function makeStub(sourceType: ISourceManager['sourceType']): ISourceManager {
  return {
    sourceId: 'test-id',
    sourceType,
    start: async () => {},
    stop: async () => {},
    getStatus: () => ({
      sourceId: 'test-id',
      sourceName: 'test',
      sourceType,
      connected: false,
    }),
    getLocalNodeInfo: () => null,
    startDistanceDeleteScheduler: async () => {},
    stopDistanceDeleteScheduler: () => {},
  };
}

describe('isMeshCoreManager', () => {
  it('returns true for sourceType === meshcore', () => {
    expect(isMeshCoreManager(makeStub('meshcore'))).toBe(true);
  });

  it('returns false for sourceType === meshtastic_tcp', () => {
    expect(isMeshCoreManager(makeStub('meshtastic_tcp'))).toBe(false);
  });

  it('returns false for sourceType === mqtt_broker', () => {
    expect(isMeshCoreManager(makeStub('mqtt_broker'))).toBe(false);
  });

  it('returns false for sourceType === mqtt_bridge', () => {
    expect(isMeshCoreManager(makeStub('mqtt_bridge'))).toBe(false);
  });
});

describe('isMeshtasticManager', () => {
  it('returns true for sourceType === meshtastic_tcp', () => {
    expect(isMeshtasticManager(makeStub('meshtastic_tcp'))).toBe(true);
  });

  it('returns false for sourceType === meshcore', () => {
    expect(isMeshtasticManager(makeStub('meshcore'))).toBe(false);
  });

  it('returns false for sourceType === mqtt_broker', () => {
    expect(isMeshtasticManager(makeStub('mqtt_broker'))).toBe(false);
  });

  it('returns false for sourceType === mqtt_bridge', () => {
    expect(isMeshtasticManager(makeStub('mqtt_bridge'))).toBe(false);
  });
});

describe('guard partitioning', () => {
  it('isMeshCoreManager and isMeshtasticManager are mutually exclusive', () => {
    const types: ISourceManager['sourceType'][] = ['meshcore', 'meshtastic_tcp', 'mqtt_broker', 'mqtt_bridge'];
    for (const t of types) {
      const stub = makeStub(t);
      const isMC = isMeshCoreManager(stub);
      const isMT = isMeshtasticManager(stub);
      expect(isMC && isMT).toBe(false);
    }
  });

  it('exactly one of meshcore/meshtastic types is identified by its guard', () => {
    expect(isMeshCoreManager(makeStub('meshcore')) || isMeshtasticManager(makeStub('meshcore'))).toBe(true);
    expect(isMeshCoreManager(makeStub('meshtastic_tcp')) || isMeshtasticManager(makeStub('meshtastic_tcp'))).toBe(true);
  });

  it('mqtt types are not identified by either guard', () => {
    expect(isMeshCoreManager(makeStub('mqtt_broker')) || isMeshtasticManager(makeStub('mqtt_broker'))).toBe(false);
    expect(isMeshCoreManager(makeStub('mqtt_bridge')) || isMeshtasticManager(makeStub('mqtt_bridge'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SourceManagerRegistry — primary designation lifecycle (FIX 2)
// Verifies that removeManager clears the designation so transport-change
// (remove + add same id) and re-designation after a clear both work correctly.
// ---------------------------------------------------------------------------

/**
 * Build a minimal meshtastic_tcp ISourceManager stub suitable for
 * addManager() (which calls start()).
 */
function makeTcpStub(sourceId: string): ISourceManager {
  return {
    sourceId,
    sourceType: 'meshtastic_tcp',
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getStatus: () => ({ sourceId, sourceName: sourceId, sourceType: 'meshtastic_tcp', connected: false }),
    getLocalNodeInfo: () => null,
    startDistanceDeleteScheduler: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stopDistanceDeleteScheduler: vi.fn<() => void>(),
  };
}

describe('SourceManagerRegistry — primary designation lifecycle', () => {
  it('removeManager clears primaryMeshtasticSourceId when the designated primary is removed', async () => {
    const reg = new SourceManagerRegistry();
    const stub = makeTcpStub('tcp-1');
    await reg.addManager(stub);
    reg.setPrimaryMeshtasticSource('tcp-1');
    expect(reg.getPrimaryMeshtasticSourceId()).toBe('tcp-1');

    await reg.removeManager('tcp-1');
    expect(reg.getPrimaryMeshtasticSourceId()).toBeNull();
  });

  it('removeManager of a non-primary source does NOT clear the designation', async () => {
    const reg = new SourceManagerRegistry();
    const stub1 = makeTcpStub('tcp-1');
    const stub2 = makeTcpStub('tcp-2');
    await reg.addManager(stub1);
    await reg.addManager(stub2);
    reg.setPrimaryMeshtasticSource('tcp-1');

    await reg.removeManager('tcp-2');
    expect(reg.getPrimaryMeshtasticSourceId()).toBe('tcp-1'); // unchanged
  });

  it('re-designation is accepted after the primary designation is cleared', async () => {
    const reg = new SourceManagerRegistry();
    const stub1 = makeTcpStub('tcp-1');
    const stub2 = makeTcpStub('tcp-2');
    await reg.addManager(stub1);
    reg.setPrimaryMeshtasticSource('tcp-1');
    await reg.removeManager('tcp-1');
    expect(reg.getPrimaryMeshtasticSourceId()).toBeNull();

    // After the clear, a new designation must be accepted (null check passes).
    await reg.addManager(stub2);
    reg.setPrimaryMeshtasticSource('tcp-2');
    expect(reg.getPrimaryMeshtasticSourceId()).toBe('tcp-2');
  });

  it('getPrimaryMeshtasticManager falls back to insertion-order scan during the interim after a primary is removed', async () => {
    const reg = new SourceManagerRegistry();
    const stub1 = makeTcpStub('tcp-1');
    const stub2 = makeTcpStub('tcp-2');
    await reg.addManager(stub1);
    await reg.addManager(stub2);
    reg.setPrimaryMeshtasticSource('tcp-1');

    // Remove the designated primary; stub2 is still in the registry.
    await reg.removeManager('tcp-1');
    expect(reg.getPrimaryMeshtasticSourceId()).toBeNull();

    // Fallback: getPrimaryMeshtasticManager returns the first tcp in insertion order.
    expect(getPrimaryMeshtasticManager(reg)).toBe(stub2);
  });
});
