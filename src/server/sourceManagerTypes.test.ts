/**
 * Unit tests for sourceManagerTypes.ts — type-guard predicates.
 * Tests the truth table over all 4 sourceTypes to ensure the guards
 * partition managers correctly.
 */
import { describe, it, expect } from 'vitest';
import { isMeshCoreManager, isMeshtasticManager } from './sourceManagerTypes.js';
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
